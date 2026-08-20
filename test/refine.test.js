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

  // section text + measurements (the AI now updates the note's fields too)
  check("subjective built from patient statements only",
    /right shoulder/i.test(r.subjective) && /lower back/i.test(r.subjective) && !/scale of one to ten/i.test(r.subjective), r.subjective);
  check("clinician ROM read-out captured as a measurement",
    r.measurements.rom.some((m) => m.joint === "shoulder" && m.degrees === 95), JSON.stringify(r.measurements.rom));
  check("patient pain ratings captured as measurements",
    r.measurements.pain.length >= 1, JSON.stringify(r.measurements.pain));
}

{
  // treatment sentences the therapist narrates are captured for the summary
  const r = PR.refineTranscript([
    "how is the shoulder today",
    "still a bit sore about a four out of ten",
    "we performed scaption three sets and manual therapy to the posterior capsule",
    "then reviewed the home exercise program",
  ]);
  check("treatment summary captured from interventions",
    /scaption/i.test(r.treatment) && /manual therapy/i.test(r.treatment), r.treatment);
  check("treatment not mixed into subjective",
    !/scaption/i.test(r.subjective), r.subjective);
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

/* ---- corrections: a later statement beats an earlier one ----
   The live pass pins what it hears the moment it hears it. When the patient
   corrects themselves three lines later, the cleanup is the only chance to
   take the first version off the chart. ---- */
{
  const r = PR.refineTranscript([
    "so tell me what brings you in",
    "i have chest pain that started last week",
    "how bad is it",
    "about a seven out of ten",
    "sorry actually i meant my arm not my chest",
    "my right arm aches when i lift it",
  ]);
  const t = r.corrections.find((x) => x.key === "Chest|");
  check("correction: the chest is taken back", !!t, JSON.stringify(r.corrections));
  check("correction: says what replaced it", t && /arm/i.test(t.supersededBy || ""), t && t.supersededBy);
  check("correction: reason is readable", t && /corrected/i.test(t.reason), t && t.reason);
  check("correction: the chest finding is flagged, not silently deleted",
    r.findings.some((f) => f.key === "Chest|" && f.corrected === true),
    JSON.stringify(r.findings.map((f) => [f.key, f.corrected])));
  check("correction: the corrected region survives",
    r.findings.some((f) => f.key === "Arm|right" && !f.corrected),
    JSON.stringify(r.findings.map((f) => f.key)));
  check("correction: the line that corrects it is never trimmed",
    r.dialogue.find((d) => /i meant my arm/i.test(d.text)).keep === true);
}
{
  const r = PR.refineTranscript([
    "my left knee has been aching all week",
    "no wait it's not the left knee, it's the right one",
  ]);
  check("correction: 'not the left, the right' swaps sides",
    r.corrections.some((x) => x.key === "Knee|left"), JSON.stringify(r.corrections.map((x) => x.key)));
}
{
  // A denial is a finding, not a correction — this must NOT retract anything.
  const r = PR.refineTranscript([
    "my left knee has been aching all week",
    "i have no pain in the right knee",
  ]);
  check("a denial is not a correction", r.corrections.length === 0, JSON.stringify(r.corrections));
}
{
  // "actually" on its own ADDS a complaint; it must not take one away.
  const r = PR.refineTranscript([
    "my left shoulder is sore",
    "actually my right hip hurts too",
  ]);
  check("'actually … too' adds without retracting", r.corrections.length === 0, JSON.stringify(r.corrections));
}

/* ---- trimming: lines that carry nothing come out of the record ---- */
{
  const keepOf = (s) => PR.turnSubstance(s).keep;
  check("trim: backchannel goes", keepOf("okay") === false && keepOf("mm-hmm") === false);
  check("trim: greeting goes", keepOf("good morning") === false);
  check("trim: logistics goes", keepOf("the traffic on the way here was terrible") === false);
  check("trim: a bare mention goes", keepOf("and my knee") === false);
  check("trim: the bare-mention reason names the region",
    /knee/i.test(PR.turnSubstance("and my knee").reason), PR.turnSubstance("and my knee").reason);
  check("trim: a symptom stays", keepOf("my knee aches when I climb stairs") === true);
  check("trim: a rating with no body part stays", keepOf("it is about a seven out of ten") === true);
  check("trim: a clinician question stays", keepOf("where does it hurt the most") === true);
  check("trim: a measurement read-out stays", keepOf("shoulder flexion is 95 degrees") === true);
  check("trim: an unclassifiable sentence is kept, not guessed away",
    keepOf("my daughter drove me here after work today") === true);
}
{
  const r = PR.refineTranscript([
    "good morning how are you",
    "okay lang po",
    "my right knee hurts going down stairs",
    "and my elbow",
  ]);
  check("trim: dialogue carries keep flags", r.dialogue.every((d) => typeof d.keep === "boolean"));
  check("trim: the substantive line is kept",
    r.dialogue.find((d) => /right knee/i.test(d.text)).keep === true);
  check("trim: the bare elbow line is dropped",
    r.dialogue.find((d) => /elbow/i.test(d.text)).keep === false);
  check("trim: the bare elbow finding is marked empty",
    r.findings.find((f) => f.key === "Elbow|").bare === true,
    JSON.stringify(r.findings.map((f) => [f.key, f.bare])));
  check("trim: the knee finding is not marked empty",
    r.findings.find((f) => f.key === "Knee|right").bare === false);
  check("trim: filler stays out of the Subjective",
    !/okay lang/i.test(r.subjective) && /right knee/i.test(r.subjective), r.subjective);
}

/* ---- the live pass's own mistakes, from a real dictation session ----
   Everything below came off one screenshot: an arm pinned from a worked
   example, a neck pinned out of a sentence about the app, and a posterior
   complaint filed on the front of the body. ---- */
{
  const r = PR.refineTranscript([
    "okay so let me show you how this works",
    "so how is your like you could say like oh my right arm is in a lot of pain",
    "so it highlights that and then my my neck is maybe like 3 out of 10 pain",
    "the back of my left leg is somewhat stiff",
  ]);
  const keys = r.findings.filter((f) => !f.corrected).map((f) => f.key);

  check("demo line is dropped as app commentary",
    r.dialogue[0].keep === false && /app/i.test(r.dialogue[0].dropReason), JSON.stringify(r.dialogue[0]));
  check("a worked example never becomes a finding",
    !keys.includes("Arm|right"), JSON.stringify(keys));
  check("…and is labelled the clinician, not the patient",
    r.dialogue[1].speaker === "clinician", r.dialogue[1].speaker);
  check("…and is dropped as an example",
    r.dialogue[1].keep === false && /example/i.test(r.dialogue[1].dropReason), JSON.stringify(r.dialogue[1]));

  // half commentary, half a real report — the line stays, the commentary goes
  const neck = r.dialogue.find((d) => /neck/i.test(d.text));
  check("a half-commentary line keeps its finding", neck && neck.keep === true, JSON.stringify(neck));
  check("…with the app commentary cut out of the text",
    neck && !/highlight/i.test(neck.text), neck && neck.text);
  check("…and the stutter collapsed", neck && !/my my/i.test(neck.text), neck && neck.text);
  check("…and the filler gone", neck && !/\blike\b/i.test(neck.text), neck && neck.text);
  check("…and the neck finding still recorded", keys.includes("Neck|"), JSON.stringify(keys));

  const arm = (r.corrections || []).find((c) => c.key === "Arm|right");
  check("…and the live pass's arm pin is offered for removal",
    !!arm && arm.kind === "hypothetical", JSON.stringify(r.corrections));

  check("'the back of my left leg' is the left hamstring, on the back view",
    keys.includes("Hamstring|left"), JSON.stringify(keys));
  check("…and not a generic front-view leg", !keys.some((k) => k.startsWith("Leg|")), JSON.stringify(keys));
}
{
  const r = PR.refineTranscript([
    "kunwari masakit ang aking balikat",
    "pero talaga masakit ang aking tuhod",
  ]);
  const t = (r.corrections || []).find((x) => x.key === "Shoulder|");
  check("tl: 'kunwari' marks the shoulder as hypothetical", !!t && t.kind === "hypothetical",
    JSON.stringify(r.corrections));
  check("tl: the real complaint survives",
    r.findings.some((f) => f.key === "Knee|" && !f.corrected), JSON.stringify(r.findings.map((f) => f.key)));
}
{
  /* An example runs to the end of its CLAUSE. One sentence that supposes one
     region and then reports another must keep the report — dropping the whole
     line would lose a real complaint to fix a false one. */
  const r = PR.refineTranscript([
    "kunwari masakit ang aking balikat pero talaga masakit ang kanang tuhod ko",
  ]);
  const line = r.dialogue[0];
  check("a half-example line is kept", line.keep === true, JSON.stringify(line));
  check("…the supposed region is flagged",
    (r.corrections || []).some((c) => c.key === "Shoulder|" && c.kind === "hypothetical"),
    JSON.stringify(r.corrections));
  check("…and the reported one is filed, with its side",
    r.findings.some((f) => f.key === "Knee|right" && !f.corrected),
    JSON.stringify(r.findings.map((f) => f.key)));

  const ranges = PR.hypotheticalRanges("kunwari masakit ang balikat pero masakit ang tuhod");
  check("the example range stops at the contrast break", ranges.length === 1
    && /balikat\s*$/.test("kunwari masakit ang balikat pero masakit ang tuhod".slice(ranges[0][0], ranges[0][1])),
    JSON.stringify(ranges));
}

{
  // the commonest live-pass error of all: the CLINICIAN names a region, and
  // the map pins it as though the patient had complained of it
  const r = PR.refineTranscript([
    "okay let me check your right shoulder now",
    "my left knee is what actually hurts",
  ]);
  const t = (r.corrections || []).find((c) => c.key === "Shoulder|right");
  check("a region only the clinician named is offered for removal",
    !!t && t.kind === "not-the-patient", JSON.stringify(r.corrections));
  check("…and the patient's own complaint is untouched",
    r.findings.some((f) => f.key === "Knee|left" && !f.corrected),
    JSON.stringify(r.findings.map((f) => f.key)));
}
{
  // but a region the clinician ASKS about and the patient confirms is real
  const r = PR.refineTranscript([
    "does your right shoulder hurt",
    "yes my right shoulder is sore when I reach up",
  ]);
  check("a region the clinician asks about and the patient confirms is kept",
    r.findings.some((f) => f.key === "Shoulder|right" && !f.corrected)
      && !(r.corrections || []).some((c) => c.key === "Shoulder|right"),
    JSON.stringify({ f: r.findings.map((x) => x.key), c: r.corrections }));
}

/* ---- Tagalog and Cebuano carry their own weight ---- */
{
  const P2 = require("../parser.js");
  const FILIPINO = [
    ["nangangalay ang balikat ko", "Shoulder", /numb/i],
    ["pagod na pagod ang katawan ko", null, /fatigue/i],
    ["hirap akong yumuko", null, /difficulty/i],
    ["hindi ko maigalaw ang kamay ko", "Hand", /difficulty/i],
    ["nagmamanhid ang mga daliri ko", "Finger", /numb/i],
    ["gasakit akong tuhod", "Knee", /pain/i],
    ["nagngutngot ang akong abaga", "Shoulder", /throb/i],
    ["nag-init ang akong bat-ang", "Hip", /warmth/i],
    ["naglagutok ang tuhod ko", "Knee", /click/i],
    ["nalilipong ako kapag tumatayo", null, /dizz/i],
    ["walang lakas ang aking braso", "Arm", /weak/i],
    ["dili ko makalihok ang akong liog", "Neck", /difficulty/i],
    ["matindi ang sakit ng aking likod", "Back", /significant/i],
    ["bahagya lang ang sakit ng tuhod ko", "Knee", /mild/i],
    ["sakit kaayo ang akong bat-ang sukad niadtong Lunes", "Hip", /significant/i],
    ["ang likod ng kaliwang binti ko ay medyo matigas", "Calf", /stiff/i],
  ];
  const bad = [];
  for (const [phrase, part, re] of FILIPINO) {
    const u = P2.parseUtterance(phrase);
    const hit = part ? u.mentions.find((m) => m.partName === part) : u.loose;
    if (!hit || !re.test(hit.summary)) bad.push(`"${phrase}" → ${hit ? hit.summary : "(nothing)"}`);
  }
  check(`Filipino symptom vocabulary: all ${FILIPINO.length} phrases understood`,
    bad.length === 0, bad.join("; "));

  const side = P2.parseUtterance("ang likod ng kaliwang binti ko ay medyo matigas")
    .mentions.find((m) => m.partName === "Calf");
  check("tl: laterality inside the phrase is still read", side && side.side === "left", side && side.side);
  check("ceb: 'kanang tuhod' keeps its right side — it is not filler",
    (P2.parseUtterance("masakit ang kanang tuhod ko").mentions[0] || {}).side === "right");
}


/* ---- the model names the region; the parser owns the anatomy ---- *
   The body map has a front figure and a back one and chooses between them
   from the region NAME. So a model that reads "the back of my left leg"
   correctly and then labels it "Thigh" — which is what Gemini does — puts a
   posterior complaint on the front of the body. The label is re-read against
   the words it was drawn from, and only a limb is allowed to move, so a
   summary that merely contains the word "back" can never relocate a knee. */
{
  const AI = require("../ai.js");
  const norm = (findings) => AI.normalizeRefinement({ dialogue: [], findings }, [], "gemini").findings[0];

  const moved = norm([{ bodyPart: "Thigh", side: "left",
    summary: "Tightness and pulling aggravated by bending forward",
    sourceQuote: "the back of my left leg, from my butt down to my calf" }]);
  check("posterior: a 'thigh' quoted from the back of the leg becomes the hamstring",
    moved.part === "Hamstring", JSON.stringify(moved));
  check("posterior: …and lands on the back view", moved.view === "back", JSON.stringify(moved));
  check("posterior: …keeping the side the model gave it", moved.side === "left", JSON.stringify(moved));

  const tl = norm([{ bodyPart: "Leg", side: "left", summary: "Masakit",
    sourceQuote: "masakit ang likod ng kaliwang binti ko" }]);
  check("posterior: the Tagalog posterior phrase moves it too",
    tl.part === "Calf" && tl.view === "back", JSON.stringify(tl));

  // …and the guard stays shut on everything else
  const stays = norm([{ bodyPart: "Knee", side: "right", summary: "Pain",
    sourceQuote: "it is worse when I lie on my back" }]);
  check("posterior: a knee is not relocated by the word 'back'",
    stays.part === "Knee" && stays.view === "front", JSON.stringify(stays));

  const anterior = norm([{ bodyPart: "Thigh", side: "left", summary: "Pain at the front of the thigh",
    sourceQuote: "the front of my left thigh burns" }]);
  check("posterior: an anterior thigh stays on the front",
    anterior.part === "Thigh" && anterior.view === "front", JSON.stringify(anterior));

  const already = norm([{ bodyPart: "Lower back", side: "none", summary: "Stiff",
    sourceQuote: "my lower back is stiff in the morning" }]);
  check("posterior: a region already on the back view is left alone",
    already.part === "Lower back", JSON.stringify(already));
}

/* ---- an imported record keeps its laterality ---- *
   ROM carried a side and strength did not, so "MMT R shoulder abduction 3+/5"
   arrived belonging to neither arm. */
{
  const AI = require("../ai.js");
  const e = AI.normalizeExtraction({ patientName: "Reyes, Juan", docDescription: "", visits: [{
    date: "2023-05-02", type: "eval", subjective: "R shoulder pain", objective: "", assessment: "", treatment: "",
    mmt: [{ side: "right", context: "shoulder abduction", grade: "3+/5" }],
    pain: [{ side: "right", location: "shoulder", score: 8 }],
  }] });
  check("import: a strength grade keeps its side", e.visits[0].mmt[0].side === "right", JSON.stringify(e.visits[0].mmt));
  check("import: a pain rating keeps its side", e.visits[0].pain[0].side === "right", JSON.stringify(e.visits[0].pain));
  const none = AI.normalizeExtraction({ visits: [{ date: "", type: "daily", subjective: "x", objective: "", assessment: "", treatment: "",
    mmt: [{ side: "none", grade: "4/5" }] }] });
  check("import: 'none' normalizes to no side", none.visits[0].mmt[0].side === null, JSON.stringify(none.visits[0].mmt));
}

const total = passed + failures.length;
console.log(`\nTheraChart refiner checker: ${passed}/${total} checks passed`);
if (failures.length) { console.log("\n" + failures.join("\n") + "\n"); process.exit(1); }
