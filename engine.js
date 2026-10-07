// engine.js
// Decision-rights rule engine for the CircuitYield governance agent.
// The AI model extracts facts from a transcript (api/review.js). This file
// applies our approval policy to those facts. It is plain code, so the same
// facts always produce the same decision.

(function (root) {
  var POLICY = {
    TIER1_MAX: 100000,          // up to ₹1,00,000: agent may commit
    TIER2_MAX: 500000,          // up to ₹5,00,000: Procurement Manager approves
    NEAR_LIMIT_SHARE: 0.10,     // within 10% below a limit is flagged
    PRICE_DATA_DATE: "2026-09-04",
    PRICE_DATA_LABEL: "3 to 4 September 2026",
    PRICE_DATA_MAX_AGE_DAYS: 30,
  };

  function inr(n) { return "₹" + Math.round(n).toLocaleString("en-IN"); }

  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[‘’“”"'`]/g, "")
      .replace(/[₹,.:;!?()]/g, " ")
      .replace(/\b(rs|inr)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Is the quote the model gave actually in the transcript?
  function checkQuote(quote, transcript) {
    if (!quote) return "none";
    return norm(transcript).indexOf(norm(quote)) !== -1 ? "found" : "not_found";
  }

  function tierFor(value) {
    if (value <= POLICY.TIER1_MAX) return 1;
    if (value <= POLICY.TIER2_MAX) return 2;
    return 3;
  }
  var APPROVER = { 1: "AI Procurement Agent", 2: "Procurement Manager", 3: "Head of Procurement" };
  var OWNER = { 1: "Procurement Manager", 2: "Procurement Manager", 3: "Head of Procurement" };

  function daysBetween(isoA, dateB) {
    var a = new Date(isoA + "T00:00:00Z").getTime();
    var b = Date.UTC(dateB.getUTCFullYear(), dateB.getUTCMonth(), dateB.getUTCDate());
    return Math.floor((b - a) / 86400000);
  }

  var ISSUE_MAP = {
    authority_claim: { key: "manipulation", sev: "High", text: "The vendor claimed special authority. The agent must not grant extra access; a person should review the chat." },
    instruction_override: { key: "manipulation", sev: "High", text: "The vendor tried to make the agent ignore its instructions. A person should review the chat." },
    internal_figures_request: { key: "figures_request", sev: "Medium", text: "The vendor pressed for internal figures such as the ceiling price or margin." },
    internal_figures_disclosed: { key: "disclosure", sev: "Critical", text: "The agent may have revealed or hinted at internal figures. Pause the agent and review." },
    inconsistent_numbers: { key: "inconsistent", sev: "High", text: "The transcript gives conflicting numbers for the lot. Confirm the correct figure with the vendor." },
    pressure: { key: "pressure", sev: "Low", text: "The vendor applied pressure. The price should not change because of it." },
    other: { key: "other_issue", sev: "Medium", text: "Other issue noted by the reviewer." },
  };

  function evaluate(ex, transcript, today) {
    today = today || new Date();
    ex = ex || {};
    var gaps = [];
    var rules = [];
    var addGap = function (key, sev, text, quote) {
      gaps.push({ key: key, sev: sev, text: text, quote: quote || null });
    };

    // ---- 1. Facts and evidence ----
    var facts = [
      { label: "Board type", value: ex.board_type || null, shown: ex.board_type || "Not stated", quote: ex.board_type_quote },
      { label: "Lot weight", value: num(ex.lot_weight_kg), shown: num(ex.lot_weight_kg) != null ? num(ex.lot_weight_kg).toLocaleString("en-IN") + " kg" : "Not stated", quote: ex.lot_weight_quote },
      { label: "Final price", value: num(ex.final_price_per_kg_inr), shown: num(ex.final_price_per_kg_inr) != null ? inr(num(ex.final_price_per_kg_inr)) + " per kg" : "Not stated", quote: ex.final_price_quote },
      { label: "Outcome", value: ex.outcome, shown: OUTCOME_LABEL[ex.outcome] || "Unclear", quote: ex.outcome_quote },
      { label: "Agent confirmed the deal", value: !!ex.agent_confirmed_deal, shown: ex.agent_confirmed_deal ? "Yes" : "No", quote: ex.agent_confirmed_quote },
      { label: "Agent said approval needed", value: !!ex.agent_mentioned_approval, shown: ex.agent_mentioned_approval ? "Yes" : "No", quote: null },
    ];
    facts.forEach(function (f) { f.evidence = checkQuote(f.quote, transcript); });

    var weight = num(ex.lot_weight_kg);
    var price = num(ex.final_price_per_kg_inr);

    facts.slice(0, 3).forEach(function (f) {
      if (f.value != null && f.evidence === "not_found") {
        addGap("unverified_" + f.label.toLowerCase().replace(/\s+/g, "_"), "High",
          f.label + ": the quoted evidence was not found in the transcript. Confirm this figure manually before acting.");
      }
    });
    if (!ex.board_type) addGap("missing_board", "Medium", "Board type is not stated, so the lot cannot be matched to a price category.");
    if (weight == null) addGap("missing_weight", "High", "Lot weight is not stated, so the lot value and approval tier cannot be worked out.");
    if (price == null) addGap("missing_price", "High", "Final price per kg is not stated, so the lot value and approval tier cannot be worked out.");

    // ---- 2. Method ----
    var value = weight != null && price != null ? weight * price : null;
    var tier = value != null ? tierFor(value) : null;
    if (value != null) {
      rules.push("Lot value = " + weight.toLocaleString("en-IN") + " kg × " + inr(price) + " per kg = " + inr(value) + ".");
      rules.push(tier === 1
        ? "Tier 1 (up to ₹1,00,000): the AI agent may commit the price. The Procurement Manager reviews afterwards."
        : tier === 2
        ? "Tier 2 (₹1,00,001 to ₹5,00,000): the AI agent may only recommend. The Procurement Manager approves before commitment."
        : "Tier 3 (above ₹5,00,000): the AI agent may only recommend. The Head of Procurement approves before commitment.");
      [POLICY.TIER1_MAX, POLICY.TIER2_MAX].forEach(function (limit) {
        if (value <= limit && value > limit * (1 - POLICY.NEAR_LIMIT_SHARE)) {
          addGap("near_limit", "Medium", "Lot value " + inr(value) + " is within 10% of the " + inr(limit) + " limit. Confirm the weight and price, since a small change moves it to the next tier.");
        }
      });
    } else {
      rules.push("Lot value could not be calculated, so no approval tier applies yet.");
    }

    var age = daysBetween(POLICY.PRICE_DATA_DATE, today);
    rules.push("Pricing data is checked against a maximum age of " + POLICY.PRICE_DATA_MAX_AGE_DAYS + " days.");
    if (age > POLICY.PRICE_DATA_MAX_AGE_DAYS) {
      addGap("price_data_age", "Medium", "The pricing data is from " + POLICY.PRICE_DATA_LABEL + ", " + age + " days old. The Procurement Manager should refresh it before more deals close.");
    }

    (ex.issues || []).forEach(function (i) {
      var m = ISSUE_MAP[i.type] || ISSUE_MAP.other;
      addGap(m.key, m.sev, m.text + (i.detail ? " (" + i.detail + ")" : ""), i.quote || null);
    });
    (ex.unclear_points || []).forEach(function (u) { addGap("unclear", "Low", u); });

    // ---- 3. Decision ----
    var disclosed = (ex.issues || []).some(function (i) { return i.type === "internal_figures_disclosed"; });
    var outcome = ex.outcome || "unclear";
    var status, tone, headline, sub, steps = [];
    var approver = tier ? APPROVER[tier] : null;
    var owner = tier ? OWNER[tier] : "Procurement Manager";

    rules.push(OUTCOME_RULE[outcome] || OUTCOME_RULE.unclear);

    if (disclosed) {
      status = "pause"; tone = "r";
      headline = "Pause the agent";
      sub = "The agent may have revealed internal figures. The Stop right applies.";
      steps.push("Procurement Manager pauses the AI agent now.");
      steps.push("Head of Procurement reviews the chat and decides when the agent may restart.");
      if (outcome === "agreed") steps.push("Hold this deal until the review is complete.");
      owner = "Head of Procurement";
    } else if (outcome === "agreed") {
      if (tier == null) {
        status = "cannot_classify"; tone = "a";
        headline = "Hold: approval tier unknown";
        sub = "A deal was agreed, but the lot value cannot be worked out from the chat.";
        steps.push("Procurement Manager confirms the missing figures with the vendor.");
        steps.push("Re-run this review once the figures are confirmed.");
      } else if (tier === 1) {
        status = "within_authority"; tone = "g";
        headline = "Within the agent's authority";
        sub = "The agent may commit this deal. The Procurement Manager reviews it afterwards.";
        steps.push("Proceed with the deal.");
        steps.push("Add it to the Procurement Manager's review list.");
      } else if (ex.agent_confirmed_deal && !ex.agent_mentioned_approval) {
        status = "authority_exceeded"; tone = "r";
        headline = "Authority exceeded: hold this deal";
        sub = "The agent confirmed a " + inr(value) + " deal. Deals in Tier " + tier + " need " + approver + " approval first.";
        steps.push("Hold the deal. Do not release payment or pickup yet.");
        steps.push(approver + " approves, revises or rejects the price.");
        steps.push("Tell the vendor the price is subject to approval.");
        steps.push("Log this as an authority breach for the Head of Procurement to review.");
        owner = "Head of Procurement";
      } else {
        status = "approval_required"; tone = "a";
        headline = approver + " approval required";
        sub = "The agent correctly treated the price as a recommendation. It is not committed until approved.";
        steps.push(approver + " approves, revises or rejects the recommended price.");
        steps.push("The vendor is told the outcome.");
      }
    } else if (outcome === "final_offer_rejected") {
      status = "handoff"; tone = "a";
      headline = "Hand off to a human buyer";
      sub = "The vendor rejected the final offer. The agent must not reopen this lot.";
      steps.push("A human buyer contacts the vendor.");
      steps.push("Any new price is approved at the right tier" + (approver ? " (" + (tier === 1 ? "Procurement Manager" : approver) + ")." : "."));
    } else if (outcome === "dispute") {
      status = "dispute_review"; tone = "a";
      headline = "Procurement Manager reviews the dispute";
      sub = "The agent may not renegotiate a closed deal.";
      steps.push("Procurement Manager checks the chat and the decision record.");
      steps.push((tier === 3 ? "Head of Procurement" : "Procurement Manager") + " decides any correction.");
    } else if (outcome === "in_progress") {
      status = "in_progress"; tone = "g";
      headline = "No commitment yet";
      sub = tier ? "Negotiation is ongoing. If agreed at this price, " + (tier === 1 ? "the agent may commit it." : approver + " must approve.") : "Negotiation is ongoing.";
      steps.push("The agent may keep negotiating within its price ceiling.");
      if (tier && tier > 1) steps.push("The agent must say the price is subject to approval before agreeing.");
    } else {
      status = "human_review"; tone = "a";
      headline = "Needs human review";
      sub = "The outcome of this chat is unclear.";
      steps.push("Procurement Manager reads the chat and records the outcome.");
    }

    if (gaps.some(function (g) { return g.key === "manipulation"; }) && status !== "pause") {
      steps.push("Procurement Manager reviews the manipulation attempt in the chat.");
    }

    var rights = {
      Recommend: "<b>AI Procurement Agent</b>, using prices from the pricing tool",
      Negotiate: "<b>AI Procurement Agent</b>, within the price ceiling",
      Approve: tier == null ? "<b>Procurement Manager</b> once the lot value is confirmed" : tier === 1 ? "<b>AI Procurement Agent</b> may commit (Tier 1)" : "<b>" + approver + "</b> (Tier " + tier + ")",
      Review: "<b>Procurement Manager</b> reviews the deal" + (tier === 3 || status === "authority_exceeded" ? "; <b>Head of Procurement</b> reviews limits" : ""),
      Stop: "<b>Procurement Manager</b> can pause the agent at any time",
    };
    if (status === "handoff") { rights.Negotiate = "<b>Human buyer</b> takes over this lot"; rights.Stop = "<b>AI agent</b> has stopped on this lot"; }
    if (status === "dispute_review") { rights.Negotiate = "<b>Procurement Manager</b> only; the agent stays out"; }
    if (status === "pause") {
      rights.Recommend = "<b>Paused</b>; open lots go to a human buyer";
      rights.Negotiate = "<b>Paused</b>; open lots go to a human buyer";
      rights.Stop = "<b>Procurement Manager</b> pauses now; <b>Head of Procurement</b> decides the restart";
    }

    var seen = {};
    gaps = gaps.filter(function (g) {
      if (g.key === "unclear") return true;
      if (seen[g.key]) return false;
      seen[g.key] = true;
      return true;
    });
    var sevOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    gaps.sort(function (a, b) { return sevOrder[a.sev] - sevOrder[b.sev]; });

    return {
      facts: facts, value: value, tier: tier, status: status, tone: tone,
      headline: headline, sub: sub, rules: rules, gaps: gaps, steps: steps, rights: rights,
      record: {
        lot: (ex.board_type || "Board type not stated") + (weight != null ? ", " + weight.toLocaleString("en-IN") + " kg" : "") + (price != null ? " at " + inr(price) + "/kg" : ""),
        value: value != null ? inr(value) + " (Tier " + tier + ")" : "Unknown",
        outcome: OUTCOME_LABEL[outcome] || "Unclear",
        status: STATUS_LABEL[status],
        decidedBy: status === "within_authority" ? "AI Procurement Agent" : status === "in_progress" ? "Not decided yet" : "Pending: " + (status === "pause" ? "Head of Procurement" : approver || "Procurement Manager"),
        owner: owner,
        reviewedBy: "AI governance agent (advisory). A person makes the decision.",
      },
    };
  }

  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : null;
  }

  var OUTCOME_LABEL = {
    agreed: "Price agreed",
    final_offer_rejected: "Final offer rejected",
    dispute: "Vendor disputes a closed deal",
    in_progress: "Still negotiating",
    unclear: "Unclear",
  };
  var OUTCOME_RULE = {
    agreed: "Outcome rule: an agreed price is checked against the approval tier.",
    final_offer_rejected: "Outcome rule: a final offer is final. If rejected, the lot goes to a human buyer.",
    dispute: "Outcome rule: disputes are a review decision and sit with the Procurement Manager.",
    in_progress: "Outcome rule: no price is committed while negotiation is ongoing.",
    unclear: "Outcome rule: if the outcome is unclear, a person decides.",
  };
  var STATUS_LABEL = {
    within_authority: "Within agent authority",
    approval_required: "Approval required",
    authority_exceeded: "Authority exceeded",
    handoff: "Hand off to human buyer",
    dispute_review: "Dispute under review",
    in_progress: "Still negotiating",
    cannot_classify: "Tier unknown",
    human_review: "Needs human review",
    pause: "Pause the agent",
  };

  var api = { POLICY: POLICY, evaluate: evaluate, checkQuote: checkQuote, STATUS_LABEL: STATUS_LABEL, inr: inr };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DREngine = api;
})(this);
