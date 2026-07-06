/* TheraChart refiner checker — verifies the local AI-cleanup pass splits
   speakers correctly, draws findings only from patient speech, and that
   saved findings re-pin to the current mannequin. Run: node test/refine.test.js */

"use strict";

const PR = require("../parser.js");

let passed = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) passed += 1;
  else failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
};

/* ---- speaker attribution ---- */
check("question → clinician", PR.guessSpeaker("Where does it hurt the most?") === "clinician");
check("instruction → clinician", PR.guessSpeaker("Okay, push against my hand and resist.") === "clinician");
check("ROM read-out → clinician", PR.guessSpeaker("Shoulder flexion is 120 degrees today.") === "clinician");
check("MMT read-out → clinician", PR.guessSpeaker("Quad strength is 4 out of 5.") === "clinician");
check("symptom report → patient", PR.guessSpeaker("My left knee has been really sore all week.") === "patient");
check("pain rating answer → patient", PR.guessSpeaker("It's about a seven out of ten.") === "patient");
check("Tagalog symptom → patient", PR.guessSpeaker("Masakit ang kaliwang balikat ko.") === "patient");

/* ---- full conversation refinement ---- */
{
  const convo = [
    "so tell me what brings you in today",              // clinician
    "my right shoulder has been really painful for two weeks", // patient
    "how bad is it on a scale of one to ten",           // clinician
    "probably an eight out of ten when I reach overhead", // patient (follow-up)
    "let's check your range, shoulder flexion is 95 degrees", // clinician (ROM)
    "and my lower back gets stiff after sitting",        // patient
  ];
  const r = PR.refineTranscript(convo);

  check("dialogue keeps every turn", r.dialogue.length === 6, `${r.dialogue.length}`);
  const speakers = r.dialogue.map((d) => d.speaker);
  check("clinician turns detected", speakers[0] === "clinician" && speakers[2] === "clinician" && speakers[4] === "clinician", JSON.stringify(speakers));
  check("patient turns detected", speakers[1] === "patient" && speakers[3] === "patient" && speakers[5] === "patient", JSON.stringify(speakers));

  const keys = r.findings.map((f) => f.key);
  check("finding: right shoulder from patient", keys.includes("Shoulder|right"), JSON.stringify(keys));
  check("finding: lower back from patient", keys.includes("Lower back|"), JSON.stringify(keys));
  check("no finding invented from clinician's ROM line",
    !r.findings.some((f) => /Mentioned this area/.test(f.summary)), JSON.stringify(r.findings.map((f) => f.summary)));

  const shoulder = r.findings.find((f) => f.key === "Shoulder|right");
  check("shoulder finding carries pain + rating", shoulder && /pain/i.test(shoulder.summary) && /8\/10/.test(shoulder.summary), shoulder && shoulder.summary);
  check("shoulder finding has front-view coordinates", shoulder && shoulder.view === "front" && typeof shoulder.x === "number");
  check("lower back finding is back view", r.findings.find((f) => f.key === "Lower back|").view === "back");
  check("findings link to their patient turn indices", shoulder && shoulder.turns.includes(1), shoulder && JSON.stringify(shoulder.turns));
}

/* ---- clinician-only transcript yields no findings ---- */
{
  const r = PR.refineTranscript(["let's begin", "push into my hand", "now relax and breathe"]);
  check("all-clinician convo → zero findings", r.findings.length === 0, JSON.stringify(r.findings));
  check("all-clinician convo still keeps dialogue", r.dialogue.length === 3);
}

/* ---- coordForName re-pins saved findings to the current mannequin ---- */
{
  const a = PR.coordForName("Shoulder", "left");
  check("coordForName: left shoulder → front view", a.view === "front" && a.part === "Shoulder");
  const b = PR.coordForName("Lower back", null);
  check("coordForName: lower back → back view", b.view === "back");
  const c = PR.coordForName("left knee", "left"); // free-form name
  check("coordForName: parses free-form 'left knee'", c.part === "Knee" && c.view === "front");
  const l = PR.coordForName("Shoulder", "left");
  const rr = PR.coordForName("Shoulder", "right");
  check("coordForName: left and right differ on the figure", l.x !== rr.x, `${l.x} vs ${rr.x}`);
}

/* ---- Tagalog conversation ---- */
{
  const r = PR.refineTranscript([
    "saan ang masakit",                          // clinician (question)
    "masakit ang kanang tuhod ko kapag naglalakad", // patient
  ]);
  check("tl: clinician question detected", r.dialogue[0].speaker === "clinician");
  check("tl: patient knee finding", r.findings.some((f) => f.key === "Knee|right"), JSON.stringify(r.findings.map((f) => f.key)));
}

const total = passed + failures.length;
console.log(`\nTheraChart refiner checker: ${passed}/${total} checks passed`);
if (failures.length) { console.log("\n" + failures.join("\n") + "\n"); process.exit(1); }
