/* TheraChart clinical insights — decision SUPPORT for a licensed PT (never a
   diagnosis or directive). Looks at the current visit's findings PLUS the
   patient's history to surface (1) possible connections/patterns, (2) red
   flags, and (3) concrete recommendations for this visit.

   Two paths, same output shape:
   - buildInsights(ctx): a local heuristic (no network, no key) — the fallback
   - Gemini: insightsPrompt(ctx) + INSIGHTS_SCHEMA drive the model server-side

   ctx = {
     patient: { age, sex },
     referral: "…",              // reason for referral / referring dx
     pmh: "…",                   // past medical history
     current: { subjective, findings: [{part, side, summary}], measurements },
     history: [ { date, type, subjective, assessment,
                  findings: [{part, side, summary}], measurements } ]
   }
   measurements = { rom:[{side,joint,motion,degrees}], mmt:[], special:[], pain:[{location,score}] }
*/

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TheraInsights = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const regionOf = (f) => `${f.side ? f.side + " " : ""}${f.part}`.toLowerCase().trim();
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  function buildInsights(ctx) {
    ctx = ctx || {};
    const current = ctx.current || { findings: [], measurements: {} };
    const history = Array.isArray(ctx.history) ? ctx.history : [];
    const connections = [];
    const redFlags = [];
    const recommendations = [];

    const curFindings = current.findings || [];
    const curRegions = new Set(curFindings.map(regionOf));

    /* 1) Recurrence across visits */
    const regionCount = {};
    for (const doc of history) for (const f of doc.findings || []) {
      const r = regionOf(f);
      regionCount[r] = (regionCount[r] || 0) + 1;
    }
    for (const r of curRegions) {
      if (regionCount[r]) {
        connections.push({
          title: `Recurrent ${r}`,
          detail: `${cap(r)} appears in the current visit and in ${regionCount[r]} prior note${regionCount[r] > 1 ? "s" : ""} — this looks like an ongoing rather than a new problem.`,
          confidence: regionCount[r] >= 2 ? "high" : "medium",
          basis: "same region documented across visits",
        });
      }
    }

    /* 2) ROM trend for a joint/motion measured across visits */
    const romSeries = {};
    const pushRom = (m, when) => {
      for (const r of (m && m.rom) || []) {
        const k = `${r.side || ""} ${r.joint} ${r.motion}`.trim();
        (romSeries[k] = romSeries[k] || []).push({ deg: r.degrees, when });
      }
    };
    history.forEach((d) => pushRom(d.measurements, d.date || ""));
    pushRom(current.measurements, "now");
    for (const k in romSeries) {
      const s = romSeries[k];
      if (s.length >= 2) {
        const delta = s[s.length - 1].deg - s[0].deg;
        if (Math.abs(delta) >= 5) {
          const better = delta > 0;
          connections.push({
            title: `${better ? "Improving" : "Declining"} ${k} ROM`,
            detail: `${cap(k)} moved from ${s[0].deg}° to ${s[s.length - 1].deg}° (${delta > 0 ? "+" : ""}${delta}°) across visits.`,
            confidence: "high",
            basis: "range-of-motion measurements over time",
          });
          if (!better) redFlags.push({ flag: `${cap(k)} ROM is going down`, action: "Reassess for a plateau or regression; review the plan and adherence." });
          recommendations.push({
            action: better ? `Progress ${k} loading/HEP as tolerated` : `Re-examine ${k}; consider adjusting technique or referral`,
            rationale: `ROM trend is ${better ? "positive" : "negative"}.`,
            priority: better ? "routine" : "high",
          });
        }
      }
    }

    /* 3) Pain trend */
    const painSeries = [];
    history.forEach((d) => (d.measurements?.pain || []).forEach((p) => painSeries.push(p.score)));
    (current.measurements?.pain || []).forEach((p) => painSeries.push(p.score));
    if (painSeries.length >= 2) {
      const d = painSeries[painSeries.length - 1] - painSeries[0];
      if (Math.abs(d) >= 2) {
        connections.push({
          title: `Pain ${d < 0 ? "decreasing" : "increasing"}`,
          detail: `Reported pain has gone from ${painSeries[0]}/10 to ${painSeries[painSeries.length - 1]}/10.`,
          confidence: "medium", basis: "pain ratings over time",
        });
        if (d > 0) redFlags.push({ flag: "Pain is trending up", action: "Screen for aggravating factors and red flags; consider medical review if unremitting." });
      }
    }

    /* 4) Radicular / referred pattern in the current visit */
    const hasLowBack = [...curRegions].some((r) => /lower back|back|lumbar|buttock/.test(r));
    const hasLeg = [...curRegions].some((r) => /leg|thigh|calf|foot|hamstring|knee/.test(r));
    const hasNeck = [...curRegions].some((r) => /neck/.test(r));
    const hasArm = [...curRegions].some((r) => /arm|hand|finger|elbow|forearm|wrist/.test(r));
    const cursum = curFindings.map((f) => f.summary || "").join(" ").toLowerCase();
    if (hasLowBack && hasLeg) {
      connections.push({ title: "Possible lumbar radicular pattern", detail: "Low-back involvement with lower-limb symptoms can indicate a radicular/referred source rather than two separate problems.", confidence: "medium", basis: "co-located low back + leg findings" });
      recommendations.push({ action: "Add a neuro/radicular screen (SLR, dermatome/myotome, reflexes)", rationale: "Rule in/out lumbar radiculopathy.", priority: "high" });
    }
    if (hasNeck && hasArm) {
      connections.push({ title: "Possible cervical radicular pattern", detail: "Neck involvement with arm/hand symptoms may point to a cervical source.", confidence: "medium", basis: "co-located neck + arm findings" });
      recommendations.push({ action: "Add an upper-limb neuro screen (Spurling's, dermatome/myotome)", rationale: "Rule in/out cervical radiculopathy.", priority: "high" });
    }
    if (/numb|tingl/.test(cursum) && /weak/.test(cursum)) {
      redFlags.push({ flag: "Numbness/tingling with weakness reported", action: "Perform a neurological screen; escalate to the physician if progressive." });
    }

    /* 5) PMH / referral links */
    const pmh = (ctx.pmh || "").toLowerCase();
    if (/diabet/.test(pmh)) {
      connections.push({ title: "Diabetes on file", detail: "Diabetes can contribute to peripheral neuropathy and slower tissue healing.", confidence: "medium", basis: "past medical history" });
      recommendations.push({ action: "Screen distal sensation and skin integrity; set realistic healing timelines", rationale: "Diabetes affects nerve function and recovery.", priority: "routine" });
    }
    if (/hypertens|cardiac|heart/.test(pmh)) {
      recommendations.push({ action: "Monitor vitals with exertion", rationale: "Cardiovascular history on file.", priority: "routine" });
    }
    const ref = (ctx.referral || "").toLowerCase();
    for (const f of curFindings) {
      const part = (f.part || "").toLowerCase();
      if (part && ref.includes(part)) {
        connections.push({ title: `Consistent with referral (${f.part})`, detail: `Current ${part} findings line up with the referring reason.`, confidence: "high", basis: "referral reason" });
        break;
      }
    }

    /* 6) Baseline recommendations if the visit produced findings */
    if (curFindings.length) {
      recommendations.push({ action: "Document objective baselines (ROM, MMT, pain) for each active region", rationale: "Enables tracking of progress over the plan of care.", priority: "routine" });
      if (!history.length) recommendations.push({ action: "Establish measurable short- and long-term goals", rationale: "First documented visit for these findings.", priority: "routine" });
    }

    // de-duplicate recommendations by action text
    const seen = new Set();
    const recs = recommendations.filter((r) => { const k = r.action.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });

    return { connections, redFlags, recommendations: recs, source: "local" };
  }

  const INSIGHTS_SCHEMA = {
    type: "object",
    properties: {
      connections: { type: "array", items: { type: "object", properties: {
        title: { type: "string" }, detail: { type: "string" },
        confidence: { type: "string", enum: ["low", "medium", "high"] }, basis: { type: "string" },
      }, required: ["title", "detail"] } },
      redFlags: { type: "array", items: { type: "object", properties: {
        flag: { type: "string" }, action: { type: "string" },
      }, required: ["flag"] } },
      recommendations: { type: "array", items: { type: "object", properties: {
        action: { type: "string" }, rationale: { type: "string" },
        priority: { type: "string", enum: ["urgent", "high", "routine"] },
      }, required: ["action"] } },
    },
    required: ["connections", "recommendations"],
  };

  function insightsSystem() {
    return [
      "You are an experienced physical therapist reviewing a patient's chart to",
      "support clinical reasoning. This is decision SUPPORT for a licensed PT —",
      "NOT a diagnosis, and NOT a directive. Be conservative and evidence-based:",
      "use ONLY what is in the chart provided; never fabricate history or numbers.",
      "",
      "Given the CURRENT visit findings and the patient's HISTORY, produce:",
      "",
      "1) CONNECTIONS — clinically plausible relationships or patterns linking the",
      "   current complaint to the history: recurrence of a region, compensation",
      "   patterns, trends in ROM/strength/pain over visits, referred/radicular",
      "   patterns, and links to past medical history, prior injuries, or the",
      "   referral reason. For each: a short title, the detail, a confidence",
      "   (low/medium/high), and the basis (what in the chart supports it).",
      "",
      "2) RED FLAGS — anything warranting caution or medical referral (progressive",
      "   neuro deficits, unremitting or worsening pain, systemic signs). Each with",
      "   the recommended action. Omit if none.",
      "",
      "3) RECOMMENDATIONS — concrete, appropriate next steps for THIS visit:",
      "   objective assessments to perform, treatment considerations, precautions,",
      "   patient education, or referral if indicated. Each with a brief rationale",
      "   and a priority (urgent/high/routine).",
      "",
      "Keep it specific to this chart. Return ONLY JSON matching the schema.",
    ].join("\n");
  }

  function fmtMeas(m) {
    if (!m) return "";
    const parts = [];
    (m.rom || []).forEach((r) => parts.push(`ROM ${r.side || ""} ${r.joint} ${r.motion} ${r.degrees}°`));
    (m.mmt || []).forEach((r) => parts.push(`MMT ${r.context || ""} ${r.grade}`));
    (m.special || []).forEach((r) => parts.push(`${r.name}: ${r.result}`));
    (m.pain || []).forEach((r) => parts.push(`Pain ${r.location || ""} ${r.score}/10`));
    return parts.join("; ");
  }

  function insightsPrompt(ctx) {
    const c = ctx || {};
    const lines = [insightsSystem(), "", "PATIENT CHART", "============="];
    if (c.patient) lines.push(`Patient: ${c.patient.age || "?"}y ${c.patient.sex || ""}`.trim());
    if (c.referral) lines.push(`Referral / reason: ${c.referral}`);
    if (c.pmh) lines.push(`Past medical history: ${c.pmh}`);
    lines.push("", "CURRENT VISIT", "-------------");
    if (c.current?.subjective) lines.push(`Subjective: ${c.current.subjective}`);
    (c.current?.findings || []).forEach((f) => lines.push(`Finding: ${regionOf(f)} — ${f.summary || ""}`));
    const cm = fmtMeas(c.current?.measurements);
    if (cm) lines.push(`Measurements: ${cm}`);
    lines.push("", "HISTORY (most recent first)", "---------------------------");
    (c.history || []).forEach((d, i) => {
      lines.push(`[${i + 1}] ${d.date || ""} ${d.type || "note"}`);
      if (d.subjective) lines.push(`  Subjective: ${d.subjective}`);
      (d.findings || []).forEach((f) => lines.push(`  Finding: ${regionOf(f)} — ${f.summary || ""}`));
      const hm = fmtMeas(d.measurements);
      if (hm) lines.push(`  Measurements: ${hm}`);
      if (d.assessment) lines.push(`  Assessment: ${d.assessment}`);
    });
    if (!(c.history || []).length) lines.push("(no prior documents on file)");
    return lines.join("\n");
  }

  return { buildInsights, insightsPrompt, insightsSystem, INSIGHTS_SCHEMA };
});
