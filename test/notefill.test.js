/* TheraChart note-filling checker — which sections fill themselves, whether
   the cleanup pass rewrites all of them, and whether the printed copy shows
   what the therapist actually signed.

   Three things used to be true at once and were only wrong together:

     dictation filed into six sections of an evaluation;
     the AI review rewrote one of them;
     and the note gave no sign of which was which, so an empty box waiting on
     dictation and an empty box waiting on the therapist looked identical.

   The result was a signed evaluation whose Subjective had been reviewed,
   whose Precautions still held whatever the raw live pass guessed, and whose
   Plan was blank because nothing ever said the Plan is not something a
   transcript can produce. Printing it dropped the plan of care as well.

   Run: node test/notefill.test.js */

"use strict";

const fs = require("fs");
const path = require("path");

const PR = require("../parser.js");
const CL = require("../clinical.js");

const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function lift(decl) {
  const start = SRC.indexOf(decl);
  if (start < 0) throw new Error(`app.js no longer contains: ${decl}`);
  const end = SRC.indexOf("\n  }\n", start);
  if (end < 0) throw new Error(`could not find the end of: ${decl}`);
  return SRC.slice(start, end + 5);
}
function liftBlock(startDecl, endMarker) {
  const start = SRC.indexOf(startDecl);
  if (start < 0) throw new Error(`app.js no longer contains: ${startDecl}`);
  const end = SRC.indexOf(endMarker, start);
  if (end < 0) throw new Error(`could not find ${endMarker} after ${startDecl}`);
  return SRC.slice(start, end + endMarker.length);
}
function liftConst(name) {
  const m = new RegExp(`^  const ${name} = .*$`, "m").exec(SRC);
  if (!m) throw new Error(`app.js no longer declares: ${name}`);
  return m[0];
}

const TREAT_RE = /\b(performed|completed|exercis\w*|therex|sets?|reps?|ultrasound|massage|stretch\w*|mobilizat\w*|manual therapy|gait|ice|heat|e-?stim\w*|modalit\w*|educat\w*|hep|home program|tens)\b/i;

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) passed += 1;
  else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
};

/* ================================================================== *
 * 1. The cleanup drafts every section, and each sentence lands once
 * ================================================================== */
{
  const visit = [
    "good morning how are you today",
    "doctor Santos referred me for the right shoulder",
    "the surgeon said no lifting over five kilos for six weeks",
    "I was diagnosed with diabetes about ten years ago",
    "my right shoulder has been really painful for about two weeks",
    "was the parking okay, the lot fills up after ten",
    "the right shoulder sits noticeably higher than the left",
    "shoulder flexion is 95 degrees",
    "this is consistent with a rotator cuff impingement",
    "we did manual therapy and scaption today",
  ];
  const r = PR.refineTranscript(visit);

  check("cleanup drafts the reason for referral", /referred/i.test(r.reason || ""), r.reason);
  check("cleanup drafts the precautions", /no lifting/i.test(r.precautions || ""), r.precautions);
  check("cleanup drafts the past medical history", /diabetes/i.test(r.pmh || ""), r.pmh);
  check("cleanup drafts the subjective", /painful/i.test(r.subjective || ""), r.subjective);
  check("cleanup drafts the objective narrative", /higher than the left/i.test(r.objective || ""), r.objective);
  check("cleanup drafts the assessment", /impingement/i.test(r.assessment || ""), r.assessment);
  check("cleanup drafts the treatment", /manual therapy/i.test(r.treatment || ""), r.treatment);

  // no sentence in two places at once
  check("the referral is not repeated in the subjective",
    !/referred/i.test(r.subjective || ""), r.subjective);
  check("the precaution is not repeated in the subjective",
    !/no lifting/i.test(r.subjective || ""), r.subjective);
  check("the history is not repeated in the subjective",
    !/diabetes/i.test(r.subjective || ""), r.subjective);
  check("the assessment is not repeated in the subjective",
    !/impingement/i.test(r.subjective || ""), r.subjective);
  check("the therapist's observation is not in the patient's subjective",
    !/higher than the left/i.test(r.subjective || ""), r.subjective);

  // a reading already in the table is not repeated as narrative
  check("the ROM reading files as a measurement",
    r.measurements.rom.some((m) => m.degrees === 95), JSON.stringify(r.measurements.rom));
  check("the ROM reading is not also narrated in the objective",
    !/95 degrees/i.test(r.objective || ""), r.objective);

  // and none of the noise reached any section
  const everySection = [r.reason, r.precautions, r.pmh, r.subjective, r.objective, r.assessment, r.treatment].join(" ");
  check("no greeting reached any section", !/good morning/i.test(everySection), everySection);
  check("no parking reached any section", !/parking|lot fills/i.test(everySection), everySection);

  // the cleanup names no Plan — frequency and duration are the therapist's
  check("the cleanup does not write a Plan", r.plan === undefined, JSON.stringify(r.plan));
}

/* ================================================================== *
 * 2. The field-source map agrees with what the router actually does
 * ================================================================== */
{
  const ROUTER = new Function("PR", "CL", "TREAT_RE",
    [liftConst("PATIENT_VOICE_FIELDS"),
     liftConst("ABBREV_RE"),
     liftBlock("  const DICTATABLE = {", "\n  };"),
     liftConst("isDictatable"),
     lift("  function splitSentences("),
     lift("  function aimedField("),
     lift("  function fieldForSentence(")].join("\n")
    + "\n  return { splitSentences, fieldForSentence, aimedField, DICTATABLE, isDictatable };")(PR, CL, TREAT_RE);

  const MAPS = new Function(
    [liftBlock("  const FIELD_SOURCES = {", "\n  };"),
     liftBlock("  const SECTION_SOURCES = {", "\n  };"),
     liftBlock("  const SOURCE_META = {", "\n  };")].join("\n")
    + "\n  return { FIELD_SOURCES, SECTION_SOURCES, SOURCE_META };")();

  // a corpus wide enough to exercise every route the live pass can take
  const CORPUS = [
    ["patient", "Doctor Santos referred me for the right shoulder."],
    ["patient", "The surgeon said no lifting over five kilos for six weeks."],
    ["patient", "I was diagnosed with diabetes about ten years ago."],
    ["patient", "My right shoulder has been aching for two weeks, about a seven out of ten."],
    ["patient", "It is worse when I reach overhead."],
    ["patient", "I cannot put my socks on in the morning."],
    ["clinician", "The right shoulder sits noticeably higher than the left."],
    ["clinician", "This is consistent with a rotator cuff impingement."],
    ["clinician", "We did manual therapy and scaption today."],
    ["clinician", "Continue two times a week for four weeks."],
    ["clinician", "She tolerated the session well and is progressing."],
  ];

  for (const type of ["eval", "daily", "progress", "discharge"]) {
    const produced = new Set();
    for (const [speaker, text] of CORPUS) {
      for (const sentence of ROUTER.splitSentences(text)) {
        const clinical = PR.trimToClinical(sentence);
        if (!clinical) continue;
        const f = ROUTER.fieldForSentence(type, clinical, speaker);
        if (f) produced.add(f);
      }
    }
    const map = MAPS.FIELD_SOURCES[type] || {};

    // anything the router can write must be described as machine-written
    for (const field of produced) {
      check(`${type}: the guide knows dictation writes ${field}`,
        map[field] === "filled" || map[field] === "drafted",
        `router writes ${field}; guide says ${map[field] || "(unlisted)"}`);
    }
    // and anything called the therapist's must never be written for them
    for (const [field, source] of Object.entries(map)) {
      if (source !== "yours") continue;
      check(`${type}: nothing files into ${field}, which the guide calls yours`,
        !produced.has(field), `router wrote ${field}`);
    }
    check(`${type}: every source has a badge`,
      Object.values(map).every((v) => MAPS.SOURCE_META[v]), JSON.stringify(map));
  }

  check("goals are never machine-written", MAPS.SECTION_SOURCES.goals.source === "yours");
  check("billing is never machine-written", MAPS.SECTION_SOURCES.charges.source === "yours");
  check("measurements are machine-written", MAPS.SECTION_SOURCES.measurements.source === "filled");
}

/* ================================================================== *
 * 2b. Aiming the microphone at a section
 *
 *  The field test's headline complaint was not that the classifier is bad.
 *  It is that when it puts a sentence in the wrong place, moving it costs
 *  more than typing the note would have — and that it is wrong most often on
 *  the one question it cannot see: whether a line is the patient's report or
 *  the therapist's observation.
 *
 *  So a stated target has to WIN. These checks are about the target beating
 *  the classifier, not agreeing with it.
 * ================================================================== */
{
  // block 2's sandbox is scoped to block 2; this one builds its own
  const R2 = new Function("PR", "CL", "TREAT_RE",
    [liftConst("PATIENT_VOICE_FIELDS"),
     liftConst("ABBREV_RE"),
     liftBlock("  const DICTATABLE = {", "\n  };"),
     liftConst("isDictatable"),
     lift("  function splitSentences("),
     lift("  function aimedField("),
     lift("  function fieldForSentence(")].join("\n")
    + "\n  return { splitSentences, fieldForSentence, aimedField, DICTATABLE, isDictatable };")(PR, CL, TREAT_RE);
  const { aimedField, fieldForSentence, isDictatable, DICTATABLE } = R2;

  // Every section named as dictatable must be a field the note type has.
  const FIELDS_OF = {
    eval: ["reason", "precautions", "pmh", "subjective", "objectiveText", "assessment", "plan"],
    daily: ["subjective", "summary", "assessment", "plan"],
    progress: ["currentStatus", "updatedFindings", "assessment", "goalsProgress"],
    discharge: ["summary", "outcome", "recommendations"],
  };
  for (const [type, fields] of Object.entries(DICTATABLE)) {
    check(`${type}: every dictatable section is a real field of the note`,
      fields.every((f) => FIELDS_OF[type].includes(f)),
      `${fields.filter((f) => !FIELDS_OF[type].includes(f)).join(", ")} is not on a ${type}`);
  }
  check("a section from another note type cannot be aimed at",
    !isDictatable("daily", "pmh") && !isDictatable("discharge", "subjective"),
    "a stale target would file text into a field that isn't on the page");
  check("the measurement table and the charge sheet are not dictated into",
    !Object.values(DICTATABLE).flat().some((f) => ["charges", "measurements", "goals", "outcomes"].includes(f)));

  /* THE CASE THIS WHOLE FEATURE EXISTS FOR. The classifier sends a
     clinician-voiced sentence out of Subjective — correctly, when it is
     guessing. Aimed at Subjective, the therapist has already answered it. */
  const observed = "The right shoulder sits noticeably higher than the left";
  check("the classifier keeps a clinician's observation out of Subjective",
    fieldForSentence("eval", observed, "clinician") === "objectiveText",
    String(fieldForSentence("eval", observed, "clinician")));
  check("…but an aimed microphone files it where the therapist aimed it",
    aimedField("eval", observed, "subjective") === "subjective");

  // and the reverse: a patient-voiced line aimed at Objective stays there
  const reported = "My shoulder has been aching for two weeks";
  check("a patient-voiced line aimed at Objective goes to Objective",
    aimedField("eval", reported, "objectiveText") === "objectiveText");

  /* Small talk is trimmed by the caller, but noteWorthy() — which stops the
     classifier defaulting a stray line into Subjective — is deliberately not
     applied to an aimed mic. A therapist holding the mic at a section has
     answered the question it exists to ask. */
  const terse = "Doing better";
  check("a terse line the classifier would drop still files when aimed at",
    aimedField("daily", terse, "subjective") === "subjective",
    "an aimed mic that silently drops a short sentence reads as a broken mic");

  /* The one thing an aimed mic must still refuse: a value that already went
     into a table. The same finding in two places is free to disagree. */
  check("a ROM reading is not also written into the prose",
    aimedField("eval", "Shoulder flexion 120 degrees", "objectiveText") === null);
  check("an MMT grade is not either",
    aimedField("daily", "Quad strength 4 out of 5", "summary") === null);
  check("a special test is not either",
    aimedField("eval", "Positive Neer test", "objectiveText") === null);
  check("a standardised score goes to the outcome table, not the narrative",
    aimedField("eval", "LEFS is 58 out of 80", "subjective") === null);

  /* A pain rating is patient-reported prose AND a table row — it has always
     been both, and aiming must not change that. */
  check("a pain rating still reads as subjective prose",
    aimedField("daily", "It is about a seven out of ten today", "subjective") === "subjective");
}

/* ================================================================== *
 * 2c. Goal suggestions read what the parser actually writes
 *
 *  This exists because unit tests with invented fixtures did not catch the
 *  bug it now guards. suggestGoals() was written against `grade: "3"`, the
 *  parser has always stored `grade: "3/5"`, and every check passed while the
 *  feature produced nothing at all for any real chart.
 *
 *  So these drive DICTATED SENTENCES through the real parser and into the
 *  real suggester. Nothing here constructs a measurement by hand.
 * ================================================================== */
{
  const from = (...sentences) => {
    const m = PR.aggregateMeasurements(sentences);
    return CL.suggestGoals({ rom: m.rom, mmt: m.mmt, pain: m.pain, outcomes: [] }, []);
  };

  {
    const g = from("quad strength 3 out of 5 on the right");
    check("a dictated muscle grade produces a goal", g.length === 1, JSON.stringify(g));
    check("…one whole grade up", g[0].target === "4/5", JSON.stringify(g[0]));
    check("…with the baseline as the parser wrote it", g[0].baseline === "3/5", g[0].baseline);
    check("…and not doubled up ('3/5/5')", !/\/5\/5/.test(g[0].baseline + g[0].target));
  }
  {
    const g = from("quad strength 4 plus out of 5");
    check("a dictated plus-grade steps to the next WHOLE grade, not a half step",
      (g[0] || {}).target === "5/5", JSON.stringify(g),
    );
  }
  check("a dictated 5/5 produces nothing",
    from("quad strength 5 out of 5 on the left").length === 0);

  {
    const g = from("right shoulder flexion 120 degrees", "left shoulder flexion 165 degrees");
    check("a dictated ROM pair targets the sound side",
      g.length === 1 && g[0].target === "165°", JSON.stringify(g));
    check("…and never asks the sound side to regress",
      !g.some((x) => x.target === "120°"));
  }

  {
    const g = from("the pain is about a seven out of ten in the right shoulder");
    check("a dictated pain rating produces a goal", g.length === 1, JSON.stringify(g));
    check("…one NPRS MCID lower", g[0].target === "5/10", JSON.stringify(g[0]));
  }

  // and a whole visit at once, which is how it actually arrives
  {
    const g = from(
      "right shoulder flexion 120 degrees, external rotation 45 degrees",
      "left shoulder flexion 165 degrees",
      "quad strength 3 out of 5 on the right",
      "pain is a seven out of ten");
    check("a whole visit's dictation produces usable prompts", g.length >= 3, JSON.stringify(g.map((x) => x.text)));
    check("every prompt carries a baseline taken from the note",
      g.every((x) => x.baseline && x.baseline !== "undefined" && !/NaN|undefined/.test(x.baseline)),
      JSON.stringify(g.map((x) => x.baseline)));
    check("no prompt carries a malformed target",
      g.every((x) => !/NaN|undefined/.test(x.target)), JSON.stringify(g.map((x) => x.target)));
  }
}

/* ================================================================== *
 * 3. The printed copy carries what the note holds
 * ================================================================== */
{
  const esc = (x) => String(x === undefined || x === null ? "" : x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const goals = [{ id: "g1", text: "Climb a flight of stairs without the rail", term: "short", baseline: "4 steps", target: "12 steps", targetDate: "2026-10-01", status: "active" }];
  const S = {
    goalsFor: () => goals,
    currentUser: () => ({ id: "u1" }),
    audit: () => { },
  };

  const PRINTER = new Function("S", "CL", "esc", "fmtDT", "fmtDate", "todayIso",
    [liftConst("romLabel"),
     lift("  function measurementTables("),
     lift("  function docPrintHtml(")].join("\n")
    + "\n  return { docPrintHtml };")(
    S, CL, esc,
    (x) => String(x).slice(0, 16),
    (x) => String(x).slice(0, 10),
    () => "2026-08-19");

  const doc = {
    id: "d1", patientId: "p1", type: "eval", title: "Initial evaluation",
    status: "signed", createdAt: "2026-08-19T10:00:00.000Z",
    signatures: [], amendments: [],
    data: {
      reason: "Dr. Santos referred for right shoulder pain.",
      precautions: "No lifting over five kilos for six weeks.",
      pmh: "Diagnosed with diabetes ten years ago.",
      subjective: "Right shoulder aching for two weeks, seven out of ten.",
      objectiveText: "Right shoulder sits higher than the left.",
      assessment: "Consistent with rotator cuff impingement.",
      plan: "Twice weekly for four weeks.",
      rom: [{ side: "right", joint: "shoulder", motion: "flexion", degrees: 95 }],
      mmt: [], special: [], pain: [{ location: "shoulder", score: 7 }],
      outcomes: [], charges: [],
      mapPoints: [{ key: "Shoulder|right", part: "Shoulder", side: "right", view: "front", x: 1, y: 1, notes: [{ summary: "Pain 7/10 for two weeks" }] }],
      refinement: { applied: true, ranAt: "2026-08-19T11:00:00.000Z", engine: "gemini", sections: ["Precautions", "Subjective"] },
    },
  };

  const html = PRINTER.docPrintHtml(doc, { includeGoals: true });

  for (const [label, needle] of [
    ["reason for referral", "Dr. Santos referred"],
    ["precautions", "No lifting over five kilos"],
    ["past medical history", "diabetes"],
    ["subjective", "aching for two weeks"],
    ["objective narrative", "sits higher than the left"],
    ["assessment", "rotator cuff impingement"],
    ["plan", "Twice weekly"],
    ["range of motion", "95"],
    ["pain rating", "7/10"],
    ["body chart findings", "Pain 7/10 for two weeks"],
  ]) {
    check(`print carries the ${label}`, html.includes(needle), label);
  }

  check("print carries the plan of care", /Climb a flight of stairs/.test(html));
  check("print shows the goal's baseline and target", /4 steps/.test(html) && /12 steps/.test(html));
  check("print records that AI cleanup was applied", /clean-?up applied/i.test(html), html.slice(-400));
  check("print names the engine that did it", /Gemini/.test(html));
  check("print names the sections a machine rewrote",
    /Precautions/.test(html) && /Subjective/.test(html));

  // the chart print prints goals once at the top, so a note inside it must not
  const inChart = PRINTER.docPrintHtml(doc);
  check("the chart print does not repeat goals per note",
    !/Climb a flight of stairs/.test(inChart));
  check("the chart print still carries the note's sections",
    /rotator cuff impingement/.test(inChart));

  // a note nobody ran the cleanup on says nothing about AI
  const untouched = { ...doc, data: { ...doc.data, refinement: undefined } };
  check("an unreviewed note claims no AI cleanup",
    !/clean-?up applied/i.test(PRINTER.docPrintHtml(untouched, { includeGoals: true })));
}

const total = passed + failures.length;
console.log(`\nTheraChart note-filling checker: ${passed}/${total} checks passed`);
if (failures.length) { console.log("\n" + failures.join("\n") + "\n"); process.exit(1); }
