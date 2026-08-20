/* TheraChart adversarial dictation checker — what the microphone must REFUSE.

   Live dictation listens to a room, not to a form. Everything said in that
   room reaches the transcript: the greeting, the parking, the therapist's own
   cues, the patient's news about their daughter's wedding, and somewhere in
   the middle the two sentences that are the reason the visit is billable.

   The transcript keeping all of it is correct — it is the verbatim record.
   The NOTE keeping all of it is not, and for a long time it did, because the
   live router's fallback for a sentence it did not recognise was "Subjective".
   That single default meant a signed evaluation could report, in the
   patient's own voice, that the lot gets full after ten.

   This file is the adversarial pass: lines chosen to look clinical to a
   keyword scanner and be nothing of the sort. Each one asserts BOTH halves —
   that it stays out of the note, and that it survives in the transcript — and
   the clinical controls at the end assert the gate did not simply close.

   Run: node test/adversarial.test.js */

"use strict";

const fs = require("fs");
const path = require("path");

const PR = require("../parser.js");
const CL = require("../clinical.js");

const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

/* Lift the live router out of app.js and run the real source, so this file
   fails when app.js regresses rather than when a copy of it does. */
function lift(decl) {
  const start = SRC.indexOf(decl);
  if (start < 0) throw new Error(`app.js no longer contains: ${decl}`);
  const end = SRC.indexOf("\n  }\n", start);
  if (end < 0) throw new Error(`could not find the end of: ${decl}`);
  return SRC.slice(start, end + 5);
}

const TREAT_RE = /\b(performed|completed|exercis\w*|therex|sets?|reps?|ultrasound|massage|stretch\w*|mobilizat\w*|manual therapy|gait|ice|heat|e-?stim\w*|modalit\w*|educat\w*|hep|home program|tens)\b/i;

/** Lift a single-line `const` declaration by name. */
function liftConst(name) {
  const re = new RegExp(`^  const ${name} = .*$`, "m");
  const m = re.exec(SRC);
  if (!m) throw new Error(`app.js no longer declares: ${name}`);
  return m[0];
}

const ROUTER = new Function("PR", "CL", "TREAT_RE",
  [liftConst("PATIENT_VOICE_FIELDS"),
   liftConst("ABBREV_RE"),
   lift("  function splitSentences("),
   lift("  function fieldForSentence(")].join("\n")
  + "\n  return { splitSentences, fieldForSentence };")(PR, CL, TREAT_RE);

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) passed += 1;
  else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
};

/** Everything one utterance writes into the note of `type`. */
function filed(type, text, speaker) {
  const out = [];
  for (const sentence of ROUTER.splitSentences(text)) {
    const field = ROUTER.fieldForSentence(type, sentence, speaker);
    if (field) out.push([field, sentence.trim()]);
  }
  return out;
}

const pins = (text) => PR.parseUtterance(text).mentions.map((m) => `${m.side ? m.side + " " : ""}${m.partName}`);

/* ================================================================== *
 * 1. Noise that must never reach a note section
 * ================================================================== */
const NOISE = [
  ["greeting", "Good morning, how are you today?"],
  ["farewell", "Take care, see you next time."],
  ["thanks", "Thank you so much, you are very kind."],
  ["backchannel", "Okay. Mm-hmm. Sige po."],
  ["parking", "Was the parking okay? The lot gets full after ten."],
  ["payment", "Please settle the bayad at the front desk before you go."],
  ["wifi", "The wifi password is on the wall if you need it."],
  ["rescheduling", "Let us reschedule you for next week, same time."],
  ["weather", "It has been raining so hard all week and the traffic was terrible."],
  ["family news", "My daughter is getting married next month in Cebu."],
  ["television", "Did you watch the game last night? It went to overtime."],
  ["the room", "Sorry, that is my phone, let me silence it."],
  ["a child in the room", "Anak, wait outside for a minute please."],
  ["groceries", "I still have to go to the palengke after this."],
];

for (const [label, text] of NOISE) {
  check(`noise stays out of the note: ${label}`, filed("eval", text).length === 0,
    JSON.stringify(filed("eval", text)));
  check(`noise stays out of the note (daily): ${label}`, filed("daily", text).length === 0,
    JSON.stringify(filed("daily", text)));
}

/* ================================================================== *
 * 2. Body parts that are named but are not the patient's complaint
 * ================================================================== */
{
  const cases = [
    ["someone else's surgery", "My daughter had knee surgery last year and she is fine now.", "Knee"],
    ["someone else's complaint", "My wife's shoulder has been bothering her too.", "Shoulder"],
    ["idiom: pain in the neck", "Honestly the paperwork is a real pain in the neck.", "Neck"],
    ["idiom: headache", "Dealing with the HMO is such a headache.", "Head"],
    ["idiom: gut feeling", "I had a gut feeling that the traffic would be bad.", "Stomach"],
    ["idiom: costs an arm and a leg", "The MRI costs an arm and a leg these days.", "Arm"],
    ["idiom: give me a hand", "Could you give me a hand with the door?", "Hand"],
    ["hypothetical", "If my shoulder starts hurting again I will call you.", "Shoulder"],
  ];
  for (const [label, text, part] of cases) {
    check(`no map pin: ${label}`, !pins(text).some((p) => p.endsWith(part)),
      `${text} → ${JSON.stringify(pins(text))}`);
    check(`no note entry: ${label}`, filed("eval", text).length === 0,
      JSON.stringify(filed("eval", text)));
  }

  // and the same words, when they ARE the patient's, still get through
  check("the patient's own knee still pins",
    pins("My knee has been swollen since the fall.").some((p) => p.endsWith("Knee")));
  check("a relative who is merely the one talking does not block the patient",
    pins("My daughter says my back looks crooked.").some((p) => p.endsWith("Back")));
  check("a literal denial is not an idiom",
    /denies/i.test((PR.parseUtterance("No pain in the neck, but the shoulder is a 7 out of 10.")
      .mentions.find((m) => m.partName === "Neck") || {}).summary || ""));
  check("an 'if' that describes a trigger is not a hypothetical",
    pins("If I bend over my back really hurts.").some((p) => p.endsWith("Back")),
    JSON.stringify(pins("If I bend over my back really hurts.")));
}

/* ================================================================== *
 * 3. The clinician's own voice
 * ================================================================== */
{
  const cues = [
    "Where exactly does it hurt the most?",
    "Push against my hand and resist, do not let me move you.",
    "Okay, relax. Take a deep breath and let it go.",
    "Point to the spot with one finger.",
  ];
  for (const c of cues) {
    check(`clinician cue files nowhere: ${c.slice(0, 28)}…`, filed("eval", c, "clinician").length === 0,
      JSON.stringify(filed("eval", c, "clinician")));
  }
  check("a clinician cue does not pin the hand it names",
    !pins("Push against my hand and resist.").some((p) => p.endsWith("Hand")) ||
    PR.parseUtterance("Push against my hand and resist.").mentions.every((m) => m.bare),
    JSON.stringify(pins("Push against my hand and resist.")));

  // an observation the therapist makes out loud is objective, not the
  // patient's own report
  const obs = filed("eval", "The right shoulder sits noticeably higher than the left.", "clinician");
  check("clinician observation goes to Objective, not Subjective",
    obs.length === 1 && obs[0][0] === "objectiveText", JSON.stringify(obs));
  const obsProgress = filed("progress", "The right shoulder sits noticeably higher than the left.", "clinician");
  check("clinician observation goes to Updated findings on a progress note",
    obsProgress.length === 1 && obsProgress[0][0] === "updatedFindings", JSON.stringify(obsProgress));
  const pt = filed("eval", "My right shoulder aches whenever I reach overhead.", "patient");
  check("the patient's report still goes to Subjective",
    pt.length === 1 && pt[0][0] === "subjective", JSON.stringify(pt));
}

/* ================================================================== *
 * 4. Real clinical content must survive the gate
 * ================================================================== */
{
  const wants = [
    ["subjective", "My right shoulder has been aching for two weeks, about a seven out of ten."],
    ["subjective", "It is worse when I reach overhead or when I sleep on that side."],
    ["subjective", "I cannot put my socks on in the morning without help."],
    ["subjective", "I have trouble sleeping through the night because of it."],
    ["precautions", "The surgeon said no lifting over five kilos for six weeks."],
    ["pmh", "I was diagnosed with diabetes about ten years ago."],
    ["reason", "Dr. Santos referred me for the right shoulder."],
    ["subjective", "Masakit ang kaliwang balikat ko kapag gumagalaw."],
  ];
  for (const [field, text] of wants) {
    const got = filed("eval", text, "patient");
    check(`clinical content files to ${field}: ${text.slice(0, 34)}…`,
      got.some(([f]) => f === field), JSON.stringify(got));
  }

  // the abbreviation that used to split a sentence in half
  const drs = ROUTER.splitSentences("Dr. Santos referred me for the right shoulder.");
  check("a title does not split the sentence", drs.length === 1, JSON.stringify(drs));
  check("two real sentences still split",
    ROUTER.splitSentences("My knee hurts. It started last week.").length === 2);

  // a complaint buried in small talk is still a complaint
  const buried = filed("eval", "My daughter is getting married next month, but my low back is killing me.", "patient");
  check("a complaint buried in small talk still files", buried.length >= 1, JSON.stringify(buried));
  check("the small-talk half is not what filed",
    buried.every(([, sentence]) => !/married/i.test(sentence)), JSON.stringify(buried));
}

/* ================================================================== *
 * 5. Whatever does leak through live, the cleanup pass takes back
 * ================================================================== */
{
  const visit = [
    "good morning how are you today",
    "okay lang po salamat",
    "was the parking okay",
    "my right shoulder has been really painful for about two weeks",
    "how bad is it on a scale of one to ten",
    "probably an eight out of ten when I reach overhead",
    "my daughter is getting married next month in Cebu",
    "let me check your range, shoulder flexion is 95 degrees",
    "and my elbow",
    "actually I meant my left shoulder not the right one",
    "please settle the bayad at the front desk on your way out",
  ];
  const r = PR.refineTranscript(visit);
  const line = (needle) => r.dialogue.find((d) => new RegExp(needle, "i").test(d.text));

  check("cleanup drops the greeting", line("good morning").keep === false);
  check("cleanup drops the acknowledgement", line("salamat").keep === false);
  check("cleanup drops the parking", line("parking").keep === false,
    line("parking") && line("parking").dropReason);
  check("cleanup drops the payment logistics", line("bayad").keep === false,
    line("bayad") && line("bayad").dropReason);
  check("cleanup drops the bare elbow", line("elbow").keep === false);
  check("cleanup keeps the complaint", line("really painful").keep === true);
  check("cleanup keeps the rating", line("eight out of ten").keep === true);
  check("cleanup keeps the clinician's question", line("scale of one to ten").keep === true);
  check("cleanup keeps the correction", line("actually i meant").keep === true);

  check("cleanup gives a reason for every line it drops",
    r.dialogue.filter((d) => d.keep === false).every((d) => (d.dropReason || "").trim().length > 0),
    JSON.stringify(r.dialogue.filter((d) => d.keep === false).map((d) => [d.text, d.dropReason])));

  check("small talk stays out of the cleaned Subjective",
    !/parking|married|salamat|good morning/i.test(r.subjective), r.subjective);
  check("the complaint is in the cleaned Subjective",
    /shoulder/i.test(r.subjective), r.subjective);
  check("the wedding never became a finding",
    !r.findings.some((f) => /married|wedding/i.test(f.summary)),
    JSON.stringify(r.findings.map((f) => f.summary)));
  check("the correction is offered as a correction",
    (r.corrections || []).some((t) => t.key === "Shoulder|right"),
    JSON.stringify((r.corrections || []).map((t) => t.key)));
  check("the clinician's ROM read-out became a measurement, not a symptom",
    r.measurements.rom.some((m) => m.degrees === 95), JSON.stringify(r.measurements.rom));
}

const total = passed + failures.length;
console.log(`\nTheraChart adversarial dictation checker: ${passed}/${total} checks passed`);
if (failures.length) { console.log("\n" + failures.join("\n") + "\n"); process.exit(1); }
