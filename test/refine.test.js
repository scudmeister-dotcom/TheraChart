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

/* Dictation has no question mark, so the question WORD is the whole signal.
   Without these, "so who sent you to us today" and "what brings you in" read
   as the patient talking — and a clinician's screening question then became
   the patient's symptom. */
for (const t of [
  "so who sent you to us today", "who referred you", "who told you to come in",
  "what brings you in today", "when did it start", "which knee is it",
  "why does it hurt more at night",
]) check(`unpunctuated question → clinician: ${t}`, PR.guessSpeaker(t) === "clinician");

/* The Filipino and Cebuano yes/no question. "Naa kay numbness sa tiil" is the
   therapist screening for numbness; charting it filed numbness in the foot
   that the patient had just denied. */
for (const t of ["may sakit po ba kayo dati", "may bawal po ba sa inyo", "naa kay numbness sa tiil", "naa bay nag-igo nimo"])
  check(`tl/ceb screening question → clinician: ${t}`, PR.guessSpeaker(t) === "clinician");

/* …and the same words in a patient's own report stay the patient's. The cost
   of getting this backwards is a symptom silently kept out of Subjective. */
for (const t of [
  "may sakit ako sa balikat ko", "may namamaga po sa tuhod ko", "meron akong pananakit sa likod",
  "naa koy sakit sa akong tuhod", "naa koy numbness sa akong tiil",
  "who sent me was my company doctor",
]) check(`a report that only looks like a question → patient: ${t}`, PR.guessSpeaker(t) === "patient");

/* The companion who says out loud that they are not the patient. */
{
  const c = PR.parseUtterance("tapos ako po, masakit din ang likod ko, pero hindi po ako ang pasyente");
  check("companion: their own back is not this patient's finding", c.mentions.length === 0, JSON.stringify(c.mentions));
  check("companion: …and it is recorded as not the patient's", c.notMine.length === 1, JSON.stringify(c.notMine));
  const m = PR.parseUtterance("masakit daw po ang kaliwang tuhod niya, mga isang buwan na");
  check("companion: the patient's own knee is still charted",
    (m.mentions[0] || {}).partName === "Knee" && m.mentions[0].side === "left", JSON.stringify(m.mentions));
}

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


/* ---- the two places a failure could still go quiet ---- */
{
  const fs2 = require("fs"), path2 = require("path");
  const APP = fs2.readFileSync(path2.join(__dirname, "..", "app.js"), "utf8");
  const SYNC = fs2.readFileSync(path2.join(__dirname, "..", "sync.js"), "utf8");

  const runRefine = APP.slice(APP.indexOf("async function runRefine("), APP.indexOf("function refineFailed("));
  check("runRefine turns away a failed review instead of showing it",
    /if \(result\.aiFailed\)\s*\{[\s\S]{0,120}refineFailed\(/.test(runRefine), runRefine.slice(-400));
  check("…and does not meter a call that never produced anything",
    runRefine.indexOf("recordDocAiCall") > runRefine.indexOf("result.aiFailed"),
    "the AI-pass meter must be below the aiFailed guard");

  const dialog = APP.slice(APP.indexOf("function refineFailed("), APP.indexOf("function openReviewModal("));
  check("the failure dialog offers a retry", /id="refineRetry"/.test(dialog));
  check("…and a cancel", /id="refineCancel"/.test(dialog));
  check("…and the retry actually re-runs the review", /runRefine\(doc, user, dstate\)/.test(dialog));
  check("…and it says the note was left alone",
    /Nothing has changed/i.test(dialog), dialog.slice(0, 200));

  /* The model behind this has changed twice already. A clinician mid-visit
     should not have to learn a vendor's name to understand what happened. */
  const flow = APP.slice(APP.indexOf("async function runRefine("), APP.indexOf("const REVIEW_SECTIONS"))
    /* `source.startsWith("gemini")` is the API's own value being tested, not
       copy — the sentinel has to keep matching what ai.js returns. Only text
       the clinician can actually read is in scope here. */
    .replace(/\.startsWith\("gemini"\)/g, "");
  check("the review flow names no model vendor to the clinician",
    !/Gemini|Google/i.test(flow),
    (flow.match(/.{0,70}(Gemini|Google).{0,70}/i) || [""])[0]);

  /* The card and the changes window describe the SAME run the modal just
     did. Renaming only the modal left one review wearing two names. */
  const card = APP.slice(APP.indexOf("function renderCleanupSummary("), APP.indexOf("async function runRefine("))
    .replace(/=== "gemini"/g, "");
  check("the applied-cleanup card agrees with the modal",
    !/Gemini|"local AI"|local review/i.test(card),
    (card.match(/.{0,70}(Gemini|local AI).{0,70}/i) || [""])[0]);

  /* …but the SIGNED RECORD still names the system. On screen a chip should
     say what the thing does; on a clinical document, someone reading it later
     needs to know what actually wrote the text, and "AI" does not answer
     that. The interface names the function, the record names the system. */
  const printed = APP.slice(APP.indexOf("AI review &amp; clean-up applied"), APP.indexOf("AI review &amp; clean-up applied") + 320);
  check("the printed attestation still names the system that wrote the text",
    /Google Gemini/.test(printed), printed.slice(0, 160));
  check("…and the audit line records the engine verbatim",
    /audit\(user\.id, "transcript-refined", `\$\{doc\.title\}: \$\{doc\.data\.refinement\.engine\}/.test(APP));

  /* ai.js only covers the call it makes itself. A request that never reached
     it — server down, session expired, our own rate limiter — failed in the
     transport layer, which used to answer with a plain `source: "local"`. */
  const st = SYNC.slice(SYNC.indexOf("sync.refineTranscript ="), SYNC.indexOf("sync.extractRecords ="));
  check("sync flags a refine that never reached the AI", /aiFailed: true/.test(st), st.slice(0, 300));
  check("…and still reports local as the engine when none is configured",
    /aiFailed: false/.test(st), st.slice(-260));
  check("…and carries a reason back for the dialog to show", /error: detail/.test(st));
}

/* ---- a call that fails must not come back looking like a review ---- *
   Every entry point in ai.js catches a failed call and answers with the local
   heuristic. The heuristic is good — it scores 97.6% on the eval — which is
   exactly what made this dangerous: a note that was never read by the model
   looked, to the therapist, almost identical to one that was, and the only
   thing distinguishing them was a muted chip beside a modal that had just
   promised them an AI review. */
{
  const AI = require("../ai.js");
  const utt = ["my left knee has been sore for two weeks", "about a six out of ten"];

  const noAi = () => AI.refine(utt, {});
  const brokenAi = (extra) => AI.refine(utt, Object.assign({
    key: "not-a-real-key", base: "http://127.0.0.1:9/unreachable", retries: 1,
  }, extra || {}));

  (async () => {
    const off = await noAi();
    check("no AI configured: the offline reviewer is the engine, not a failure",
      off.source === "local" && off.aiFailed === false, JSON.stringify({ s: off.source, f: off.aiFailed }));
    check("no AI configured: it still produces a usable review",
      Array.isArray(off.dialogue) && off.dialogue.length > 0);

    const bad = await brokenAi();
    check("AI configured but failing: the failure is stated in the result",
      bad.aiFailed === true, JSON.stringify({ s: bad.source, f: bad.aiFailed }));
    check("AI configured but failing: …with a reason the caller can show",
      typeof bad.error === "string" && bad.error.length > 0, JSON.stringify(bad.error));
    check("AI configured but failing: the source no longer claims the model",
      !/^gemini/.test(bad.source || ""), bad.source);

    /* Retry, and only for the failures worth retrying. A 429 from Vertex means
       the shared pool was busy, not that the request was wrong — Google's own
       documented handling is to back off and try again, and we did neither. */
    let calls = 0;
    const flaky = (status, n) => {
      calls = 0;
      const realFetch = global.fetch;
      global.fetch = async () => {
        calls += 1;
        if (calls <= n) return { ok: false, status, text: async () => "busy" };
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"dialogue":[],"findings":[]}' }] } }] }) };
      };
      return () => { global.fetch = realFetch; };
    };

    let restore = flaky(429, 2);
    const recovered = await AI.refine(utt, { key: "k", base: "http://x", retries: 4 });
    restore();
    check("a 429 is retried until it succeeds", recovered.source === "gemini" && calls === 3,
      JSON.stringify({ source: recovered.source, calls }));

    restore = flaky(429, 99);
    const exhausted = await AI.refine(utt, { key: "k", base: "http://x", retries: 3 });
    restore();
    check("retries are bounded, and exhausting them is a stated failure",
      exhausted.aiFailed === true && calls === 3, JSON.stringify({ f: exhausted.aiFailed, calls }));

    /* A 400 says the REQUEST was wrong — a bad model name, a malformed
       schema. Retrying spends the same money to be told the same thing. */
    restore = flaky(400, 99);
    const notRetried = await AI.refine(utt, { key: "k", base: "http://x", retries: 4 });
    restore();
    check("a 400 is not retried — the request itself was wrong",
      notRetried.aiFailed === true && calls === 1, JSON.stringify({ calls }));

    report();
  })();
}

function report() {
const total = passed + failures.length;
console.log(`\nTheraChart refiner checker: ${passed}/${total} checks passed`);
if (failures.length) { console.log("\n" + failures.join("\n") + "\n"); process.exit(1); }
}
