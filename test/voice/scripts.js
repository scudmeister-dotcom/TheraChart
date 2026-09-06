/* TheraChart voice eval — the spoken scripts.

   test/eval/cases.js grades the note from CLEAN text: the transcript it hands
   the model is exactly what the writer typed. Real dictation never arrives
   that way. Chirp 2 mishears a word or two in every visit, and the note the
   therapist signs is built on THAT text, not on the script.

   These cases close the gap. Each one is spoken out loud by ElevenLabs, sent
   through the real /api/stt, and only then handed to /api/refine — so a run
   scores the whole chain a clinician actually uses, and a regression anywhere
   in it (the phrase list, the language code, the refine prompt) shows up as a
   number instead of a hunch.

   Each script carries two kinds of expectation:

     heard    what must survive TRANSCRIPTION. `wer` is the ceiling for word
              error rate on this script; `must` are words that have to be in
              the transcript at all, because a note cannot recover a laterality
              or a body part that never arrived.

     expect   what must survive the whole chain, graded on the refine result
              exactly as test/eval/cases.js grades it. Same weights: 1 is
              ordinary, 2-3 is safety-critical.

   Scripts are deliberately SHORT. Google bills Chirp 2 by the second of audio
   submitted, and every line here is spoken on every run. */

"use strict";

/* ---------- helpers, borrowed in spirit from test/eval/cases.js ---------- */

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

/** Was a finding pinned for this region (and side, if given)? */
const hasFinding = (r, part, side) => (r.findings || []).some((f) =>
  norm(f.part) === norm(part) && (side === undefined || (f.side || null) === side));

/** Every region the note ended up pinning — for failure messages worth reading. */
const findingParts = (r) => (r.findings || []).map((f) => `${f.part}|${f.side || ""}`).join(", ") || "(none)";

const rom = (r, motion) => ((r.measurements && r.measurements.rom) || [])
  .find((m) => norm(m.motion).includes(norm(motion)));

const painScores = (r) => ((r.measurements && r.measurements.pain) || []).map((p) => Number(p.score));

/** Any prose section the model wrote, as one blob — for "did this reach the chart". */
const prose = (r) => norm([r.subjective, r.objective, r.assessment, r.treatment, r.plan,
  r.reason, r.precautions, r.pmh].filter(Boolean).join(" "));

const correctionFor = (r, part, kind) => (r.corrections || []).find((c) =>
  norm(c.part) === norm(part) && (kind === undefined || c.kind === kind));

/* ---------- the scripts ---------- */

const SCRIPTS = [

  /* 1. The vocabulary the phrase list exists for.

     STT_PHRASES in server.js boosts about thirty clinical terms because Chirp 2
     hears "MMT" as "MPT" and "therex" as "there ex". Nothing tested whether the
     boost works — the list was reasoned about, never measured. This script says
     eight of those terms out loud in one breath. */
  {
    id: "shoulder/clinical-vocab",
    lang: "fil-PH",
    why: "the boosted phrase list, spoken — MMT, AROM, Neer, Hawkins, scaption, subacromial, therex, HEP",
    turns: [
      { who: "clinician", text: "Good morning. Let us take a look at that left shoulder today." },
      { who: "patient", text: "It still hurts when I reach overhead, about seven out of ten. Worse at night." },
      { who: "clinician", text: "Left shoulder AROM in flexion is one hundred twenty degrees, abduction one hundred ten. MMT is four out of five on the rotator cuff." },
      { who: "clinician", text: "Neer and Hawkins are both positive, so this looks like subacromial impingement." },
      { who: "clinician", text: "We will do scaption in the pain free range for therex, and I am giving you a HEP to do twice a day." },
    ],
    heard: {
      wer: 0.15,
      must: ["shoulder", "overhead"],
    },
    expect: [
      { name: "the left shoulder is pinned", weight: 3,
        test: (r) => hasFinding(r, "Shoulder", "left"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "no right shoulder invented", weight: 3,
        test: (r) => !hasFinding(r, "Shoulder", "right"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "shoulder flexion ROM survived transcription", weight: 2,
        test: (r) => !!rom(r, "flexion"),
        detail: (r) => `rom: ${JSON.stringify((r.measurements || {}).rom || [])}` },
      { name: "the 7/10 pain score reached the chart", weight: 2,
        test: (r) => painScores(r).includes(7),
        detail: (r) => `pain: ${JSON.stringify(painScores(r))}` },
      { name: "the home programme reached a prose section", weight: 1,
        test: (r) => /\bhep\b|home (exercise )?program/.test(prose(r)),
        detail: (r) => `treatment: ${norm(r.treatment).slice(0, 120)}` },
    ],
  },

  /* 2. A correction, out loud.

     The `corrections` channel was built for exactly this and is graded on typed
     text today. Spoken, it is harder: the model has to notice the retraction in
     a transcript that may itself have misheard one of the two sides. Pinning
     the wrong knee is the single most consequential thing this app can do, so
     both halves are weight 3. */
  {
    id: "knee/laterality-correction",
    lang: "fil-PH",
    why: "a mid-sentence laterality correction has to move the pin, not add a second one",
    turns: [
      { who: "clinician", text: "So the right knee is the one giving you trouble." },
      { who: "patient", text: "No doctor, sorry, it is the left one. The left knee. The right one is fine." },
      { who: "clinician", text: "Let me correct that. Left knee. Pain is five out of ten going down stairs." },
      { who: "patient", text: "Yes, five out of ten, and it feels unstable when I go down." },
    ],
    heard: {
      wer: 0.15,
      must: ["left", "knee"],
    },
    expect: [
      { name: "the LEFT knee is pinned", weight: 3,
        test: (r) => hasFinding(r, "Knee", "left"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "the retracted RIGHT knee is not left standing on the chart", weight: 3,
        test: (r) => !hasFinding(r, "Knee", "right") || !!correctionFor(r, "Knee"),
        detail: (r) => `pinned: ${findingParts(r)} · corrections: ${JSON.stringify((r.corrections || []).map((c) => `${c.part}|${c.side || ""}:${c.kind}`))}` },
      { name: "the 5/10 score survived", weight: 1,
        test: (r) => painScores(r).includes(5),
        detail: (r) => `pain: ${JSON.stringify(painScores(r))}` },
    ],
  },

  /* 3. Taglish, which is what a Manila clinic actually sounds like.

     fil-PH exists in the language menu for this case and no other. The trap is
     the NEGATION: "walang numbness" is the patient denying a symptom, and a
     chain that drops "walang" turns a denial into a finding — a red flag on the
     chart that nobody reported. */
  {
    id: "back/taglish-negation",
    lang: "fil-PH",
    why: "code-switched speech, and a Tagalog negation that must not become a positive finding",
    turns: [
      { who: "clinician", text: "Kumusta po ang likod ninyo ngayon?" },
      { who: "patient", text: "Masakit pa rin po ang lower back ko, lalo na pagkagising sa umaga. Medyo matigas." },
      { who: "clinician", text: "May numbness ba o tingling na bumababa sa binti?" },
      { who: "patient", text: "Wala po. Walang numbness, walang tingling. Yung sakit lang po sa likod." },
      { who: "clinician", text: "Okay. Lumbar flexion is limited, and we will start with core stability exercises." },
    ],
    heard: {
      wer: 0.30,
      must: ["back"],
    },
    expect: [
      { name: "the low back is pinned", weight: 2,
        test: (r) => (r.findings || []).some((f) => /back|lumbar|spine/i.test(f.part)),
        detail: (r) => `pinned: ${findingParts(r)}` },
      /* Not "the denial is absent" — the refine prompt asks for denials on
         purpose and they belong in the record. The property that matters is
         that one never arrives as a PIN: a marker on the leg for a symptom the
         patient said they do not have reads exactly like one they do. */
      { name: "the denial is not offered as a pin on the body map", weight: 3,
        test: (r) => (r.findings || []).every((f) => !/numb|tingl/i.test(f.summary) || f.denial === true),
        detail: (r) => `findings: ${JSON.stringify((r.findings || []).map((f) => ({ part: f.part, denial: !!f.denial, summary: f.summary })))}` },
      { name: "the denial is recorded as a denial where it is written up", weight: 2,
        test: (r) => { const p = prose(r); return !/\b(numbness|tingling)\b/.test(p) || /\b(denie|no |without|wala|negative)/.test(p); },
        detail: (r) => `subjective: ${norm(r.subjective).slice(0, 160)}` },
    ],
  },

  /* 4. Cebuano, because the ceb-PH code is offered and has never been exercised
     end to end. A Visayas clinic switches once and the choice sticks, so this
     path is as load-bearing for them as fil-PH is for Manila. */
  {
    id: "ankle/cebuano",
    lang: "ceb-PH",
    why: "the ceb-PH language code, spoken — the Visayas clinic's whole dictation path",
    turns: [
      { who: "clinician", text: "Kumusta na ang imong tiil? Ang right ankle." },
      { who: "patient", text: "Sakit pa gihapon kung molakaw ko ug taas. Mga six out of ten." },
      { who: "clinician", text: "Right ankle dorsiflexion is limited, about ten degrees. Swelling is mild." },
      { who: "patient", text: "Oo, manghubag gihapon sa gabii." },
    ],
    heard: {
      wer: 0.35,
      must: ["ankle"],
    },
    expect: [
      { name: "the right ankle is pinned", weight: 2,
        test: (r) => hasFinding(r, "Ankle", "right"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "no left ankle invented from the Cebuano", weight: 3,
        test: (r) => !hasFinding(r, "Ankle", "left"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "dorsiflexion ROM survived", weight: 1,
        test: (r) => !!rom(r, "dorsiflexion"),
        detail: (r) => `rom: ${JSON.stringify((r.measurements || {}).rom || [])}` },
    ],
  },

  /* 5. Talk in the room that is not about this patient.

     A clinician thinking out loud ("if this were a labral tear") and a mention
     of somebody else entirely are both things Chirp 2 transcribes faithfully
     and a careless refine pass files as findings. This is the hallucination
     guard under real transcription noise rather than typed text. */
  {
    id: "hip/not-the-patient",
    lang: "fil-PH",
    why: "hypotheticals and third parties are transcribed faithfully — they must not become findings",
    turns: [
      { who: "clinician", text: "Your left shoulder is doing well. Range is nearly full now." },
      { who: "patient", text: "It still catches a little when I reach behind my back, maybe three out of ten." },
      { who: "clinician", text: "My last patient this morning had a hip replacement, completely different case." },
      { who: "clinician", text: "If this were a labral tear we would be seeing pain at end range, but we are not." },
      { who: "clinician", text: "We will keep the same programme for two more weeks." },
    ],
    heard: {
      wer: 0.15,
      must: ["shoulder"],
    },
    expect: [
      { name: "the other patient's hip is not on this chart", weight: 3,
        test: (r) => !hasFinding(r, "Hip") || !!correctionFor(r, "Hip"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "the hypothetical labral tear is not asserted as a finding", weight: 3,
        test: (r) => { const p = prose(r); return !/labral/.test(p)
          || /\bif\b|hypothetic|rul(?:e|es|ed|ing)\s+out|\bno\b|\bnot\b|denie|negative|unlikely/.test(p); },
        detail: (r) => `assessment: ${norm(r.assessment).slice(0, 160)}` },
      { name: "the shoulder this visit was actually about is still pinned", weight: 2,
        test: (r) => hasFinding(r, "Shoulder"),
        detail: (r) => `pinned: ${findingParts(r)}` },
    ],
  },

  /* 7 & 8. The two languages, spoken almost without English.

     The scripts above are code-switched, which is what a Manila or Cebu clinic
     actually sounds like — but a Taglish line gives both the speech model and
     the transcriber English to hold onto. These two take that away, so a
     failure in either language shows up as itself instead of being carried by
     the English around it.

     They also stand as the honest test of whether ElevenLabs can speak these
     languages at all. Filipino is a language its multilingual model supports;
     Cebuano is NOT, and is being approximated by a Filipino-accented voice
     reading Cebuano text. Word error rate alone cannot tell a mispronounced
     take from a mis-transcribed one, so `--keep-wav` and a native ear is the
     check that settles it. */
  {
    id: "shoulder/tagalog-heavy",
    lang: "fil-PH",
    why: "near-monolingual Tagalog — laterality from \"kanang\", a rating, and a denial, with no English to lean on",
    turns: [
      { who: "clinician", text: "Magandang umaga po. Ano po ang nararamdaman ninyo ngayon?" },
      { who: "patient", text: "Doc, masakit po ang kanang balikat ko. Kumikirot kapag itinataas ko." },
      { who: "clinician", text: "Gaano po kasakit, kung isa hanggang sampu?" },
      { who: "patient", text: "Mga pito po. Lalo na sa gabi, hindi po ako makatulog nang maayos." },
      { who: "clinician", text: "May pamamanhid po ba, o parang kinukuryente pababa sa braso?" },
      { who: "patient", text: "Wala naman po. Sakit lang po talaga sa balikat." },
    ],
    heard: {
      wer: 0.35,
      must: ["balikat"],
    },
    expect: [
      { name: "the RIGHT shoulder is pinned from \"kanang balikat\"", weight: 3,
        test: (r) => hasFinding(r, "Shoulder", "right"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "no left shoulder invented", weight: 3,
        test: (r) => !hasFinding(r, "Shoulder", "left"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "the 7/10 rating survived Tagalog", weight: 2,
        test: (r) => painScores(r).includes(7),
        detail: (r) => `pain: ${JSON.stringify(painScores(r))}` },
      { name: "\"wala naman po\" is not offered as a pin", weight: 3,
        test: (r) => (r.findings || []).every((f) => !/numb|pamamanhid|tingl/i.test(f.summary) || f.denial === true),
        detail: (r) => `findings: ${JSON.stringify((r.findings || []).map((f) => ({ part: f.part, denial: !!f.denial, summary: f.summary })))}` },
    ],
  },

  {
    id: "knee/cebuano-heavy",
    lang: "ceb-PH",
    why: "near-monolingual Cebuano — a language ElevenLabs does not officially speak, so this is the take to listen to",
    turns: [
      { who: "clinician", text: "Maayong buntag. Unsa may imong gibati karon?" },
      { who: "patient", text: "Sakit akong tuong tuhod, doc. Labi na kung motungas ko sa hagdanan." },
      { who: "clinician", text: "Pila ka sakit, kung isa hangtod napulo?" },
      { who: "patient", text: "Mga unom. Dili ko kaayo makalakaw ug taas." },
      { who: "clinician", text: "Naa bay manghubag o mamanhid?" },
      { who: "patient", text: "Wala man. Sakit ra gyud sa tuhod." },
    ],
    heard: {
      wer: 0.45,
      must: ["tuhod"],
    },
    expect: [
      { name: "the RIGHT knee is pinned from \"tuong tuhod\"", weight: 3,
        test: (r) => hasFinding(r, "Knee", "right"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      /* "wala" is Cebuano for LEFT and Tagalog for NONE, and this visit says it
         as a denial. Reading it as a side would pin the wrong knee off a word
         that was not about sides at all. */
      { name: "\"wala man\" was read as a denial, not as the left knee", weight: 3,
        test: (r) => !hasFinding(r, "Knee", "left"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "the 6/10 rating survived Cebuano", weight: 1,
        test: (r) => painScores(r).includes(6),
        detail: (r) => `pain: ${JSON.stringify(painScores(r))}` },
    ],
  },

  /* 6. Numbers, densely.

     Every measurement in the chart's table arrives through this path, and a
     digit is the one thing a mis-transcription can change without making the
     sentence look wrong. "Fifteen" for "fifty" reads perfectly and is a
     different chart. */
  {
    id: "numbers/dense",
    lang: "fil-PH",
    why: "degrees, grades and scores — the one class of error that leaves the sentence looking fine",
    turns: [
      { who: "clinician", text: "Right knee flexion is one hundred thirty degrees, extension is negative five." },
      { who: "clinician", text: "Quadriceps MMT is four out of five, hamstring is four plus out of five." },
      { who: "patient", text: "Pain today is three out of ten, much better than last week." },
      { who: "clinician", text: "Good. Girth measurement is forty two centimetres on the right, forty four on the left." },
    ],
    heard: {
      wer: 0.20,
      /* "negative" is here because Chirp 2 drops it. It is a known, reproduced
         failure rather than an aspiration: the baseline records it as failing,
         so the day it starts arriving the diff says so. */
      must: ["knee", "flexion", "negative"],
    },
    expect: [
      { name: "knee flexion ROM was captured", weight: 2,
        test: (r) => !!rom(r, "flexion"),
        detail: (r) => `rom: ${JSON.stringify((r.measurements || {}).rom || [])}` },
      { name: "the flexion value is 130, not a misheard neighbour", weight: 2,
        test: (r) => { const m = rom(r, "flexion"); return !!m && /130/.test(JSON.stringify(m)); },
        detail: (r) => `rom: ${JSON.stringify((r.measurements || {}).rom || [])}` },
      { name: "the 3/10 pain score reached the chart", weight: 2,
        test: (r) => painScores(r).includes(3),
        detail: (r) => `pain: ${JSON.stringify(painScores(r))}` },
      { name: "no pain score appears that nobody said", weight: 3,
        test: (r) => painScores(r).every((s) => s === 3),
        detail: (r) => `pain: ${JSON.stringify(painScores(r))}` },
      /* "extension is negative five" is a flexion contracture. Drop the word
         and the chart says five degrees of hyperextension — the opposite knee,
         clinically, and the sentence reads perfectly either way. */
      { name: "the negative sign on extension was not lost", weight: 3,
        test: (r) => { const m = rom(r, "extension"); return !m || /-\s?5|negative/i.test(JSON.stringify(m)); },
        detail: (r) => `rom: ${JSON.stringify((r.measurements || {}).rom || [])}` },
    ],
  },
];

/** The reference text a transcript is scored against: everything said, in order. */
const spokenText = (s) => s.turns.map((t) => t.text).join(" ");

module.exports = { SCRIPTS, spokenText };
