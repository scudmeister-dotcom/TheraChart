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
     lift("  function splitSentences("),
     lift("  function fieldForSentence(")].join("\n")
    + "\n  return { splitSentences, fieldForSentence };")(PR, CL, TREAT_RE);

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
    [lift("  function measurementTables("),
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
