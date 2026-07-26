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
                  findings: [{part, side, summary}], measurements } ],
     historyDigest: buildHistoryDigest(olderVisits) | null
       // visits beyond the recent window, compressed (see below) so charts
       // with years of visits keep the context to about a page
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

  // A finding whose every note is a denial ("Denies pain") is documentation of
  // ABSENCE — it must not count as involvement of that region.
  const isDenial = (f) => {
    const parts = String((f && f.summary) || "").split(";").map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 && parts.every((s) => /^denies/i.test(s));
  };

  /* ---------------- history digest ----------------
     Compresses visits beyond the recent window (same {date,type,subjective,
     assessment,findings,measurements} shape) into a compact summary: date
     range, visit counts, recurring regions, ROM/pain endpoints, and key
     assessments. Keeps the AI context bounded when a chart holds years of
     visits (e.g. onboarded from scanned records). Returns null when there is
     nothing to digest. */
  function buildHistoryDigest(older) {
    older = (older || []).filter(Boolean);
    if (!older.length) return null;

    const dates = older.map((d) => d.date || "").filter(Boolean).sort();
    const types = {};
    older.forEach((d) => { const t = d.type || "note"; types[t] = (types[t] || 0) + 1; });

    // recurring regions across the older visits
    const regionMap = {};
    older.forEach((d) => (d.findings || []).forEach((f) => {
      if (isDenial(f)) return;
      const r = regionOf(f);
      const e = (regionMap[r] = regionMap[r] || { count: 0, last: "" });
      e.count++;
      if (f.summary) e.last = String(f.summary).slice(0, 120);
    }));
    const regions = Object.entries(regionMap)
      .sort((a, b) => b[1].count - a[1].count).slice(0, 6)
      .map(([region, e]) => ({ region, count: e.count, lastSummary: e.last }));

    // ROM endpoints per joint/motion (earliest → latest by date)
    const romMap = {};
    older.forEach((d) => (((d.measurements || {}).rom) || []).forEach((r) => {
      const k = `${r.side ? r.side + " " : ""}${r.joint} ${r.motion}`.trim();
      (romMap[k] = romMap[k] || []).push({ deg: r.degrees, when: d.date || "" });
    }));
    const romTrends = Object.entries(romMap)
      .filter(([, s]) => s.length >= 2).slice(0, 5)
      .map(([key, s]) => {
        const sorted = s.slice().sort((a, b) => (a.when < b.when ? -1 : 1));
        return { key, first: sorted[0].deg, last: sorted[sorted.length - 1].deg, n: s.length };
      });

    // pain endpoints (earliest and latest recorded rating)
    const painPts = [];
    older.forEach((d) => (((d.measurements || {}).pain) || []).forEach((p) => painPts.push({ score: p.score, when: d.date || "" })));
    painPts.sort((a, b) => (a.when < b.when ? -1 : 1));
    const pain = painPts.length ? { first: painPts[0].score, last: painPts[painPts.length - 1].score, n: painPts.length } : null;

    // key assessments: the earliest eval's, and the most recent one on file
    const byDateAsc = older.slice().sort((a, b) => ((a.date || "") < (b.date || "") ? -1 : 1));
    const firstEval = byDateAsc.find((d) => d.type === "eval" && d.assessment) || byDateAsc.find((d) => d.assessment);
    const lastNote = byDateAsc.slice().reverse().find((d) => d.assessment && d !== firstEval);
    const assessments = [];
    if (firstEval) assessments.push({ date: firstEval.date || "", text: String(firstEval.assessment).slice(0, 220) });
    if (lastNote) assessments.push({ date: lastNote.date || "", text: String(lastNote.assessment).slice(0, 220) });

    return {
      visits: older.length,
      from: dates[0] || "",
      to: dates[dates.length - 1] || "",
      types, regions, romTrends, pain, assessments,
    };
  }

  function buildInsights(ctx) {
    ctx = ctx || {};
    const current = ctx.current || { findings: [], measurements: {} };
    const history = Array.isArray(ctx.history) ? ctx.history : [];
    const connections = [];
    const redFlags = [];
    const recommendations = [];

    const curFindings = current.findings || [];
    const activeFindings = curFindings.filter((f) => !isDenial(f));
    const curRegions = new Set(activeFindings.map(regionOf));

    /* 1) Recurrence across visits (digest of older visits counts too) */
    const regionCount = {};
    for (const doc of history) for (const f of doc.findings || []) {
      if (isDenial(f)) continue;
      const r = regionOf(f);
      regionCount[r] = (regionCount[r] || 0) + 1;
    }
    const dg = ctx.historyDigest || null;
    if (dg) for (const r of dg.regions || []) {
      regionCount[r.region] = (regionCount[r.region] || 0) + r.count;
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

    /* 2) ROM trend for a joint/motion measured across visits.
       Digest endpoints seed the series so trends span the whole chart. */
    const romSeries = {};
    if (dg) for (const t of dg.romTrends || []) {
      romSeries[t.key] = [{ deg: t.first, when: dg.from }, { deg: t.last, when: dg.to }];
    }
    const pushRom = (m, when) => {
      for (const r of (m && m.rom) || []) {
        const k = `${r.side || ""} ${r.joint} ${r.motion}`.trim();
        (romSeries[k] = romSeries[k] || []).push({ deg: r.degrees, when });
      }
    };
    history.slice().reverse().forEach((d) => pushRom(d.measurements, d.date || "")); // oldest first
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

    /* 3) Pain trend — digest endpoints first (oldest), then history, then now.
       Ratings for DIFFERENT body regions never share a series: an old 8/10
       shoulder and a new 2/10 knee is not "pain decreasing". */
    const painPts = [];
    const pushPain = (score, loc) => {
      const s = Number(score);
      if (Number.isFinite(s)) painPts.push({ score: s, loc: String(loc || "").toLowerCase().trim() });
    };
    if (dg && dg.pain) { pushPain(dg.pain.first, ""); pushPain(dg.pain.last, ""); }
    history.slice().reverse().forEach((d) => (d.measurements?.pain || []).forEach((p) => pushPain(p.score, p.location)));
    (current.measurements?.pain || []).forEach((p) => pushPain(p.score, p.location));
    const painTrend = (pts, label) => {
      if (pts.length < 2) return;
      const d = pts[pts.length - 1].score - pts[0].score;
      if (Math.abs(d) < 2) return;
      const where = label ? ` (${label})` : "";
      connections.push({
        title: `Pain ${d < 0 ? "decreasing" : "increasing"}${where}`,
        detail: `Reported${label ? " " + label : ""} pain has gone from ${pts[0].score}/10 to ${pts[pts.length - 1].score}/10.`,
        confidence: "medium", basis: "pain ratings over time",
      });
      if (d > 0) redFlags.push({ flag: `Pain is trending up${where}`, action: "Screen for aggravating factors and red flags; consider medical review if unremitting." });
    };
    const painLocs = new Set(painPts.filter((p) => p.loc).map((p) => p.loc));
    if (painLocs.size > 1) {
      for (const l of painLocs) painTrend(painPts.filter((p) => p.loc === l), l);
    } else {
      painTrend(painPts, "");
    }

    /* 4) Radicular / referred pattern in the current visit */
    const hasLowBack = [...curRegions].some((r) => /lower back|back|lumbar|buttock/.test(r));
    const hasLeg = [...curRegions].some((r) => /leg|thigh|calf|foot|hamstring|knee/.test(r));
    const hasNeck = [...curRegions].some((r) => /neck/.test(r));
    const hasArm = [...curRegions].some((r) => /arm|hand|finger|elbow|forearm|wrist/.test(r));
    const cursum = activeFindings.map((f) => f.summary || "").join(" ").toLowerCase();
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

    /* 4b) Constitutional / serious-pathology screen.
       Night pain unrelieved by rest, unexplained weight loss, fever or night
       sweats, a cancer history, and cauda-equina symptoms are the classic
       musculoskeletal red flags — the cluster a PT is expected to catch and
       refer on rather than treat. They were absent here, so a chart could show
       "no red flags" while describing textbook ones in the subjective. Read
       the narrative too, not just the pinned findings: this is usually
       something the patient says rather than something pinned to a body part. */
    const narrative = [ctx.current && ctx.current.subjective, cursum, ctx.pmh, ctx.referral]
      .filter(Boolean).join(" ").toLowerCase();
    const CONSTITUTIONAL = [
      [/night pain|worse at night|pain at night|wakes? (?:me|him|her|them)?\s*(?:up\s*)?at night/, "Night pain"],
      [/unrelieved by rest|not (?:relieved|eased|helped) by rest|unremitting|constant deep pain/, "Pain unrelieved by rest"],
      [/(?:unintentional|unexplained|unintended)[^.]{0,20}weight loss|weight loss[^.]{0,20}(?:unintentional|unexplained)|lost \d+\s*(?:kg|kilo|pound|lb)/, "Unexplained weight loss"],
      [/\bfevers?\b|night sweats|\bchills\b/, "Fever or night sweats"],
      [/history of cancer|cancer history|previous malignan|malignancy|carcinoma/, "Cancer history on file"],
      [/saddle (?:an[a]?esthesia|numbness)|bowel (?:or|and) bladder|incontinen|urinary retention/, "Possible cauda equina symptoms"],
    ];
    const constitutional = CONSTITUTIONAL.filter(([re]) => re.test(narrative)).map(([, label]) => label);
    if (constitutional.length) {
      const several = constitutional.length >= 2;
      redFlags.push({
        flag: `${constitutional.join("; ")} — screen for non-musculoskeletal causes`,
        action: several
          ? "Several constitutional red flags together: refer to the physician for medical work-up before continuing treatment, and document what was found."
          : "Question further; consider medical referral if the presentation does not fit a mechanical pattern.",
      });
      recommendations.push({
        action: several ? "Refer to the referring physician for medical work-up" : "Raise the red-flag finding with the referring physician",
        rationale: `${constitutional.join("; ")} warrant medical screening, not treatment alone.`,
        priority: "high",
      });
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
    for (const f of activeFindings) {
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
    const dg = c.historyDigest;
    if (dg) {
      lines.push("", `EARLIER HISTORY — DIGEST of ${dg.visits} older visit${dg.visits === 1 ? "" : "s"} (${dg.from || "?"} → ${dg.to || "?"})`, "-".repeat(40));
      lines.push(`Visit types: ${Object.entries(dg.types || {}).map(([t, n]) => `${t} ×${n}`).join(", ")}`);
      (dg.regions || []).forEach((r) => lines.push(`Recurring region: ${r.region} (×${r.count})${r.lastSummary ? ` — last noted: ${r.lastSummary}` : ""}`));
      (dg.romTrends || []).forEach((t) => lines.push(`ROM over that period: ${t.key} ${t.first}° → ${t.last}° (${t.n} measurements)`));
      if (dg.pain) lines.push(`Pain over that period: ${dg.pain.first}/10 → ${dg.pain.last}/10 (${dg.pain.n} ratings)`);
      (dg.assessments || []).forEach((a) => lines.push(`Assessment ${a.date || ""}: ${a.text}`));
    }
    return lines.join("\n");
  }

  return { buildInsights, buildHistoryDigest, insightsPrompt, insightsSystem, INSIGHTS_SCHEMA };
});
