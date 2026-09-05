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
   *  BILLING — the clinic's own service catalogue
   *
   *  What a Philippine clinic actually bills is a short list of its own
   *  service codes with a peso price each, not a CPT code with minutes
   *  behind it. A charge line is therefore a code and a number of units,
   *  and the only arithmetic that matters is units x price = subtotal.
   *
   *  Prices are NOT in this table. They are per-clinic, they change, and
   *  they are the one part of billing not every account may touch — so they
   *  live in clinic settings (`servicePrices`) and are passed in. A code
   *  with no price set yet reads as "no price", never as free.
   * ================================================================== */

  /* Six codes per discipline: an initial evaluation and a basic therapy
     session, each in the clinic, at the patient's home, and inpatient. */
  const SERVICE_CODES = [
    { code: "PT01", desc: "PT — Initial evaluation", group: "Physical therapy" },
    { code: "PT02", desc: "PT — Basic therapy", group: "Physical therapy" },
    { code: "PT03", desc: "PT — Initial evaluation (home health)", group: "Physical therapy" },
    { code: "PT04", desc: "PT — Basic therapy (home health)", group: "Physical therapy" },
    { code: "PT05", desc: "PT — Initial evaluation (inpatient)", group: "Physical therapy" },
    { code: "PT06", desc: "PT — Basic therapy (inpatient)", group: "Physical therapy" },

    { code: "OT01", desc: "OT — Initial evaluation", group: "Occupational therapy" },
    { code: "OT02", desc: "OT — Basic therapy", group: "Occupational therapy" },
    { code: "OT03", desc: "OT — Initial evaluation (home health)", group: "Occupational therapy" },
    { code: "OT04", desc: "OT — Basic therapy (home health)", group: "Occupational therapy" },
    { code: "OT05", desc: "OT — Initial evaluation (inpatient)", group: "Occupational therapy" },
    { code: "OT06", desc: "OT — Basic therapy (inpatient)", group: "Occupational therapy" },

    { code: "ST01", desc: "ST — Initial evaluation", group: "Speech therapy" },
    { code: "ST02", desc: "ST — Basic therapy", group: "Speech therapy" },
    { code: "ST03", desc: "ST — Initial evaluation (home health)", group: "Speech therapy" },
    { code: "ST04", desc: "ST — Basic therapy (home health)", group: "Speech therapy" },
    { code: "ST05", desc: "ST — Initial evaluation (inpatient)", group: "Speech therapy" },
    { code: "ST06", desc: "ST — Basic therapy (inpatient)", group: "Speech therapy" },

    { code: "A01", desc: "Traction machine", group: "Add-ons" },
    { code: "A02", desc: "Combi machine", group: "Add-ons" },
    { code: "A03", desc: "TENS pad — large", group: "Add-ons" },
    { code: "A04", desc: "TENS pad — small", group: "Add-ons" },
  ];

  const serviceIndex = {};
  SERVICE_CODES.forEach((c) => { serviceIndex[c.code] = c; });
  const findService = (code) => serviceIndex[String(code || "").trim().toUpperCase()] || null;

  /** The order the codes are grouped in on screen, taken from the table
      itself so adding a code to a new group never needs a second edit. */
  function serviceGroups() {
    const out = [];
    SERVICE_CODES.forEach((c) => {
      let g = out.find((x) => x.group === c.group);
      if (!g) out.push((g = { group: c.group, codes: [] }));
      g.codes.push(c);
    });
    return out;
  }

  /** The price a code carries today, from the clinic's own schedule.
      Returns null — not 0 — when no price has been set, because "nobody has
      priced this yet" and "this one is free" are different facts. */
  function priceFor(code, prices) {
    const known = findService(code);
    if (!known) return null;
    const raw = (prices || {})[known.code];
    if (raw === "" || raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  /**
   * Total up a visit's charges against the clinic's price list.
   * charges: [{ code, units, price? }] — `price` is the peso amount the line
   * was entered at. It is snapshotted onto the line so a signed note keeps
   * the money it was signed for when the price list changes later; where a
   * line has none, today's schedule fills in.
   *
   * Returns per-line amounts, the subtotal, and anything worth fixing before
   * the note is signed. Never mutates the input.
   */
  function serviceSummary(charges, prices) {
    const rows = [];
    const issues = [];
    let subtotal = 0;
    let unpriced = 0;
    let units = 0;

    (charges || []).filter((c) => c && c.code).forEach((c) => {
      const known = findService(c.code);
      const u = Math.max(0, Math.round(Number(c.units) || 0));
      /* The line's own price wins over the schedule: that is what makes a
         signed note stable. Only a line that never carried one falls back. */
      const own = c.price === "" || c.price == null ? null : Number(c.price);
      const price = Number.isFinite(own) && own >= 0 ? own : priceFor(c.code, prices);
      const amount = price == null ? null : price * u;

      /* Worded so it reads correctly on a signed note as well as a draft.
         Every visit documented before the clinic moved to this catalogue
         carries codes from the old one, and those notes are locked — telling
         their reader to "check it" points at a thing nobody can change. */
      if (!known) issues.push({ level: "warn", text: `${c.code} is not on this clinic's price list, so it has no price and is not in the subtotal.` });
      else if (price == null) { unpriced++; issues.push({ level: "warn", text: `${known.code} ${known.desc} has no price set. An administrator sets prices in Facility Admin.` }); }
      if (known && !u) issues.push({ level: "warn", text: `${known.code} ${known.desc} is on the charge sheet with no units.` });

      units += u;
      if (amount != null) subtotal += amount;
      rows.push({ code: c.code, desc: (known || {}).desc || c.desc || "", group: (known || {}).group || "", units: u, price, amount, known: !!known });
    });

    return {
      lines: rows.length,
      rows,
      units,
      subtotal,
      /* A subtotal that silently omits an unpriced line is a wrong number
         presented as a right one. Say how many are missing instead. */
      unpriced,
      complete: rows.length > 0 && unpriced === 0,
      issues,
    };
  }

  /* ================================================================== *
   *  BILLING — CPT codes and the 8-minute rule  (legacy, US fee schedule)
   *
   *  Kept whole and still exported, but no longer wired into the note
   *  editor: the charge sheet bills the service catalogue above. Nothing
   *  here is reachable from the UI, and the 8-minute rule is a Medicare
   *  rule that never applied to a Philippine clinic in the first place.
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
  /* Each tool carries how it is SCORED as well as what it scores, so a
     therapist can record the form item by item and have the total computed,
     rather than doing the arithmetic on paper and typing one number in.

     `items` describes the instrument's own answer sheet:
        count   how many items (null = a single reading, e.g. a stopwatch)
        min/max the scale ONE item is answered on
        scoring how the items become the reported score:
                  "sum"     total of the items            (LEFS)
                  "percent" total as a % of the possible  (NDI, ODI)
                  "mean"    average of the items          (PSFS, ABC)
                  "dash"    ((mean - 1) x 25)             (DASH, QuickDASH)
        named   the patient names the items themselves    (PSFS)

     What is deliberately NOT here is the wording of the items. Several of
     these instruments are published under licence — the clinic holds the form
     and we do not — so items are numbered and the clinic reads its own copy
     alongside. The structure and the scoring formulas are plain facts about
     the instruments and are safe to encode; the questions are not ours to
     reproduce. PSFS is the exception because its items are named by the
     patient at the visit rather than printed on a form. */
  const OUTCOME_TOOLS = [
    { id: "lefs", name: "LEFS", full: "Lower Extremity Functional Scale", min: 0, max: 80, better: "up", mcid: 9, unit: "/80",
      items: { count: 20, min: 0, max: 4, scoring: "sum" } },
    { id: "dash", name: "DASH", full: "Disabilities of Arm, Shoulder & Hand", min: 0, max: 100, better: "down", mcid: 10, unit: "/100",
      items: { count: 30, min: 1, max: 5, scoring: "dash" } },
    { id: "quickdash", name: "QuickDASH", full: "QuickDASH", min: 0, max: 100, better: "down", mcid: 8, unit: "/100",
      items: { count: 11, min: 1, max: 5, scoring: "dash" } },
    { id: "ndi", name: "NDI", full: "Neck Disability Index", min: 0, max: 100, better: "down", mcid: 7.5, unit: "%",
      items: { count: 10, min: 0, max: 5, scoring: "percent" } },
    { id: "odi", name: "ODI", full: "Oswestry Disability Index", min: 0, max: 100, better: "down", mcid: 10, unit: "%",
      items: { count: 10, min: 0, max: 5, scoring: "percent" } },
    { id: "nprs", name: "NPRS", full: "Numeric Pain Rating Scale", min: 0, max: 10, better: "down", mcid: 2, unit: "/10",
      items: null },
    { id: "psfs", name: "PSFS", full: "Patient-Specific Functional Scale", min: 0, max: 10, better: "up", mcid: 2, unit: "/10",
      items: { count: 5, min: 0, max: 10, scoring: "mean", named: true, optional: true } },
    { id: "abc", name: "ABC", full: "Activities-specific Balance Confidence", min: 0, max: 100, better: "up", mcid: 13, unit: "%",
      items: { count: 16, min: 0, max: 100, scoring: "mean" } },
    { id: "tug", name: "TUG", full: "Timed Up and Go", min: 0, max: 120, better: "down", mcid: 3, unit: " s",
      items: null },
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

  /** The answer sheet for one tool, or null where it has none (a stopwatch
      reading and a single pain rating are not questionnaires). */
  const itemsFor = (toolId) => ((findTool(toolId) || {}).items) || null;

  /**
   * Compute a tool's reported score from its individual item answers.
   *
   * `answers` is a sparse array — a form is filled in over a couple of
   * minutes and half-finished is the normal state — so this reports how many
   * are answered as well as what they currently total. `complete` is what a
   * caller should check before treating the score as the instrument's:
   * scoring a half-filled LEFS gives a number that looks like severe
   * disability and is really an unanswered form.
   */
  function scoreFromItems(toolId, answers) {
    const tool = findTool(toolId);
    const spec = tool && tool.items;
    if (!spec) return { ok: false, error: "That measure is a single reading, not a questionnaire." };

    const vals = [];
    let outOfRange = 0;
    for (let i = 0; i < spec.count; i++) {
      const raw = (answers || [])[i];
      if (raw === "" || raw === null || raw === undefined) continue;
      const v = Number(raw);
      if (!isFinite(v) || v < spec.min || v > spec.max) { outOfRange++; continue; }
      vals.push(v);
    }
    /* An instrument the patient may leave items off — PSFS asks for three to
       five activities — is complete as soon as it has any. Everything else
       needs all of them. */
    const complete = spec.optional ? vals.length > 0 : vals.length === spec.count;
    const answered = vals.length;
    if (!answered) {
      return { ok: false, answered: 0, of: spec.count, complete: false, score: null,
               error: outOfRange ? `Item scores run ${spec.min}–${spec.max}.` : "No items answered yet." };
    }

    const sum = vals.reduce((a, b) => a + b, 0);
    const mean = sum / vals.length;
    let score;
    if (spec.scoring === "sum") score = sum;
    else if (spec.scoring === "percent") score = (sum / (spec.count * spec.max)) * 100;
    else if (spec.scoring === "mean") score = mean;
    else if (spec.scoring === "dash") score = (mean - 1) * 25;
    else score = sum;

    // one decimal is what every one of these instruments is reported to
    score = Math.round(score * 10) / 10;
    return {
      ok: true, score, answered, of: spec.count, complete,
      error: outOfRange ? `${outOfRange} item score${outOfRange > 1 ? "s are" : " is"} outside ${spec.min}–${spec.max} and was ignored.` : "",
    };
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

  /* ================================================================== *
   *  GOAL SUGGESTIONS
   *
   *  A prompt, never a prescription. Every suggestion is built from numbers
   *  ALREADY IN THIS NOTE, by a rule simple enough to state on screen, and
   *  nothing reaches the plan of care until the therapist presses it and
   *  edits it. That constraint is the whole design: a goal is a clinical
   *  commitment, and software that invents plausible-looking ones would be
   *  writing the plan of care while appearing to help with it.
   *
   *  So there is no rule here that needs clinical judgement we do not have.
   *  Where a target cannot be derived honestly — a range of motion with
   *  nothing to compare it to — the suggestion carries the baseline and
   *  leaves the target blank for the therapist rather than guessing at one.
   * ================================================================== */

  const MMT_GRADES = ["0", "1", "2", "2+", "3-", "3", "3+", "4-", "4", "4+", "5-", "5"];

  /** The next grade a muscle could reasonably be aiming at. Returns null at
      5/5, where there is nothing left to gain.

      Accepts the grade in the shape the PARSER stores it — "3/5", "4+/5" —
      as well as bare ("3", "4+"). The two shapes are the reason this takes a
      string at all: the measurement table has always written the denominator
      into the value, and a suggestion engine that only understood the bare
      form silently produced nothing for every muscle in every real chart. */
  function nextMmtGrade(grade) {
    const g = String(grade || "").trim().replace(/\s*\/\s*5$/, "");
    const i = MMT_GRADES.indexOf(g);
    if (i < 0 || i >= MMT_GRADES.length - 1) return null;
    /* Whole grades, not half steps: "3/5 → 4/5" is how a goal is written, and
       "3/5 → 3+/5" is a re-assessment note, not a plan of care. */
    const whole = MMT_GRADES.slice(i + 1).find((x) => /^[0-5]$/.test(x));
    return whole || null;
  }

  /* Sentence case, not title case: "Right shoulder flexion" is how a goal is
     written down, and "Right Shoulder Flexion" reads like a heading. */
  const sentenceCase = (s) => {
    const t = String(s || "").trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
  };

  /**
   * Goals worth offering, from what this visit measured.
   *
   * data: { rom, mmt, pain, outcomes } — the note's own tables.
   * existing: the patient's current goals, so nothing already committed to is
   *           offered a second time.
   *
   * Returns [{ key, text, baseline, target, term, rule }] — `rule` is the
   * one-line explanation shown beside the suggestion, because a therapist
   * accepting a target should be able to see where the number came from.
   */
  function suggestGoals(data, existing) {
    const d = data || {};
    const out = [];
    const taken = (existing || []).map((g) => String(g.text || "").toLowerCase());
    const already = (text) => {
      const t = text.toLowerCase();
      return taken.some((x) => x === t || (x.length > 8 && (x.includes(t) || t.includes(x))));
    };
    const push = (s) => { if (!already(s.text) && !out.some((o) => o.key === s.key)) out.push(s); };

    // --- muscle strength: the next whole grade up ---
    for (const m of d.mmt || []) {
      const next = nextMmtGrade(m.grade);
      if (!next) continue;
      const what = [m.side, m.context].filter(Boolean).join(" ").trim();
      if (!what) continue;
      push({
        key: `mmt:${what}`.toLowerCase(),
        text: `${sentenceCase(what)} strength ${next}/5`,
        baseline: /\/\s*5$/.test(String(m.grade)) ? String(m.grade) : `${m.grade}/5`,
        target: `${next}/5`,
        term: "short",
        rule: "the next whole muscle grade above today's",
      });
    }

    /* --- range of motion: the patient's OTHER side ---
       The uninvolved limb is the only target here that is a fact rather than
       an opinion — it is this patient's own normal, measured today. With no
       contralateral reading the suggestion still goes out, carrying the
       baseline, with the target left for the therapist. Inventing a
       normative end-range would be putting a number in the plan of care that
       nobody measured and nobody chose. */
    for (const r of d.rom || []) {
      if (!r.joint || !r.motion) continue;
      /* Only a BETTER other side is a target. Without this the rule fires
         both ways round and offers to bring the sound limb down to meet the
         injured one — a goal no therapist would write, in a list they are
         being asked to trust. */
      const other = (d.rom || []).find((x) =>
        x.joint === r.joint && x.motion === r.motion && x.side && r.side && x.side !== r.side
        && Number(x.degrees) > Number(r.degrees));
      /* A reading whose counterpart is WORSE is the reference limb — it is
         the target, not the problem. Offering to improve it as well filled
         the list with a goal for the sound side of every joint measured. */
      const counterpart = (d.rom || []).find((x) =>
        x.joint === r.joint && x.motion === r.motion && x.side && r.side && x.side !== r.side);
      if (!other && counterpart) continue;
      const what = `${r.side ? r.side + " " : ""}${r.joint} ${r.motion}`;
      push({
        key: `rom:${what}`.toLowerCase(),
        text: other
          ? `${sentenceCase(what)} to ${other.degrees}°, matching the ${other.side}`
          : `Improve ${what} range`,
        baseline: `${r.degrees}°`,
        target: other ? `${other.degrees}°` : "",
        term: "short",
        rule: other
          ? `the ${other.side} side measured ${other.degrees}° today`
          : "no reading on the other side to compare — set the target yourself",
      });
    }

    // --- pain: down by the NPRS minimal clinically important difference ---
    const nprsMcid = (findTool("nprs") || {}).mcid || 2;
    for (const pnt of d.pain || []) {
      const from = Number(pnt.score);
      if (!isFinite(from) || from <= nprsMcid) continue;
      const to = Math.max(0, from - nprsMcid);
      const where = pnt.location ? ` in the ${pnt.location}` : "";
      push({
        key: `pain:${pnt.location || "general"}`.toLowerCase(),
        text: `Pain${where} at or below ${to}/10`,
        baseline: `${from}/10`,
        target: `${to}/10`,
        term: "short",
        rule: `today's ${from}/10 less the NPRS clinically important difference of ${nprsMcid}`,
      });
    }

    // --- outcome measures: one MCID in the improving direction ---
    for (const o of d.outcomes || []) {
      const tool = findTool(o.toolId);
      const from = Number(o.score);
      if (!tool || !isFinite(from)) continue;
      const raw = tool.better === "up" ? from + tool.mcid : from - tool.mcid;
      const to = Math.round(Math.min(tool.max, Math.max(tool.min, raw)) * 10) / 10;
      if (to === from) continue;   // already at the end of the scale
      push({
        key: `outcome:${tool.id}`,
        text: `${tool.name} ${tool.better === "up" ? "of at least" : "at or below"} ${to}${tool.unit}`,
        baseline: `${from}${tool.unit}`,
        target: `${to}${tool.unit}`,
        term: "long",
        rule: `one ${tool.name} clinically important difference (${tool.mcid}) from today's ${from}`,
      });
    }

    return out;
  }

  return {
    // billing — the clinic's service catalogue
    SERVICE_CODES, findService, serviceGroups, priceFor, serviceSummary,
    // billing — legacy CPT / 8-minute rule, no longer used by the editor
    CPT_CODES, findCode, isTimedCode, unitsForMinutes, minutesForUnits,
    billingSummary, suggestCodes,
    // outcome measures
    OUTCOME_TOOLS, findTool, validateScore, outcomeTrends, extractOutcomes,
    itemsFor, scoreFromItems,
    // goals
    GOAL_STATUS, goalStatus, goalSummary, isOpenGoal,
    suggestGoals, nextMmtGrade,
  };
});
