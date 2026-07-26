/* TheraChart clinical business rules — billing, goals, outcome measures.
   DOM-free like parser.js and insights.js, so the same logic runs in the
   browser and in the offline checker (node test/clinical.test.js).

   Three things a PT chart needs that a note body can't express:

   - BILLING. A visit is only a claim once the interventions carry CPT codes
     with minutes and units. Timed codes are converted to units by Medicare's
     8-minute rule; untimed ("service-based") codes bill one unit per visit
     however long they take. The rule is easy to get wrong by hand, so the app
     computes what the total *should* be and flags a mismatch rather than
     silently billing whatever was typed.

   - GOALS. Plan-of-care goals with a target date, so "progress toward goals"
     has something to measure against and an overdue goal can surface itself.

   - OUTCOME MEASURES. Standardised scores (LEFS, DASH, NPRS…) trended across
     the episode, compared against each tool's MCID so a change is reported as
     clinically meaningful or not — the evidence a payer asks for.

   Nothing here decides anything for the clinician; it computes and flags. */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TheraClinical = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ================================================================== *
   *  BILLING — CPT codes and the 8-minute rule
   * ================================================================== */

  /* The PT codes a clinic actually uses day to day. `timed` marks the
     15-minute constant-attendance codes the 8-minute rule applies to;
     untimed codes bill once per visit regardless of duration. */
  const CPT_CODES = [
    // --- evaluation / re-evaluation (untimed, one per visit) ---
    { code: "97161", desc: "PT evaluation — low complexity", timed: false, group: "Evaluation" },
    { code: "97162", desc: "PT evaluation — moderate complexity", timed: false, group: "Evaluation" },
    { code: "97163", desc: "PT evaluation — high complexity", timed: false, group: "Evaluation" },
    { code: "97164", desc: "PT re-evaluation", timed: false, group: "Evaluation" },
    // --- timed treatment ---
    { code: "97110", desc: "Therapeutic exercise", timed: true, group: "Treatment" },
    { code: "97112", desc: "Neuromuscular re-education", timed: true, group: "Treatment" },
    { code: "97116", desc: "Gait training", timed: true, group: "Treatment" },
    { code: "97140", desc: "Manual therapy", timed: true, group: "Treatment" },
    { code: "97530", desc: "Therapeutic activities", timed: true, group: "Treatment" },
    { code: "97535", desc: "Self-care / home management training", timed: true, group: "Treatment" },
    { code: "97542", desc: "Wheelchair management training", timed: true, group: "Treatment" },
    // --- timed modalities ---
    { code: "97032", desc: "Electrical stimulation (manual)", timed: true, group: "Modalities" },
    { code: "97033", desc: "Iontophoresis", timed: true, group: "Modalities" },
    { code: "97035", desc: "Ultrasound", timed: true, group: "Modalities" },
    // --- untimed / supervised modalities ---
    { code: "97010", desc: "Hot or cold packs", timed: false, group: "Modalities" },
    { code: "97012", desc: "Mechanical traction", timed: false, group: "Modalities" },
    { code: "97014", desc: "Electrical stimulation (unattended)", timed: false, group: "Modalities" },
    { code: "97016", desc: "Vasopneumatic device", timed: false, group: "Modalities" },
    { code: "97018", desc: "Paraffin bath", timed: false, group: "Modalities" },
    // --- untimed group ---
    { code: "97150", desc: "Group therapeutic procedure", timed: false, group: "Treatment" },
  ];

  const codeIndex = {};
  CPT_CODES.forEach((c) => { codeIndex[c.code] = c; });
  const findCode = (code) => codeIndex[String(code || "").trim()] || null;
  const isTimedCode = (code) => !!(findCode(code) || {}).timed;

  /** Medicare's 8-minute rule: total *timed* minutes across all timed codes
      determine how many units may be billed in total.
        ≥8–22 → 1,  23–37 → 2,  38–52 → 3,  53–67 → 4,  68–82 → 5, …
      Under 8 minutes of timed treatment, nothing timed is billable. */
  function unitsForMinutes(minutes) {
    const m = Number(minutes) || 0;
    if (m < 8) return 0;
    return Math.floor((m - 8) / 15) + 1;
  }

  /** The minute range that would justify exactly `units` units — used to tell
      a clinician how far they are from the next unit. */
  function minutesForUnits(units) {
    const u = Number(units) || 0;
    if (u <= 0) return { min: 0, max: 7 };
    return { min: 8 + (u - 1) * 15, max: 8 + u * 15 - 1 };
  }

  /**
   * Total up a visit's charges and check them against the 8-minute rule.
   * charges: [{ code, minutes, units }]
   * Returns totals plus `issues` — human-readable problems worth fixing
   * before the note is signed. Never mutates the input.
   */
  function billingSummary(charges) {
    const lines = (charges || []).filter((c) => c && c.code);
    let timedMinutes = 0, timedUnitsClaimed = 0, untimedUnits = 0;
    const issues = [];

    lines.forEach((c) => {
      const known = findCode(c.code);
      const units = Math.max(0, Number(c.units) || 0);
      const minutes = Math.max(0, Number(c.minutes) || 0);
      if (!known) {
        issues.push({ level: "warn", text: `${c.code} isn't a PT code this clinic bills — check it.` });
        untimedUnits += units;
        return;
      }
      if (known.timed) {
        timedMinutes += minutes;
        timedUnitsClaimed += units;
        if (!minutes) issues.push({ level: "warn", text: `${known.code} ${known.desc} is a timed code with no minutes recorded.` });
      } else {
        untimedUnits += units;
        if (units > 1) issues.push({ level: "warn", text: `${known.code} ${known.desc} is untimed — it bills one unit per visit, not ${units}.` });
      }
    });

    const timedUnitsAllowed = unitsForMinutes(timedMinutes);
    if (timedUnitsClaimed > timedUnitsAllowed) {
      issues.push({
        level: "bad",
        text: `${timedMinutes} timed minutes support ${timedUnitsAllowed} unit${timedUnitsAllowed === 1 ? "" : "s"}, but ${timedUnitsClaimed} are claimed.`,
      });
    } else if (timedUnitsClaimed < timedUnitsAllowed) {
      issues.push({
        level: "info",
        text: `${timedMinutes} timed minutes support ${timedUnitsAllowed} unit${timedUnitsAllowed === 1 ? "" : "s"} — only ${timedUnitsClaimed} claimed.`,
      });
    }
    // Just short of the next unit is the most common avoidable under-bill.
    const next = minutesForUnits(timedUnitsAllowed + 1);
    if (timedMinutes > 0 && next.min - timedMinutes > 0 && next.min - timedMinutes <= 3) {
      issues.push({ level: "info", text: `${next.min - timedMinutes} more timed minute${next.min - timedMinutes === 1 ? "" : "s"} would support another unit.` });
    }

    return {
      lines: lines.length,
      timedMinutes,
      timedUnitsClaimed,
      timedUnitsAllowed,
      untimedUnits,
      totalUnits: timedUnitsClaimed + untimedUnits,
      balanced: timedUnitsClaimed === timedUnitsAllowed,
      issues,
    };
  }

  /* Interventions a therapist dictates map onto the codes they're billed
     under, so the billing table can be pre-filled from the treatment text
     instead of typed from memory. Order matters: first match wins per code. */
  const CODE_HINTS = [
    ["97140", /\b(manual therapy|mobiliz\w*|manipulat\w*|soft tissue|massage|myofascial|trigger point|joint mob)\w*/i],
    ["97116", /\b(gait training|gait|ambulat\w*|walking (?:practice|training)|stair (?:training|negotiation))\b/i],
    ["97112", /\b(neuromusc\w*|propriocept\w*|balance (?:training|exercis\w*)|coordination|re-?education|vestibular)\b/i],
    ["97535", /\b(home (?:exercise )?program|hep|self-?care|adl training|home management|patient education)\b/i],
    ["97530", /\b(therapeutic activit\w*|functional (?:activit\w*|training)|lifting|carrying|squat to stand|transfers?)\b/i],
    ["97110", /\b(therex|therapeutic exercis\w*|exercis\w*|stretch\w*|strengthen\w*|isometric|scaption|rom exercis\w*|sets? of|reps?)\b/i],
    ["97035", /\bultrasound\b/i],
    ["97032", /\b(e-?stim|electrical stim\w*|tens|ifc|interferential)\b/i],
    ["97012", /\b(mechanical )?traction\b/i],
    ["97010", /\b(hot pack|cold pack|hot\/cold|ice|heat|cryotherapy|moist heat)\b/i],
  ];

  /** Suggest CPT codes from a treatment narrative. Returns [{code, desc,
      timed}] with no minutes or units — the clinician supplies those, because
      only they know how long each intervention actually took. */
  function suggestCodes(text) {
    const t = String(text || "");
    if (!t.trim()) return [];
    const out = [];
    for (const [code, re] of CODE_HINTS) {
      if (re.test(t) && !out.some((c) => c.code === code)) {
        const known = findCode(code);
        if (known) out.push({ code: known.code, desc: known.desc, timed: known.timed });
      }
    }
    return out;
  }

  /* ================================================================== *
   *  OUTCOME MEASURES
   * ================================================================== */

  /* `better` says which direction counts as improvement; `mcid` is the
     minimal clinically important difference — the change size below which a
     score move is noise rather than progress. */
  const OUTCOME_TOOLS = [
    { id: "lefs", name: "LEFS", full: "Lower Extremity Functional Scale", min: 0, max: 80, better: "up", mcid: 9, unit: "/80" },
    { id: "dash", name: "DASH", full: "Disabilities of Arm, Shoulder & Hand", min: 0, max: 100, better: "down", mcid: 10, unit: "/100" },
    { id: "quickdash", name: "QuickDASH", full: "QuickDASH", min: 0, max: 100, better: "down", mcid: 8, unit: "/100" },
    { id: "ndi", name: "NDI", full: "Neck Disability Index", min: 0, max: 100, better: "down", mcid: 7.5, unit: "%" },
    { id: "odi", name: "ODI", full: "Oswestry Disability Index", min: 0, max: 100, better: "down", mcid: 10, unit: "%" },
    { id: "nprs", name: "NPRS", full: "Numeric Pain Rating Scale", min: 0, max: 10, better: "down", mcid: 2, unit: "/10" },
    { id: "psfs", name: "PSFS", full: "Patient-Specific Functional Scale", min: 0, max: 10, better: "up", mcid: 2, unit: "/10" },
    { id: "abc", name: "ABC", full: "Activities-specific Balance Confidence", min: 0, max: 100, better: "up", mcid: 13, unit: "%" },
    { id: "tug", name: "TUG", full: "Timed Up and Go", min: 0, max: 120, better: "down", mcid: 3, unit: " s" },
  ];

  const toolIndex = {};
  OUTCOME_TOOLS.forEach((t) => { toolIndex[t.id] = t; });
  const findTool = (id) => toolIndex[String(id || "").toLowerCase().trim()] || null;

  /** Clamp/validate one recorded score. Returns { ok, value, error }. */
  function validateScore(toolId, raw) {
    const tool = findTool(toolId);
    if (!tool) return { ok: false, error: "Unknown outcome measure." };
    if (raw === "" || raw === null || raw === undefined) return { ok: false, error: "Enter a score." };
    const v = Number(raw);
    if (!isFinite(v)) return { ok: false, error: "Score must be a number." };
    if (v < tool.min || v > tool.max) return { ok: false, error: `${tool.name} runs ${tool.min}–${tool.max}.` };
    return { ok: true, value: v };
  }

  /**
   * Trend one tool's scores across an episode.
   * series: [{ toolId, score, date }] in any order, any mix of tools.
   * Returns one entry per tool that has at least one score, each with the
   * baseline, the latest, the signed change in the improving direction, and
   * whether that change clears the tool's MCID.
   */
  function outcomeTrends(series) {
    const byTool = {};
    (series || []).forEach((s) => {
      const tool = findTool(s && s.toolId);
      if (!tool) return;
      const v = Number(s.score);
      if (!isFinite(v)) return;
      (byTool[tool.id] = byTool[tool.id] || []).push({ score: v, date: s.date || "" });
    });

    return Object.keys(byTool).map((id) => {
      const tool = toolIndex[id];
      const pts = byTool[id].slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const first = pts[0], last = pts[pts.length - 1];
      const raw = last.score - first.score;
      // positive `improvement` always means "got better", whichever way the
      // scale runs, so callers never have to remember the direction
      const improvement = tool.better === "up" ? raw : -raw;
      return {
        toolId: tool.id, name: tool.name, full: tool.full, unit: tool.unit, mcid: tool.mcid,
        points: pts,
        n: pts.length,
        first: first.score, firstDate: first.date,
        latest: last.score, latestDate: last.date,
        change: raw,
        improvement,
        meaningful: pts.length > 1 && Math.abs(improvement) >= tool.mcid,
        direction: pts.length < 2 || improvement === 0 ? "flat" : improvement > 0 ? "better" : "worse",
      };
    }).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /* "LEFS 52 out of 80", "DASH score is 38", "Oswestry 24%".
     The filler group repeats because people stack these words ("score is",
     "is now") — each repetition must consume a real word, so it can't spin. */
  const OUTCOME_RE = new RegExp(
    "\\b(" + OUTCOME_TOOLS.map((t) => t.name).join("|") + "|oswestry|quick dash)\\b" +
    "(?:\\s*(?:score[ds]?|is|was|of|at|now|came in|=|:))*" +
    "\\s*(\\d{1,3}(?:\\.\\d)?)\\s*(?:%|/\\s*\\d{1,3}|out of\\s*\\d{1,3}|s(?:ec(?:onds)?)?)?",
    "gi"
  );

  /** Pull outcome-measure scores out of dictated text. Only returns scores
      that fall inside the tool's valid range, so "DASH 400" is ignored rather
      than filed as a bad number. */
  function extractOutcomes(text) {
    const out = [];
    const t = String(text || "");
    OUTCOME_RE.lastIndex = 0;
    let m;
    while ((m = OUTCOME_RE.exec(t)) !== null) {
      let key = m[1].toLowerCase().replace(/\s+/g, "");
      if (key === "oswestry") key = "odi";
      const tool = findTool(key);
      if (!tool) continue;
      const v = validateScore(tool.id, m[2]);
      if (!v.ok) continue;
      if (out.some((o) => o.toolId === tool.id)) continue; // first mention wins
      out.push({ toolId: tool.id, name: tool.name, score: v.value });
    }
    return out;
  }

  /* ================================================================== *
   *  GOALS
   * ================================================================== */

  const GOAL_STATUS = [
    { id: "active", label: "In progress" },
    { id: "met", label: "Met" },
    { id: "partial", label: "Partially met" },
    { id: "notmet", label: "Not met" },
    { id: "discontinued", label: "Discontinued" },
  ];

  const isOpenGoal = (g) => !g.status || g.status === "active";

  const daysBetween = (fromIso, toIso) => {
    const a = new Date(String(fromIso).slice(0, 10) + "T00:00:00");
    const b = new Date(String(toIso).slice(0, 10) + "T00:00:00");
    if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
    return Math.round((b - a) / 86400000);
  };

  /** Where one goal stands relative to today. `state` is one of
      "met" | "closed" | "overdue" | "due-soon" | "on-track" | "no-date". */
  function goalStatus(goal, todayIso) {
    const g = goal || {};
    if (g.status === "met") return { state: "met", label: "Met", days: null };
    if (g.status && g.status !== "active") {
      return { state: "closed", label: (GOAL_STATUS.find((s) => s.id === g.status) || {}).label || g.status, days: null };
    }
    if (!g.targetDate) return { state: "no-date", label: "No target date", days: null };
    const days = daysBetween(todayIso, g.targetDate);
    if (days === null) return { state: "no-date", label: "No target date", days: null };
    if (days < 0) return { state: "overdue", label: `${-days} day${days === -1 ? "" : "s"} overdue`, days };
    if (days === 0) return { state: "due-soon", label: "Due today", days };
    if (days <= 14) return { state: "due-soon", label: `Due in ${days} day${days === 1 ? "" : "s"}`, days };
    return { state: "on-track", label: `Due ${g.targetDate}`, days };
  }

  /** Episode-level goal roll-up for the chart overview and progress reports. */
  function goalSummary(goals, todayIso) {
    const list = (goals || []).map((g) => ({ goal: g, status: goalStatus(g, todayIso) }));
    const count = (state) => list.filter((x) => x.status.state === state).length;
    const open = list.filter((x) => isOpenGoal(x.goal)).length;
    return {
      total: list.length,
      open,
      met: list.filter((x) => x.goal.status === "met").length,
      overdue: count("overdue"),
      dueSoon: count("due-soon"),
      items: list,
    };
  }

  return {
    // billing
    CPT_CODES, findCode, isTimedCode, unitsForMinutes, minutesForUnits,
    billingSummary, suggestCodes,
    // outcome measures
    OUTCOME_TOOLS, findTool, validateScore, outcomeTrends, extractOutcomes,
    // goals
    GOAL_STATUS, goalStatus, goalSummary, isOpenGoal,
  };
});
