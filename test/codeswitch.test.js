/* TheraChart code-switching checker — Tagalog, Cebuano, and the mix.

   A Philippine clinic does not speak one language at a time. A visit runs in
   Taglish and Bisaya-English by default: "doc, masakit yung right shoulder ko
   for like two weeks na po" is not an edge case, it is the register. Every
   rule that decides what reaches the note has to work in it, and the English
   adversarial pass proved nothing about that.

   It proved less than nothing, in one place. English marks possession BEFORE
   the noun — "my wife", "my daughter's knee" — and the third-party rule was
   written to match. Tagalog and Cebuano mark it AFTER: "asawa ko" is my
   spouse, "likod niya" is their back, "akong bana" is my husband. The
   enclitic `ko` in "asawa ko" sits exactly where an English self-claim would,
   so the rule read every Filipino sentence about a relative's body as the
   patient's own. "Yung asawa ko po, masakit din ang likod niya" filed a back
   on this patient's chart.

   The mirror of that is `niya` itself, which means his/her and nothing about
   whose: a therapist dictating "namamaga ang kanang kamay NIYA" means the
   person in front of them. Only a named person makes it a third party.

   Run: node test/codeswitch.test.js */

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
function liftConst(name) {
  const m = new RegExp(`^  const ${name} = .*$`, "m").exec(SRC);
  if (!m) throw new Error(`app.js no longer declares: ${name}`);
  return m[0];
}

const TREAT_RE = /\b(performed|completed|exercis\w*|therex|sets?|reps?|ultrasound|massage|stretch\w*|mobilizat\w*|manual therapy|gait|ice|heat|e-?stim\w*|modalit\w*|educat\w*|hep|home program|tens)\b/i;

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

/** Every note field one utterance writes into. */
function filed(type, text, speaker) {
  const out = [];
  for (const sentence of ROUTER.splitSentences(text)) {
    const clinical = PR.trimToClinical(sentence);
    if (!clinical) continue;
    const field = ROUTER.fieldForSentence(type, clinical, speaker);
    if (field) out.push(field);
  }
  return out;
}
const pins = (t) => PR.parseUtterance(t).mentions.filter((m) => !m.bare)
  .map((m) => `${m.side ? m.side + " " : ""}${m.partName}`);

/* ================================================================== *
 * 1. Noise, in the languages it is actually spoken in
 * ================================================================== */
const NOISE = [
  ["TL greeting", "Magandang umaga po, kumusta na kayo?"],
  ["CEB greeting", "Maayong buntag doc, kumusta ka?"],
  ["TL thanks", "Salamat po, ingat kayo palagi."],
  ["CEB thanks", "Daghang salamat doc, ha."],
  ["TL traffic", "Grabe po ang traffic kanina sa EDSA, dalawang oras ako sa daan."],
  ["CEB weather", "Ulan kaayo gabii, wala koy masakyan pauli."],
  ["TL payment", "Magkano po ang bayad ngayon, sa front desk ba?"],
  ["CEB payment", "Asa man ko mubayad, sa front desk?"],
  ["TL reschedule", "Sa susunod na linggo na lang po ulit ako babalik."],
  ["TL family news", "Ikakasal po yung anak ko sa susunod na buwan sa Cebu."],
  ["CEB fiesta", "Naa mi fiesta sa amoa sunod nga semana."],
  ["Taglish traffic", "Grabe yung traffic kanina, like two hours ako sa daan."],
  ["Taglish wedding", "Ikakasal yung daughter ko next month, super busy po kami."],
  ["Taglish logistics", "Sa next week na lang po yung follow-up ko, may lakad kasi ako."],
];
for (const [label, text] of NOISE) {
  check(`noise files nowhere: ${label}`, filed("eval", text).length === 0,
    `${text} → ${JSON.stringify(filed("eval", text))}`);
  check(`noise pins nothing: ${label}`, pins(text).length === 0,
    `${text} → ${JSON.stringify(pins(text))}`);
}

/* ================================================================== *
 * 2. Possession, marked after the noun
 * ================================================================== */
{
  const others = [
    ["TL wife's back", "Yung asawa ko po, masakit din ang likod niya."],
    ["TL child's knee", "Ang anak ko po na-opera sa tuhod noong isang taon."],
    ["CEB husband's shoulder", "Ang akong bana, sakit sad iyang abaga."],
    ["Bisaya-English spouse", "Ang akong asawa, sakit sad iyang back, mag-pa-check unta siya."],
    ["TL sibling", "Yung kapatid ko po, nabali ang braso niya noong bata pa siya."],
  ];
  for (const [label, text] of others) {
    check(`someone else's body pins nothing: ${label}`, pins(text).length === 0,
      `${text} → ${JSON.stringify(pins(text))}`);
    check(`someone else's body files nowhere: ${label}`, filed("eval", text).length === 0,
      `${text} → ${JSON.stringify(filed("eval", text))}`);
  }

  /* `niya` is "his/her" and says nothing about whose. A therapist dictating
     about the patient uses it constantly; only a NAMED person makes it a
     third party. Both directions have to hold, or one of them breaks. */
  check("the therapist's 'niya' still means the patient",
    pins("Namamaga at manhid ang kanang kamay niya.").some((p) => /Hand/.test(p)),
    JSON.stringify(pins("Namamaga at manhid ang kanang kamay niya.")));
  check("the therapist's 'niya' under negation still means the patient",
    /denies/i.test((PR.parseUtterance("Walang sakit ang kanang tuhod niya ngayon.")
      .mentions.find((m) => m.partName === "Knee") || {}).summary || ""));
  check("the patient's 'niya' after naming a relative does not",
    pins("Yung asawa ko po, masakit ang tuhod niya.").length === 0,
    JSON.stringify(pins("Yung asawa ko po, masakit ang tuhod niya.")));

  // a relative who is only the one talking must not block the patient
  check("a relative doing the talking does not block the patient",
    pins("Sabi ng asawa ko, masakit daw ang likod ko.").length > 0,
    JSON.stringify(pins("Sabi ng asawa ko, masakit daw ang likod ko.")));
}

/* ================================================================== *
 * 3. Filipino figures of speech that name a body part
 * ================================================================== */
{
  const idioms = [
    ["sakit sa ulo", "Sakit sa ulo talaga yung HMO paperwork."],
    ["sakit sa ulo (CEB)", "Sakit sa ulo ang mga papeles diri."],
    ["Taglish sakit sa ulo", "Sobrang sakit sa ulo yung HMO paperwork, ang hassle talaga."],
    ["masakit sa bulsa", "Masakit sa bulsa yung gamot, ang mahal."],
    ["makapal ang mukha", "Makapal talaga ang mukha ng kapitbahay namin."],
  ];
  for (const [label, text] of idioms) {
    check(`idiom pins nothing: ${label}`, pins(text).length === 0,
      `${text} → ${JSON.stringify(pins(text))}`);
    check(`idiom files nowhere: ${label}`, filed("eval", text).length === 0,
      `${text} → ${JSON.stringify(filed("eval", text))}`);
  }
  // and the literal reading, which puts the possessive on the part, survives
  check("a real headache is not an idiom",
    filed("eval", "Masakit po ang ulo ko tuwing umaga.", "patient").length > 0,
    JSON.stringify(filed("eval", "Masakit po ang ulo ko tuwing umaga.", "patient")));
}

/* ================================================================== *
 * 4. The therapist's own voice, in Filipino
 * ================================================================== */
{
  const cues = [
    ["TL cue", "Saan po ba masakit? Ituro niyo sa akin."],
    ["TL cue 2", "Sige po, huminga kayo ng malalim at mag-relax."],
    ["CEB cue", "Asa masakit? Itudlo nako palihug."],
    ["CEB cue 2", "Sulayi pagtaas sa imong bukton, ayaw pugngi."],
    ["Taglish cue", "Okay po, i-push niyo against my hand, wag niyo akong patalsikin."],
  ];
  for (const [label, text] of cues) {
    check(`clinician cue files nowhere: ${label}`, filed("eval", text, "clinician").length === 0,
      `${text} → ${JSON.stringify(filed("eval", text, "clinician"))}`);
  }
  /* The hyphenated verb cuts both ways: "I-LIFT niyo" is an instruction and
     "hindi ko po MA-LIFT" is a complaint, and they share a stem. The
     second-person pronoun is what separates them. */
  check("a Taglish imperative reads as the clinician",
    PR.guessSpeaker("Sige po, i-push niyo against my hand, wag niyo akong patalsikin.") === "clinician");
  check("a Cebuano imperative reads as the clinician",
    PR.guessSpeaker("Palihug itaas ang imong bukton.") === "clinician");
  check("a Taglish imperative pins nothing",
    pins("Sige po, i-push niyo against my hand, wag niyo akong patalsikin.").length === 0,
    JSON.stringify(pins("Sige po, i-push niyo against my hand, wag niyo akong patalsikin.")));
  check("the same verb stem in the patient's mouth is still a complaint",
    PR.guessSpeaker("Hindi ko po ma-lift yung arm ko lalo na sa umaga.") === "patient"
    && PR.noteWorthy("Hindi ko po ma-lift yung arm ko lalo na sa umaga.").file === true);

  // an observation in Filipino is objective, not the patient's own report
  const obs = filed("eval", "Mas mataas yung right shoulder niya compared sa left.", "clinician");
  check("a Filipino observation goes to Objective",
    obs.length === 1 && obs[0] === "objectiveText", JSON.stringify(obs));
  check("a Filipino observation reads as the clinician speaking",
    PR.guessSpeaker("Mas mataas yung right shoulder niya compared sa left.") === "clinician");
}

/* ================================================================== *
 * 5. Real clinical content, in every register
 * ================================================================== */
{
  const wants = [
    ["subjective", "Masakit po ang kanang balikat ko mga dalawang linggo na."],
    ["subjective", "Mga pito sa sampu po ang sakit kapag umaabot ako sa taas."],
    ["subjective", "Hindi ko po maisuot ang medyas ko sa umaga."],
    ["subjective", "Sakit kaayo akong tuo nga abaga mga duha ka semana na."],
    ["subjective", "Dili ko kaya mag-suot og medyas sa buntag."],
    ["precautions", "Sabi po ng doktor, bawal akong magbuhat ng mabigat."],
    ["pmh", "Na-diagnose po ako ng diabetes mga sampung taon na."],
    // and the same things said in the mix
    ["subjective", "Doc, masakit yung right shoulder ko for like two weeks na po."],
    ["subjective", "Yung pain ko po is mga seven out of ten kapag nag-rereach ako overhead."],
    ["subjective", "Hindi ko po ma-lift yung arm ko lalo na sa umaga."],
    ["precautions", "Sabi ng surgeon ko, no lifting daw po over five kilos for six weeks."],
    ["pmh", "Na-diagnose po ako ng diabetes like ten years ago."],
    ["reason", "Si Dr. Santos po ang nag-refer sa akin for the right shoulder."],
    ["assessment", "Consistent po ito sa rotator cuff impingement."],
  ];
  for (const [field, text] of wants) {
    const got = filed("eval", text, field === "assessment" ? "clinician" : "patient");
    check(`files to ${field}: ${text.slice(0, 38)}…`, got.includes(field), JSON.stringify(got));
  }

  check("a Taglish complaint still pins the region",
    pins("Doc, masakit yung right shoulder ko for like two weeks na po.").some((p) => /Shoulder/.test(p)),
    JSON.stringify(pins("Doc, masakit yung right shoulder ko for like two weeks na po.")));
  check("a Cebuano complaint still pins the region",
    pins("Sakit kaayo akong tuo nga abaga mga duha ka semana na.").some((p) => /Shoulder/.test(p)),
    JSON.stringify(pins("Sakit kaayo akong tuo nga abaga mga duha ka semana na.")));
}

/* ================================================================== *
 * 6. A whole visit, code-switched throughout
 * ================================================================== */
{
  const visit = [
    "magandang umaga po, kumusta na kayo",
    "okay lang po salamat, grabe lang yung traffic kanina",
    "ikakasal po yung anak ko next month sa Cebu, super busy kami",
    "si Dr. Santos po ang nag-refer sa akin for the right shoulder",
    "doc, masakit yung right shoulder ko for like two weeks na po",
    "yung pain ko po is mga seven out of ten kapag nag-rereach ako overhead",
    "hindi ko po ma-lift yung arm ko lalo na sa umaga",
    "yung asawa ko po, masakit din ang likod niya, magpapa-check din sana siya",
    "sobrang sakit sa ulo yung HMO paperwork, ang hassle talaga",
    "sabi ng surgeon ko, no lifting daw po over five kilos for six weeks",
    "na-diagnose po ako ng diabetes like ten years ago",
    "sige po, i-push niyo against my hand, wag niyo akong patalsikin",
    "mas mataas yung right shoulder niya compared sa left",
    "shoulder flexion is 95 degrees on the right",
    "consistent po ito sa rotator cuff impingement",
    "magkano po pala ang bayad, sa front desk ba",
  ];
  const r = PR.refineTranscript(visit);

  check("visit: reason drafted", /nag-refer/i.test(r.reason || ""), r.reason);
  check("visit: precautions drafted", /no lifting/i.test(r.precautions || ""), r.precautions);
  check("visit: history drafted", /diabetes/i.test(r.pmh || ""), r.pmh);
  check("visit: subjective drafted", /right shoulder/i.test(r.subjective || ""), r.subjective);
  check("visit: objective drafted", /mas mataas/i.test(r.objective || ""), r.objective);
  check("visit: assessment drafted", /impingement/i.test(r.assessment || ""), r.assessment);
  check("visit: the ROM read-out is a measurement",
    r.measurements.rom.some((m) => m.degrees === 95), JSON.stringify(r.measurements.rom));

  const everySection = [r.reason, r.precautions, r.pmh, r.subjective, r.objective, r.assessment].join(" ");
  for (const [label, needle] of [
    ["the greeting", /magandang umaga|kumusta/i],
    ["the traffic", /traffic/i],
    ["the wedding", /ikakasal|super busy/i],
    ["the spouse's back", /asawa|likod niya/i],
    ["the idiom", /sakit sa ulo|hassle/i],
    ["the cue", /i-push|patalsikin/i],
    ["the payment", /bayad|front desk/i],
  ]) {
    check(`visit: ${label} reached no section`, !needle.test(everySection), everySection);
  }

  check("visit: the spouse's back is not a finding",
    !r.findings.some((f) => /Back|Lower back/.test(f.part) && !f.bare),
    JSON.stringify(r.findings.map((f) => [f.key, f.bare])));
  check("visit: the clinician's cue left no pin",
    !r.findings.some((f) => f.part === "Hand"),
    JSON.stringify(r.findings.map((f) => [f.key, f.bare])));
  check("visit: the patient's shoulder IS a finding",
    r.findings.some((f) => f.key === "Shoulder|right" && !f.bare),
    JSON.stringify(r.findings.map((f) => [f.key, f.bare])));
  check("visit: the transcript keeps every line",
    r.dialogue.length === visit.length, `${r.dialogue.length} of ${visit.length}`);
  check("visit: the greeting is trimmed from the transcript",
    r.dialogue.find((d) => /magandang umaga/i.test(d.text)).keep === false);
  check("visit: every trimmed line says why",
    r.dialogue.filter((d) => d.keep === false).every((d) => (d.dropReason || "").trim()),
    JSON.stringify(r.dialogue.filter((d) => d.keep === false).map((d) => [d.text, d.dropReason])));
}

const total = passed + failures.length;
console.log(`\nTheraChart code-switching checker: ${passed}/${total} checks passed`);
if (failures.length) { console.log("\n" + failures.join("\n") + "\n"); process.exit(1); }
