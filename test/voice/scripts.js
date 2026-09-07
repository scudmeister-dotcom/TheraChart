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

     The Cebuano one was rewritten once already, and the rewrite is most of why
     it works. Its first version used the contracted "tuong tuhod" and
     "motungas ko sa hagdanan" — 26.1% word error, with the laterality word
     elided into the one before it. Ordinary written Cebuano ("tuo nga tuhod",
     "mosaka ko ug hagdan") took the same script to 7.5%, and took "tuo" from a
     coin flip to 7 takes in 10.

     What looked like a residual Chirp 2 weakness turned out to be the VOICE.
     Read by Pedro, this script keeps the laterality word 12 takes out of 12 at
     1.7% real word error — level with the Tagalog script. Read with Mang Jose
     as the patient it drops to 7/12 at 6.0%, and that gap is ElevenLabs, not
     Google. Hence the per-script voice override below. */
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
    /* ADVISORY: reported, but it does not fail a run.

       Measured as the median of five takes per cell, this script sits at 15.2%
       word error on its best model-and-voice combination (eleven_v3 + Pedro)
       and 28.3% on its worst — against 1.7% for the equivalent Tagalog script.
       Nothing shifted that: not v3, not stability, not a seed, not a
       pronunciation dictionary (see README).

       The instrument is the limit, not the chart. Synthetic Cebuano is roughly
       nine times noisier than synthetic Tagalog, and a gate built on it would
       fail for reasons that have nothing to do with TheraChart. It stays
       because the signal is still worth reading — a sudden change here is worth
       looking at — but ankle/cebuano is the Cebuano coverage to trust: mixed
       with English, it holds 8.1% with 0.0% spread across both models AND both
       voices. Real Bisaya audio is what would retire this caveat. */
    advisory: true,
    /* Both parts read by Pedro. Not cosmetic: the patient voice was the whole
       residual failure on this script — 12/12 laterality at 1.7% real error
       with Pedro, 7/12 at 6.0% when Mang Jose reads the patient turns. See
       run.js. With a voice that says the word, Cebuano transcribes about as
       well as Tagalog does. */
    voices: { clinician: "iyZZ2rpPw5XY3ZQltAWV", patient: "iyZZ2rpPw5XY3ZQltAWV" },
    why: "near-monolingual Cebuano — laterality from \"tuo nga tuhod\", in the language with no English to lean on",
    /* Rewritten after measuring the first version word by word. That one used
       the contracted "tuong" (which elides into the word before it and survived
       about half the time) and "motungas ko sa hagdanan" (which no transcriber
       held together). Ordinary written Cebuano — "tuo nga tuhod", "mosaka ko ug
       hagdan" — is both more natural and markedly more robust: 9.4% real errors
       against the old script's 13.8%, on the same voice and model. */
    turns: [
      { who: "clinician", text: "Unsa may imong gibati sa imong tuhod?" },
      { who: "patient", text: "Sakit ang tuo nga tuhod kung mosaka ko ug hagdan." },
      { who: "clinician", text: "Pila ka sakit, gikan sa usa hangtod napulo?" },
      { who: "patient", text: "Mga unom sa napulo." },
      { who: "clinician", text: "Naa bay hubag sa tuhod?" },
      { who: "patient", text: "Gamay ra, doc. Wala may pamanhid." },
    ],
    heard: {
      wer: 0.30,
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

  /* 9. A whole visit, long enough to be cut in two.

     Every script above is one chunk. A real appointment is not, and the path
     that splits a recording, transcribes each piece as an independent request
     and stitches the results back into one transcript had never been exercised
     by anything — including the case where a chunk fails and leaves a marked
     hole rather than silently welding two unrelated sentences together.

     Long also changes the note problem, not just the audio one: the model has
     to hold a whole session in view and still put each fact in the right
     section, rather than summarising four tidy sentences. */
  {
    id: "visit/long-full-session",
    lang: "fil-PH",
    why: "a full-length visit — the multi-chunk stitch, and a note built from minutes rather than seconds",
    turns: [
      { who: "clinician", text: "Good morning po. Let us start with how the week went." },
      { who: "patient", text: "Medyo mas okay na po, doc. Pero masakit pa rin ang kanang balikat ko kapag umaabot ako sa taas." },
      { who: "clinician", text: "How would you rate it now, out of ten?" },
      { who: "patient", text: "Mga lima na lang po. Dati po kasi pito, kaya medyo bumuti." },
      { who: "clinician", text: "That is good progress. Any night pain still?" },
      { who: "patient", text: "Konti na lang po. Nakakatulog na po ako ngayon, hindi na po ako nagigising." },
      { who: "clinician", text: "Any numbness or tingling going down the arm?" },
      { who: "patient", text: "Wala naman po. Sakit lang po talaga sa balikat." },
      { who: "clinician", text: "Let me measure. Right shoulder active flexion is one hundred forty degrees today, up from one twenty last week." },
      { who: "clinician", text: "Abduction is one hundred thirty. External rotation is fifty five degrees." },
      { who: "clinician", text: "Rotator cuff MMT is four out of five, and that is better than the three plus we had at evaluation." },
      { who: "clinician", text: "Neer is still mildly positive but Hawkins is negative now." },
      { who: "patient", text: "Ibig sabihin po ba gumagaling na?" },
      { who: "clinician", text: "Yes. The impingement signs are settling and your range is close to normal." },
      { who: "clinician", text: "Today we did scaption to ninety degrees, three sets of ten, and prone rows with a yellow band." },
      { who: "clinician", text: "We also did soft tissue work to the upper trapezius and posterior cuff." },
      { who: "clinician", text: "Continue the home programme twice daily and add the doorway stretch." },
      { who: "clinician", text: "Plan is to continue twice weekly for two more weeks, then reassess." },
    ],
    heard: {
      wer: 0.20,
      must: ["shoulder", "abduction"],
    },
    expect: [
      { name: "the right shoulder is pinned", weight: 3,
        test: (r) => hasFinding(r, "Shoulder", "right"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "no left shoulder invented across a long visit", weight: 3,
        test: (r) => !hasFinding(r, "Shoulder", "left"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "the stitch did not lose the second half — abduction survived", weight: 3,
        test: (r) => !!rom(r, "abduction"),
        detail: (r) => `rom: ${JSON.stringify((r.measurements || {}).rom || [])}` },
      { name: "flexion from the first half survived too", weight: 2,
        test: (r) => !!rom(r, "flexion"),
        detail: (r) => `rom: ${JSON.stringify((r.measurements || {}).rom || [])}` },
      { name: "the CURRENT 5/10 is recorded, not only the historical 7", weight: 2,
        test: (r) => painScores(r).includes(5),
        detail: (r) => `pain: ${JSON.stringify(painScores(r))}` },
      { name: "the denial is not offered as a pin", weight: 3,
        test: (r) => (r.findings || []).every((f) => !/numb|tingl/i.test(f.summary) || f.denial === true),
        detail: (r) => `findings: ${JSON.stringify((r.findings || []).map((f) => ({ part: f.part, denial: !!f.denial })))}` },
      { name: "treatment done this visit reached the Treatment section", weight: 2,
        test: (r) => /scaption|row|soft tissue|band/.test(norm(r.treatment)),
        detail: (r) => `treatment: ${norm(r.treatment).slice(0, 140)}` },
    ],
  },

  /* 10. The number pairs that sound alike.

     numbers/dense proves a clean reading survives. This is the other half: the
     pairs English speakers mishear from each other, said in the places a chart
     actually uses them. Thirteen for thirty is not a typo in a note, it is a
     different knee. */
  {
    id: "numbers/confusables",
    lang: "fil-PH",
    why: "thirteen/thirty, fifteen/fifty, forty/fourteen — mishearings that leave the sentence intact",
    turns: [
      { who: "clinician", text: "Let us record today's measurements for the left knee." },
      { who: "clinician", text: "Left knee flexion is thirty degrees today, up from before." },
      { who: "clinician", text: "Left knee extension is fifteen degrees." },
      { who: "clinician", text: "Hip abduction is forty degrees on that side." },
      { who: "clinician", text: "Shoulder flexion on the right is sixty degrees." },
      { who: "patient", text: "The pain is four out of ten today, doc." },
      { who: "clinician", text: "Good. We will measure again in two weeks." },
    ],
    heard: {
      /* Deliberately looser than numbers/dense. Confusable pairs are the whole
         point of this script, so a wrong digit must fail the ASSERTIONS below,
         where it is unambiguous — not the word error ceiling, where a slip on
         "today" scores the same as thirteen for thirty. */
      wer: 0.25,
      must: ["knee", "flexion", "extension"],
    },
    expect: [
      { name: "flexion is 30, not 13", weight: 3,
        test: (r) => { const m = rom(r, "flexion"); return !!m && m.degrees === 30; },
        detail: (r) => `rom: ${JSON.stringify((r.measurements || {}).rom || [])}` },
      { name: "extension is 15, not 50", weight: 3,
        test: (r) => { const m = rom(r, "extension"); return !!m && m.degrees === 15; },
        detail: (r) => `rom: ${JSON.stringify((r.measurements || {}).rom || [])}` },
      { name: "abduction is 40, not 14", weight: 3,
        test: (r) => { const m = rom(r, "abduction"); return !!m && m.degrees === 40; },
        detail: (r) => `rom: ${JSON.stringify((r.measurements || {}).rom || [])}` },
      /* This one currently fails for a reason that has nothing to do with
         confusable digits: "shoulder flexion ON THE RIGHT is sixty degrees"
         is DROPPED entirely, because ROM_FILLER in parser.js cannot cross the
         words between the motion and the value. Same family as the comma that
         loses "knee flexion, 130 degrees" — see the README. Kept here as a
         failing assertion rather than reworded, because the property is right
         even though the cause turned out to be somewhere else. */
      { name: "shoulder flexion is recorded as 60", weight: 3,
        test: (r) => ((r.measurements && r.measurements.rom) || []).some((m) => m.joint === "shoulder" && m.degrees === 60),
        detail: (r) => `rom: ${JSON.stringify((r.measurements || {}).rom || [])}` },
    ],
  },

  /* 11. Two complaints in one visit.

     Every other script has a single region, which is the easy case: anything
     the model pins is right by construction. A patient with two problems can
     have them merged into one, or have the quieter one dropped entirely, and
     neither failure is visible from a note that looks well written. */
  {
    id: "multi-region/shoulder-and-back",
    lang: "fil-PH",
    why: "two separate complaints must stay two — merging or dropping one is invisible in a tidy note",
    turns: [
      { who: "clinician", text: "What is bothering you today?" },
      { who: "patient", text: "Dalawa po. Ang kaliwang balikat ko, tapos ang lower back ko rin." },
      { who: "clinician", text: "Tell me about the shoulder first." },
      { who: "patient", text: "Masakit po kapag nag-aabot ako sa likod. Mga anim out of ten." },
      { who: "clinician", text: "And the back?" },
      { who: "patient", text: "Matigas po sa umaga, mga tatlo out of ten lang naman po." },
    ],
    heard: {
      wer: 0.30,
      must: ["balikat", "back"],
    },
    expect: [
      { name: "the left shoulder is pinned", weight: 3,
        test: (r) => hasFinding(r, "Shoulder", "left"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "the low back is pinned as well, not merged into the shoulder", weight: 3,
        test: (r) => (r.findings || []).some((f) => /back|lumbar|spine/i.test(f.part)),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "they are two findings, not one", weight: 2,
        test: (r) => new Set((r.findings || []).filter((f) => !f.denial).map((f) => f.key)).size >= 2,
        detail: (r) => `pinned: ${findingParts(r)}` },
    ],
  },

  /* 12. The therapist dictating the whole note in the third person.

     refineSystem devotes a paragraph to this ("A RELAY IS STILL THE PATIENT'S
     REPORT") because it is how clinical documentation is taught and how many
     therapists actually dictate. The failure it guards against is silent: every
     line is labelled clinician, correctly, and the complaints are then dropped
     for not having come from the patient. */
  {
    id: "relay/third-person",
    lang: "fil-PH",
    why: "a note dictated entirely in the third person — the complaint is still the patient's",
    turns: [
      { who: "clinician", text: "Patient reports right knee pain, six out of ten, worse going down stairs." },
      { who: "clinician", text: "Patient denies any locking or giving way." },
      { who: "clinician", text: "Patient states the pain began three weeks ago after a long walk." },
      { who: "clinician", text: "Patient complains of morning stiffness lasting about twenty minutes." },
    ],
    heard: {
      wer: 0.15,
      must: ["knee", "patient"],
    },
    expect: [
      { name: "the relayed complaint still pins the right knee", weight: 3,
        test: (r) => hasFinding(r, "Knee", "right"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "the 6/10 the therapist relayed reached the chart", weight: 2,
        test: (r) => painScores(r).includes(6),
        detail: (r) => `pain: ${JSON.stringify(painScores(r))}` },
      /* Not "the denial is unpinned" — a denial folded into the tail of a real
         complaint is not a pin of its own, and the knee genuinely hurts. The
         property worth holding is that the pertinent negative SURVIVED: a
         relayed "denies locking" that vanishes leaves a note that never asked. */
      { name: "the relayed denial was not thrown away", weight: 2,
        test: (r) => /lock|giving way/.test(prose(r))
          || (r.findings || []).some((f) => /lock|giving way/i.test(f.summary)),
        detail: (r) => `subjective: ${norm(r.subjective).slice(0, 140)}` },
      { name: "no finding is pinned that is ONLY a denial", weight: 3,
        test: (r) => (r.findings || []).every((f) => !f.denial),
        detail: (r) => `findings: ${JSON.stringify((r.findings || []).map((f) => ({ part: f.part, denial: !!f.denial })))}` },
      { name: "the complaint reached the Subjective", weight: 2,
        test: (r) => /knee/.test(norm(r.subjective)),
        detail: (r) => `subjective: ${norm(r.subjective).slice(0, 140)}` },
    ],
  },

  /* 13. The things that make a treatment unsafe.

     Precautions is the one section where an omission is dangerous rather than
     untidy — a weight-bearing limit or an anticoagulant that never reached the
     note is a note that reads as clearance. */
  {
    id: "precautions/post-op",
    lang: "fil-PH",
    why: "a weight-bearing limit and an anticoagulant must reach Precautions, where an omission reads as clearance",
    turns: [
      { who: "clinician", text: "This is post-operative day twelve after her right knee replacement." },
      { who: "clinician", text: "She is partial weight bearing only, no more than twenty five percent through the right leg." },
      { who: "clinician", text: "She is on warfarin, so no aggressive soft tissue work and watch for bruising." },
      { who: "patient", text: "Masakit pa rin po kapag yumuyuko, mga lima out of ten." },
      { who: "clinician", text: "Understood. We will keep to the protocol range today." },
    ],
    heard: {
      wer: 0.25,
      must: ["weight bearing", "knee"],
    },
    expect: [
      { name: "the weight-bearing limit reached the note", weight: 3,
        test: (r) => /weight[- ]?bearing|partial weight|25 ?%|twenty five/.test(prose(r)),
        detail: (r) => `precautions: ${norm(r.precautions).slice(0, 160)}` },
      { name: "the anticoagulant reached the note", weight: 3,
        test: (r) => /warfarin|anticoagul|blood thinner|bruis/.test(prose(r)),
        detail: (r) => `precautions: ${norm(r.precautions).slice(0, 160)}` },
      { name: "both landed in Precautions rather than being scattered", weight: 1,
        test: (r) => /weight|warfarin|anticoagul|bruis/.test(norm(r.precautions)),
        detail: (r) => `precautions: ${norm(r.precautions).slice(0, 160)}` },
    ],
  },

  /* 14. A visit where nothing clinical is said.

     refineSystem states that an EMPTY findings array is a correct answer. The
     model is under standing pressure to produce something, and the microphone
     is open through the small talk at the start of every appointment — so the
     question is whether a chart can be written out of nothing at all. */
  {
    id: "smalltalk/nothing-clinical",
    lang: "fil-PH",
    why: "nothing clinical was said — an empty findings array is the correct answer, not a failure",
    turns: [
      { who: "clinician", text: "Kumusta po ang byahe? Ang traffic ba sa EDSA?" },
      { who: "patient", text: "Grabe po, isang oras po ako sa jeep. Ang init pa po." },
      { who: "clinician", text: "Let me just get your file open, one moment." },
      { who: "patient", text: "Sige po. Nag-lunch na po ba kayo?" },
      { who: "clinician", text: "Not yet, later. Okay, the system is slow today." },
    ],
    heard: {
      wer: 0.35,
      must: [],
    },
    expect: [
      { name: "no finding is invented out of small talk", weight: 3,
        test: (r) => (r.findings || []).filter((f) => !f.denial && !f.bare).length === 0,
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "no pain score is invented", weight: 3,
        test: (r) => painScores(r).length === 0,
        detail: (r) => `pain: ${JSON.stringify(painScores(r))}` },
      { name: "no measurement is invented", weight: 3,
        test: (r) => ((r.measurements && r.measurements.rom) || []).length === 0,
        detail: (r) => `rom: ${JSON.stringify((r.measurements || {}).rom || [])}` },
    ],
  },

  /* 15. Both sides at once.

     "Pareho" and "both" expand to two pinned regions, and the halfway failure
     is the dangerous one: a bilateral complaint recorded on one side reads as a
     unilateral problem and quietly halves the treatment. */
  {
    id: "bilateral/both-knees",
    lang: "fil-PH",
    why: "a bilateral complaint must pin BOTH sides — recording one reads as a unilateral problem",
    turns: [
      { who: "clinician", text: "Which knee is troubling you?" },
      { who: "patient", text: "Pareho po, doc. Parehong tuhod, pero mas masakit po ang kanan." },
      { who: "clinician", text: "How bad on each side?" },
      { who: "patient", text: "Kanan po mga pito, kaliwa po mga apat." },
      { who: "clinician", text: "Understood, bilateral knee pain, worse on the right." },
    ],
    heard: {
      wer: 0.30,
      must: ["tuhod"],
    },
    expect: [
      { name: "the right knee is pinned", weight: 3,
        test: (r) => hasFinding(r, "Knee", "right"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "the left knee is pinned too — bilateral is not half a finding", weight: 3,
        test: (r) => hasFinding(r, "Knee", "left"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "the write-up says bilateral rather than naming one side", weight: 1,
        test: (r) => /both|bilateral|pareho/.test(prose(r)),
        detail: (r) => `subjective: ${norm(r.subjective).slice(0, 140)}` },
    ],
  },

  /* ---------- the language matrix: lang/ ----------

     Everything above varies the CLINICAL problem — a correction, a denial, a
     bilateral complaint — and lets the language fall where it may. That is the
     right way to test the chart, and the wrong way to answer "how does
     dictation hold up in the language this clinic actually speaks", because no
     two of those scripts say the same thing. A worse score on the Cebuano one
     could be the language or it could be that it is a different visit.

     These five are the controlled version. Same patient, same visit, same
     facts every time:

         left elbow, sore three weeks, worse lifting
         six out of ten, sharp on straightening
         no numbness in the hand or fingers
         (where a clinician would say it in English) flexion 120 degrees

     Only the language changes. A gap between two rows of `--case lang/` is a
     gap in the language, not in the script — which is the one thing the rest of
     this file cannot tell you.

     Two caveats built in on purpose:

     - The two monolingual scripts have no ROM turn. A Filipino PT says
       "flexion is one hundred twenty degrees" in English even mid-Tagalog
       sentence; inventing a Tagalog rendering nobody speaks would measure a
       language that does not exist. So the pure scripts are the patient
       interview, and the mixed scripts add the clinician's measurement — which
       is exactly the split a real chart has. Word error is comparable within
       those pairs, not across all five.

     - LEFT, not right, and that is the sharp end for Cebuano: `wala` is both
       "left" and "none", and this visit says it in both senses. knee/cebuano-heavy
       tests one direction (a denial must not become the left knee); this tests
       the other, harder one (the left elbow must survive a sentence that also
       denies numbness with the same word). There is no synonym to fall back on
       — that is how the language works. */

  {
    id: "lang/english-only",
    lang: "fil-PH",
    why: "the control — the same visit in plain English, so the other four have a floor to be measured against",
    turns: [
      { who: "clinician", text: "Good afternoon. What brings you in today?" },
      { who: "patient", text: "My left elbow has been sore for about three weeks. It is worse when I lift anything heavy." },
      { who: "clinician", text: "How bad is it, on a scale of one to ten?" },
      { who: "patient", text: "About six out of ten. It is sharp when I straighten it." },
      { who: "clinician", text: "Any numbness or tingling in the hand or fingers?" },
      { who: "patient", text: "No, none at all. Just the elbow." },
      { who: "clinician", text: "Left elbow flexion is one hundred twenty degrees. Tenderness over the lateral epicondyle." },
    ],
    heard: {
      wer: 0.10,
      must: ["elbow", "left"],
    },
    expect: [
      { name: "the LEFT elbow is pinned", weight: 3,
        test: (r) => hasFinding(r, "Elbow", "left"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "no right elbow invented", weight: 3,
        test: (r) => !hasFinding(r, "Elbow", "right"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "the 6/10 rating reached the chart", weight: 2,
        test: (r) => painScores(r).includes(6),
        detail: (r) => `pain: ${JSON.stringify(painScores(r))}` },
      { name: "the numbness denial is not offered as a pin", weight: 3,
        test: (r) => (r.findings || []).every((f) => !/numb|tingl/i.test(f.summary) || f.denial === true),
        detail: (r) => `findings: ${JSON.stringify((r.findings || []).map((f) => ({ part: f.part, denial: !!f.denial, summary: f.summary })))}` },
      { name: "elbow flexion ROM survived", weight: 1,
        test: (r) => !!rom(r, "flexion"),
        detail: (r) => `rom: ${JSON.stringify((r.measurements || {}).rom || [])}` },
    ],
  },

  {
    id: "lang/tagalog-only",
    lang: "fil-PH",
    why: "the same visit with no English at all — laterality from \"kaliwang siko\", a rating in Tagalog numerals, a Tagalog denial",
    turns: [
      { who: "clinician", text: "Magandang hapon po. Ano po ang nararamdaman ninyo ngayon?" },
      { who: "patient", text: "Masakit po ang kaliwang siko ko, mga tatlong linggo na. Lalo na po kapag may binubuhat ako." },
      { who: "clinician", text: "Gaano po kasakit, kung isa hanggang sampu?" },
      { who: "patient", text: "Mga anim po. Kumikirot po kapag itinutuwid ko." },
      { who: "clinician", text: "May pamamanhid po ba sa kamay o sa mga daliri?" },
      { who: "patient", text: "Wala po. Walang pamamanhid. Sa siko lang po talaga." },
    ],
    heard: {
      wer: 0.30,
      must: ["siko", "kaliwa"],
    },
    expect: [
      { name: "the LEFT elbow is pinned from \"kaliwang siko\"", weight: 3,
        test: (r) => hasFinding(r, "Elbow", "left"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "no right elbow invented", weight: 3,
        test: (r) => !hasFinding(r, "Elbow", "right"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "the 6/10 rating survived Tagalog numerals (\"mga anim\")", weight: 2,
        test: (r) => painScores(r).includes(6),
        detail: (r) => `pain: ${JSON.stringify(painScores(r))}` },
      { name: "\"walang pamamanhid\" is not offered as a pin", weight: 3,
        test: (r) => (r.findings || []).every((f) => !/numb|pamamanhid|tingl/i.test(f.summary) || f.denial === true),
        detail: (r) => `findings: ${JSON.stringify((r.findings || []).map((f) => ({ part: f.part, denial: !!f.denial, summary: f.summary })))}` },
    ],
  },

  {
    id: "lang/cebuano-only",
    lang: "ceb-PH",
    /* ADVISORY on the same grounds as knee/cebuano-heavy: near-monolingual
       Cebuano measures ElevenLabs at least as much as it measures TheraChart,
       and a new script has no measured history to gate a run on. Reported and
       diffed against the baseline; it does not fail the build. */
    advisory: true,
    /* Pedro reads both parts. Measured on knee/cebuano-heavy: 12/12 laterality
       at 1.7% real word error with Pedro on both, 7/12 at 6.0% when Mang Jose
       reads the patient. The patient turns are where the Cebuano is. */
    voices: { clinician: "iyZZ2rpPw5XY3ZQltAWV", patient: "iyZZ2rpPw5XY3ZQltAWV" },
    why: "the same visit in Cebuano — and \"wala\" has to be read as LEFT in one sentence and as NONE in the next",
    /* Written uncontracted, which is both ordinary written Cebuano and markedly
       more robust: "tuo nga tuhod" took knee/cebuano-heavy from 26.1% to 7.5%
       against the contracted "tuong tuhod". Same rule here — "wala nga siko",
       never "walang siko". */
    turns: [
      { who: "clinician", text: "Maayong hapon. Unsa may imong gibati karon?" },
      { who: "patient", text: "Sakit ang wala nga siko nako, mga tulo ka semana na." },
      { who: "clinician", text: "Pila ka sakit, gikan sa usa hangtod napulo?" },
      { who: "patient", text: "Mga unom sa napulo. Sakit kaayo kung magbitbit ko ug bug-at." },
      { who: "clinician", text: "Naa bay pamanhid sa imong kamot o mga tudlo?" },
      { who: "patient", text: "Wala. Wala gyoy pamanhid. Sa siko ra gyod." },
    ],
    heard: {
      wer: 0.30,
      /* "wala" is deliberately NOT a must-word here even though it is the
         laterality: `must` matches on \b<word>, so the denial "wala gyoy
         pamanhid" would satisfy it while the side went missing. The side is
         asserted where it can actually be checked — on the pin. */
      must: ["siko"],
    },
    expect: [
      { name: "the LEFT elbow is pinned from \"wala nga siko\"", weight: 3,
        test: (r) => hasFinding(r, "Elbow", "left"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "no right elbow invented", weight: 3,
        test: (r) => !hasFinding(r, "Elbow", "right"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "the 6/10 rating survived Cebuano numerals (\"unom sa napulo\")", weight: 1,
        test: (r) => painScores(r).includes(6),
        detail: (r) => `pain: ${JSON.stringify(painScores(r))}` },
      { name: "\"wala gyoy pamanhid\" is not offered as a pin", weight: 3,
        test: (r) => (r.findings || []).every((f) => !/numb|pamanhid|tingl/i.test(f.summary) || f.denial === true),
        detail: (r) => `findings: ${JSON.stringify((r.findings || []).map((f) => ({ part: f.part, denial: !!f.denial, summary: f.summary })))}` },
    ],
  },

  {
    id: "lang/taglish",
    lang: "fil-PH",
    why: "the same visit as a Manila clinic actually speaks it — code-switched inside the sentence, not between turns",
    /* back/taglish-negation switches between speakers; this switches mid-clause
       ("kapag nagbubuhat ako ng heavy"), which is the harder and far more common
       shape. The clinical measurement is in English because that is where a
       Filipino PT switches every time. */
    turns: [
      { who: "clinician", text: "Kumusta po. So ito po yung left elbow na sinasabi ninyo?" },
      { who: "patient", text: "Opo doc. Masakit po siya, especially kapag nagbubuhat ako ng heavy. Mga three weeks na po." },
      { who: "clinician", text: "Pain scale po, one to ten?" },
      { who: "patient", text: "Mga six po. Sharp po yung sakit kapag itinutuwid ko." },
      { who: "clinician", text: "May numbness po ba o tingling sa mga daliri?" },
      { who: "patient", text: "Wala po. Walang numbness, yung sakit lang po sa siko." },
      { who: "clinician", text: "Left elbow flexion is one hundred twenty degrees, with tenderness over the lateral epicondyle." },
    ],
    heard: {
      wer: 0.25,
      must: ["elbow", "left"],
    },
    expect: [
      { name: "the LEFT elbow is pinned", weight: 3,
        test: (r) => hasFinding(r, "Elbow", "left"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "no right elbow invented", weight: 3,
        test: (r) => !hasFinding(r, "Elbow", "right"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "the 6/10 rating reached the chart", weight: 2,
        test: (r) => painScores(r).includes(6),
        detail: (r) => `pain: ${JSON.stringify(painScores(r))}` },
      { name: "\"walang numbness\" is not offered as a pin", weight: 3,
        test: (r) => (r.findings || []).every((f) => !/numb|pamamanhid|tingl/i.test(f.summary) || f.denial === true),
        detail: (r) => `findings: ${JSON.stringify((r.findings || []).map((f) => ({ part: f.part, denial: !!f.denial, summary: f.summary })))}` },
      { name: "elbow flexion ROM survived the code-switch", weight: 1,
        test: (r) => !!rom(r, "flexion"),
        detail: (r) => `rom: ${JSON.stringify((r.measurements || {}).rom || [])}` },
    ],
  },

  {
    id: "lang/bisaya-english",
    lang: "ceb-PH",
    why: "the same visit as a Visayas clinic speaks it — Cebuano carrying the complaint, English carrying the side and the numbers",
    /* This is the Cebuano coverage the README says to trust: mixed with English,
       ankle/cebuano holds 8.1% with 0.0% spread across both TTS models and both
       voices, where the near-monolingual script does not. Worth having as its
       own row precisely because it is the realistic one — a Bisaya PT says
       "left elbow" and "six out of ten" in English, which sidesteps the wala
       ambiguity that lang/cebuano-only walks straight into. The pair of them is
       the finding: same visit, one word of English, different reliability. */
    turns: [
      { who: "clinician", text: "Maayong hapon. Ang left elbow, sakit gihapon?" },
      { who: "patient", text: "Oo doc, sakit gihapon kung magbitbit ko ug heavy. Mga three weeks na." },
      { who: "clinician", text: "Pila ang pain, one to ten?" },
      { who: "patient", text: "Mga six out of ten. Sakit kaayo kung i-straight nako." },
      { who: "clinician", text: "Naa bay numbness sa imong mga tudlo?" },
      { who: "patient", text: "Wala. Walay numbness, sa siko ra gyod." },
      { who: "clinician", text: "Left elbow flexion is one hundred twenty degrees, with tenderness over the lateral epicondyle." },
    ],
    heard: {
      wer: 0.25,
      must: ["elbow", "left"],
    },
    expect: [
      { name: "the LEFT elbow is pinned", weight: 3,
        test: (r) => hasFinding(r, "Elbow", "left"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "no right elbow invented", weight: 3,
        test: (r) => !hasFinding(r, "Elbow", "right"),
        detail: (r) => `pinned: ${findingParts(r)}` },
      { name: "the 6/10 rating reached the chart", weight: 2,
        test: (r) => painScores(r).includes(6),
        detail: (r) => `pain: ${JSON.stringify(painScores(r))}` },
      { name: "\"walay numbness\" is not offered as a pin", weight: 3,
        test: (r) => (r.findings || []).every((f) => !/numb|pamanhid|tingl/i.test(f.summary) || f.denial === true),
        detail: (r) => `findings: ${JSON.stringify((r.findings || []).map((f) => ({ part: f.part, denial: !!f.denial, summary: f.summary })))}` },
      { name: "elbow flexion ROM survived", weight: 1,
        test: (r) => !!rom(r, "flexion"),
        detail: (r) => `rom: ${JSON.stringify((r.measurements || {}).rom || [])}` },
    ],
  },

  /* ---------- the vocabulary probe: probe/ ----------

     Not a regression test. These two exist to answer one question — WHICH of
     the Filipino body-part words the parser already understands actually
     survive Chirp 2 — and they are excluded from a bare run because of it
     (`probe: true`; name them with --case to run them).

     The question is live because the two halves of the app disagree. parser.js
     maps about twenty-five Tagalog and Cebuano body-part words (REGIONS at
     :90-120, JOINT_ALIASES at :822), so the chart understands every one of them
     if it arrives. None is in STT_PHRASES, so nothing nudges Chirp 2 to produce
     them. lang/ measured exactly one of them — `siko`, heard in 5 of 6
     recordings in BOTH languages — and one data point is not a table.

     Read the result from the sweep's "WORDS THAT DID NOT ALWAYS ARRIVE" block,
     which reports each `must` word's survival rate across every voice × take.
     A word that is not listed there arrived every time. Run it as:

         node test/voice/run.js --sweep <id>,<id> --takes 3 --case probe/

     Two deliberate choices. The words are in CARRIER SENTENCES rather than
     recited, because a word spoken alone is a different recognition problem
     than the same word mid-clause, and mid-clause is the one the clinic has.
     And the genital terms the region table carries (`puki`, `titi`, `bayag`)
     are left out — they are in parser.js for a stated reason, but whether to
     BOOST them is a separate question with its own false-positive cost, and it
     is not the one being asked here.

     The word error rate these two report is meaningless — the density is
     nothing like speech — so both are advisory and neither carries an `expect`
     block. The `must` rates are the entire output. */

  {
    id: "probe/tagalog-parts",
    lang: "fil-PH",
    probe: true,
    advisory: true,
    why: "which Tagalog body-part words survive Chirp 2 — the shortlist for a language-gated STT_PHRASES table",
    turns: [
      { who: "clinician", text: "Saan po ba kayo masakit?" },
      { who: "patient", text: "Masakit po ang balikat at ang siko ko." },
      { who: "patient", text: "Pati po ang tuhod at ang leeg ko, medyo matigas." },
      { who: "patient", text: "Sumasakit din po ang balakang at ang hita kapag naglalakad ako." },
      { who: "patient", text: "Ang kamay at ang mga daliri ko po ay namamanhid tuwing umaga." },
      { who: "patient", text: "Mahina pa rin po ang braso at ang bisig ko." },
      { who: "patient", text: "Masakit din po ang pulso at ang hinlalaki ko." },
      { who: "patient", text: "Namamaga po ang bukong-bukong at ang talampakan ko." },
      { who: "patient", text: "Ang lulod at ang paa ko po ay madaling mapagod." },
      { who: "patient", text: "Minsan po sumasakit ang singit at ang palad ko." },
    ],
    heard: {
      wer: 1,
      must: ["balikat", "siko", "tuhod", "leeg", "balakang", "hita", "kamay",
        "daliri", "braso", "bisig", "pulso", "hinlalaki", "bukong-bukong",
        "talampakan", "lulod", "paa", "singit", "palad"],
    },
    expect: [],
  },

  {
    id: "probe/cebuano-parts",
    lang: "ceb-PH",
    probe: true,
    advisory: true,
    /* Pedro on both parts, for the reason knee/cebuano-heavy records: the
       patient voice was the whole residual failure on Cebuano, 12/12 laterality
       against 7/12. A probe wants the best available speech, so that a word it
       reports as lost was lost by the transcriber rather than by the reader. */
    voices: { clinician: "iyZZ2rpPw5XY3ZQltAWV", patient: "iyZZ2rpPw5XY3ZQltAWV" },
    why: "which Cebuano body-part words survive Chirp 2 — same question, the other language",
    /* Uncontracted throughout, per the finding that ordinary written Cebuano
       took knee/cebuano-heavy from 26.1% to 7.5% against the contracted form. */
    turns: [
      { who: "clinician", text: "Asa man ka masakitan?" },
      { who: "patient", text: "Sakit ang abaga ug ang siko nako." },
      { who: "patient", text: "Sakit pod ang tuhod ug ang liog nako." },
      { who: "patient", text: "Ang bat-ang nako sakit kung molakaw ko ug taas." },
      { who: "patient", text: "Namanhid ang kamot ug ang mga tudlo nako." },
      { who: "patient", text: "Maluya pa gihapon ang bukton nako." },
      { who: "patient", text: "Naghubag ang buol-buol ug ang tiil nako." },
      { who: "patient", text: "Sakit pod ang kumagko ug ang lapa-lapa nako." },
    ],
    heard: {
      wer: 1,
      must: ["abaga", "siko", "tuhod", "liog", "bat-ang", "kamot", "tudlo",
        "bukton", "buol-buol", "tiil", "kumagko", "lapa-lapa"],
    },
    expect: [],
  },

  /* ================================================================== *
   * SECTION DICTATION — one section, recorded and written on its own
   * ==================================================================
   *
   * A different chain from everything above. The scripts above record a whole
   * visit and grade /api/refine; these record ONE section and grade
   * /api/check-section, which writes that section's prose from the transcript
   * and nothing else.
   *
   * A `section` field switches the runner over. `expect` is graded on the
   * endpoint's answer — { tidied, issues } — rather than on a refine result,
   * so the helpers below read that shape.
   *
   * What is being measured is narrower than the refine cases and matters just
   * as much: this endpoint writes text straight into a section of a signed
   * record, from ONE burst, with no whole-visit context to catch it. The two
   * failures that would hurt are inventing a fact nobody said, and dropping
   * one that was said. Both are weight 3 throughout.
   *
   * All turns are the clinician. Section dictation is a therapist talking to
   * the note, not a conversation. */

  /* ---------- helpers for the section shape ---------- */

  /* 1. Subjective — the patient's report, relayed by the therapist.

     The plainest case, and the baseline the rest are read against: ordinary
     dictation with a laterality, a duration and a pain score in it. If this
     one cannot hold three facts through TTS, STT and the model, nothing below
     it is interpretable. */
  {
    id: "section/subjective-plain",
    lang: "fil-PH",
    section: { field: "subjective", label: "Subjective" },
    why: "the plainest section dictation — laterality, duration and a pain score must all survive",
    turns: [
      { who: "clinician", text: "Patient reports right shoulder pain for about two weeks." },
      { who: "clinician", text: "It is worse at night, around seven out of ten." },
      { who: "clinician", text: "She denies any numbness or tingling in the hand." },
      { who: "clinician", text: "She has trouble reaching overhead to the cupboard." },
    ],
    /* `must` is a literal regex over the transcript, and Chirp 2 returns
       "2 weeks" for spoken "two weeks" — correctly, at 0.0% word error, since
       the WER normaliser reads number words and digits as the same token. The
       duration is graded on the note below, where both spellings are accepted;
       asking for it here only measured which form Google chose to write. */
    heard: { wer: 0.15, must: ["right", "shoulder", "weeks"] },
    expect: [
      { name: "the section was written at all", weight: 3,
        test: (r) => secText(r).length > 20, detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the RIGHT side survived", weight: 3,
        test: (r) => /\bright\b/.test(secText(r)) && !/\bleft\b/.test(secText(r)),
        detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the shoulder survived", weight: 3,
        test: (r) => /shoulder/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the two-week duration survived", weight: 2,
        test: (r) => /two weeks|2 weeks/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the 7/10 pain score survived", weight: 2,
        test: (r) => /7\s*\/\s*10|seven out of ten/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the denial stayed a denial", weight: 3,
        test: (r) => /denies|no numbness|without numbness|denied/.test(secText(r)),
        detail: (r) => `tidied: "${secText(r)}"` },
      { name: "no body region nobody said", weight: 3,
        test: (r) => !/\b(knee|ankle|hip|elbow|wrist|neck|foot)\b/.test(secText(r)),
        detail: (r) => `tidied: "${secText(r)}"` },
    ],
  },

  /* 2. Objective — measurements spoken into a prose box.

     The interesting half is what the section must NOT swallow. Numbers spoken
     here belong in the measurement table, and the endpoint has no table to
     file them into — so the test is that the reading survives as text rather
     than being silently dropped, and that no number is invented. */
  {
    id: "section/objective-measurements",
    lang: "fil-PH",
    section: { field: "objectiveText", label: "Objective" },
    why: "spoken measurements have to reach the objective narrative intact, digit for digit",
    turns: [
      { who: "clinician", text: "Left knee flexion is one hundred ten degrees, extension lacking five degrees." },
      { who: "clinician", text: "Quadriceps strength is four out of five, hamstrings four plus out of five." },
      { who: "clinician", text: "There is mild swelling over the medial joint line." },
      { who: "clinician", text: "Gait shows an antalgic pattern on the left." },
    ],
    heard: { wer: 0.2, must: ["knee", "flexion"] },
    expect: [
      { name: "the section was written at all", weight: 3,
        test: (r) => secText(r).length > 20, detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the LEFT side survived", weight: 3,
        test: (r) => /\bleft\b/.test(secText(r)) && !/\bright\b/.test(secText(r)),
        detail: (r) => `tidied: "${secText(r)}"` },
      { name: "flexion 110 survived digit for digit", weight: 3,
        test: (r) => /110|one hundred ten/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the strength grade survived", weight: 2,
        test: (r) => /4\s*\/\s*5|four out of five/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the swelling reached the section", weight: 1,
        test: (r) => /swelling|swollen/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "no measurement invented that was never spoken", weight: 3,
        test: (r) => !/\b(120|130|90|100)\b/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
    ],
  },

  /* 3. Plan — the section a transcript can least afford to have invented.

     The Plan is what the next clinician follows. A model that pads it with a
     plausible-sounding frequency nobody said is writing a prescription, so
     "nothing invented" carries more weight here than "everything captured". */
  {
    id: "section/plan-no-invention",
    lang: "fil-PH",
    section: { field: "plan", label: "Plan" },
    why: "the plan must carry what was said and not one frequency more",
    turns: [
      { who: "clinician", text: "Plan is to continue therapy twice a week for four weeks." },
      { who: "clinician", text: "We will progress rotator cuff strengthening as tolerated." },
      { who: "clinician", text: "Reassess range of motion at the next visit." },
    ],
    heard: { wer: 0.2, must: ["twice", "week"] },
    expect: [
      { name: "the section was written at all", weight: 3,
        test: (r) => secText(r).length > 20, detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the frequency survived exactly", weight: 3,
        test: (r) => /twice a week|2x\/week|two times a week/.test(secText(r)),
        detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the four-week duration survived", weight: 2,
        test: (r) => /four weeks|4 weeks/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "no home programme invented — none was mentioned", weight: 3,
        test: (r) => !/\bhep\b|home (exercise )?program/.test(secText(r)),
        detail: (r) => `tidied: "${secText(r)}"` },
      /* Word-bounded, and the boundaries are load-bearing: an unbounded /ice/
         matched "tw(ice) a week" and failed this script for a plan that had
         invented nothing at all. A negative assertion that fires on a
         substring of an ordinary word is worse than no assertion — it reports
         the model hallucinating when the model was correct. */
      { name: "no modality invented — none was mentioned", weight: 3,
        test: (r) => !/\bultrasound\b|\be-?stim\b|\btens\b|\bice\b|\bheat\b/.test(secText(r)),
        detail: (r) => `tidied: "${secText(r)}"` },
    ],
  },

  /* 4. Precautions — where a missed word is a hurt patient.

     A weight limit and a time limit, spoken once. Losing either one turns a
     restriction into a suggestion, so both are weight 3 and the transcript is
     also required to carry the number. */
  {
    id: "section/precautions-limits",
    lang: "fil-PH",
    section: { field: "precautions", label: "Precautions" },
    why: "a restriction that loses its number stops being a restriction",
    turns: [
      { who: "clinician", text: "Surgeon says no lifting over five kilos for six weeks." },
      { who: "clinician", text: "No overhead reaching on the operated side." },
      { who: "clinician", text: "Sling to be worn at night for another two weeks." },
    ],
    heard: { wer: 0.2, must: ["lifting", "weeks"] },
    expect: [
      { name: "the section was written at all", weight: 3,
        test: (r) => secText(r).length > 20, detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the five-kilo limit survived", weight: 3,
        test: (r) => /five kilos|5 ?kg|5 kilos/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the six-week window survived", weight: 3,
        test: (r) => /six weeks|6 weeks/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the overhead restriction survived", weight: 3,
        test: (r) => /overhead/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      /* The instruction, not the noun.

         Chirp 2 heard "sling" as "link" on one take in three, and what the
         section writer did with it is the behaviour worth grading: it wrote
         "Link to be worn at night" — faithful to the transcript, inventing
         nothing — and raised an issue saying "'Link' is likely a transcription
         error for 'sling'". Requiring the word `sling` marked that take failed
         when the model had in fact done the only correct thing available to
         it. Silently substituting the clinically-expected word is what a
         model must NOT do here; flagging it is what it must. */
      { name: "the night-time instruction survived, whatever the noun came back as", weight: 2,
        test: (r) => /worn at night|at night/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "a misheard word is flagged, never silently corrected", weight: 3,
        test: (r) => /sling/.test(secText(r))
          || (r.issues || []).some((i) => /sling|transcription/i.test(i.detail || "")),
        detail: (r) => `tidied: "${secText(r)}" · issues: ${JSON.stringify(r.issues || [])}` },
    ],
  },

  /* 5. Past medical history — dates and conditions, nothing added.

     Chirp 2 is at its weakest on bare years, and a PMH that gains a condition
     nobody has is a chart that follows the patient forever. */
  {
    id: "section/pmh-conditions",
    lang: "fil-PH",
    section: { field: "pmh", label: "Past medical history" },
    why: "conditions and years must arrive as spoken, and nothing may join them",
    turns: [
      { who: "clinician", text: "Type two diabetes diagnosed about ten years ago." },
      { who: "clinician", text: "Hypertension, controlled on medication." },
      { who: "clinician", text: "Right rotator cuff repair in two thousand nineteen." },
    ],
    heard: { wer: 0.25, must: ["diabetes"] },
    expect: [
      { name: "the section was written at all", weight: 3,
        test: (r) => secText(r).length > 15, detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the diabetes survived", weight: 3,
        test: (r) => /diabetes/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the hypertension survived", weight: 3,
        test: (r) => /hypertension|high blood/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the prior surgery survived", weight: 2,
        test: (r) => /rotator cuff|repair/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "no condition invented", weight: 3,
        test: (r) => !/\basthma\b|\bcancer\b|\bstroke\b|\barthritis\b|\bcopd\b/.test(secText(r)),
        detail: (r) => `tidied: "${secText(r)}"` },
    ],
  },

  /* 6. Small talk aimed at a section.

     The therapist pressed Dictate and then said nothing clinical. The endpoint
     is instructed to return an empty string, and the panel says so rather than
     writing pleasantries into a signed record.

     The failure this guards against is the model being helpful — inventing a
     line because a section was named and something was said. */
  {
    id: "section/nothing-clinical",
    lang: "fil-PH",
    section: { field: "subjective", label: "Subjective" },
    why: "a burst with nothing clinical in it must write nothing, not something polite",
    turns: [
      { who: "clinician", text: "Good morning, how was the traffic coming over here?" },
      { who: "clinician", text: "Yes the parking lot does fill up after ten o'clock." },
      { who: "clinician", text: "Let me just get this window open, it is warm today." },
    ],
    heard: { wer: 0.3, must: [] },
    expect: [
      { name: "nothing was written into the section", weight: 3,
        test: (r) => secText(r).length === 0, detail: (r) => `tidied: "${secText(r)}"` },
      { name: "no symptom invented out of small talk", weight: 3,
        test: (r) => !/pain|ache|sore|stiff|numb/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
    ],
  },

  /* 7. Content aimed at the wrong section.

     The therapist is dictating into Subjective and states an impression, which
     is an Assessment line. The endpoint may not move it — the therapist aimed
     the microphone and that outranks the model — so the correct behaviour is
     to flag it as `misplaced` and leave the filing to the clinician. */
  {
    id: "section/misplaced-content",
    lang: "fil-PH",
    section: { field: "subjective", label: "Subjective" },
    why: "an impression dictated into Subjective is flagged, never silently re-filed",
    turns: [
      { who: "clinician", text: "Patient reports left elbow pain when gripping, about six out of ten." },
      { who: "clinician", text: "In my assessment this is consistent with lateral epicondylitis." },
      { who: "clinician", text: "She says it started after painting the house last month." },
    ],
    heard: { wer: 0.2, must: ["elbow"] },
    expect: [
      { name: "the patient's own report survived", weight: 3,
        test: (r) => /elbow/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the LEFT side survived", weight: 3,
        test: (r) => /\bleft\b/.test(secText(r)) && !/\bright\b/.test(secText(r)),
        detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the misplaced impression is flagged", weight: 2,
        test: (r) => (r.issues || []).some((i) => i.kind === "misplaced"),
        detail: (r) => `issues: ${JSON.stringify(r.issues || [])}` },
    ],
  },

  /* 8. Taglish into one section.

     The headline dictation claim, at section scale. The section writer gets no
     whole-visit context to lean on, so a code-switched burst is a harder read
     than the same words inside a full conversation. */
  {
    id: "section/taglish-subjective",
    lang: "fil-PH",
    section: { field: "subjective", label: "Subjective" },
    why: "code-switched section dictation has to reach English prose with the facts intact",
    turns: [
      { who: "clinician", text: "Sabi ng patient masakit ang kanang balikat niya for two weeks na." },
      { who: "clinician", text: "Mas masakit daw sa gabi, mga seven out of ten." },
      { who: "clinician", text: "Hindi naman daw namamanhid ang kamay niya." },
    ],
    heard: { wer: 0.35, must: ["balikat"] },
    expect: [
      { name: "the section was written at all", weight: 3,
        test: (r) => secText(r).length > 15, detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the shoulder reached the note in English", weight: 3,
        test: (r) => /shoulder/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the RIGHT side survived the translation", weight: 3,
        test: (r) => /\bright\b/.test(secText(r)) && !/\bleft\b/.test(secText(r)),
        detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the pain score survived", weight: 2,
        test: (r) => /7\s*\/\s*10|seven/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the denial stayed a denial", weight: 3,
        test: (r) => !/numbness|numb/.test(secText(r)) || /den(ies|ied)|no numbness|without/.test(secText(r)),
        detail: (r) => `tidied: "${secText(r)}"` },
    ],
  },

  /* 9. Assessment — an impression, dictated where it belongs.

     The counterpart of the misplaced case: same kind of content, aimed at the
     right box, and here it must be written rather than flagged. */
  {
    id: "section/assessment-impression",
    lang: "fil-PH",
    section: { field: "assessment", label: "Assessment" },
    why: "an impression dictated into Assessment is written, not flagged as belonging elsewhere",
    turns: [
      { who: "clinician", text: "Assessment is subacromial impingement of the right shoulder." },
      { who: "clinician", text: "Limited by pain rather than by true stiffness." },
      { who: "clinician", text: "Good rehabilitation potential given her age and activity level." },
    ],
    heard: { wer: 0.25, must: ["shoulder"] },
    expect: [
      { name: "the impression was written", weight: 3,
        test: (r) => /impingement|subacromial/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the RIGHT side survived", weight: 3,
        test: (r) => /\bright\b/.test(secText(r)) && !/\bleft\b/.test(secText(r)),
        detail: (r) => `tidied: "${secText(r)}"` },
      { name: "content aimed at the right box is NOT flagged as misplaced", weight: 2,
        test: (r) => !(r.issues || []).some((i) => i.kind === "misplaced"),
        detail: (r) => `issues: ${JSON.stringify(r.issues || [])}` },
    ],
  },

  /* 10. The confusable numbers, at section scale.

     numbers/confusables grades these inside a whole visit. Here the same
     digits are dictated into one box with no surrounding conversation to
     disambiguate them, which is the harder ask and the likelier clinic case. */
  {
    id: "section/numbers-tight",
    lang: "fil-PH",
    section: { field: "objectiveText", label: "Objective" },
    why: "digits dictated into one box, with no conversation around them to disambiguate",
    turns: [
      { who: "clinician", text: "Shoulder flexion one hundred fifteen degrees on the right." },
      { who: "clinician", text: "Abduction ninety degrees. Internal rotation forty five degrees." },
      { who: "clinician", text: "Pain at end range is four out of ten." },
    ],
    heard: { wer: 0.25, must: ["flexion"] },
    expect: [
      { name: "the section was written at all", weight: 3,
        test: (r) => secText(r).length > 15, detail: (r) => `tidied: "${secText(r)}"` },
      { name: "115 survived", weight: 3,
        test: (r) => /115|one hundred fifteen/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "90 survived", weight: 3,
        test: (r) => /\b90\b|ninety/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "45 survived", weight: 2,
        test: (r) => /\b45\b|forty[- ]?five/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the 4/10 pain score survived", weight: 2,
        test: (r) => /4\s*\/\s*10|four out of ten/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
    ],
  },

  /* 11. Reason for referral — short, and mostly a name and a diagnosis.

     The shortest burst a therapist would realistically record, and the one
     most likely to be a single sentence. It is here because a section writer
     that needs three sentences to work is no use on the box that gets one. */
  {
    id: "section/reason-short",
    lang: "fil-PH",
    section: { field: "reason", label: "Reason for referral" },
    why: "a one-sentence burst — the shortest thing a therapist would record into a box",
    turns: [
      { who: "clinician", text: "Referred by Doctor Santos for right shoulder impingement, post arthroscopy." },
    ],
    heard: { wer: 0.3, must: ["shoulder"] },
    expect: [
      { name: "the section was written from one sentence", weight: 3,
        test: (r) => secText(r).length > 10, detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the referring doctor survived", weight: 2,
        test: (r) => /santos/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the RIGHT side survived", weight: 3,
        test: (r) => /\bright\b/.test(secText(r)) && !/\bleft\b/.test(secText(r)),
        detail: (r) => `tidied: "${secText(r)}"` },
    ],
  },

  /* 12. A self-correction inside one burst.

     The refine pass reads a whole conversation and can see a retraction three
     sentences later. The section writer gets ONE burst — but the correction is
     inside it, so it has no excuse. Pinning the wrong side is the most
     consequential thing this app can do, at any scale. */
  {
    id: "section/self-correction",
    lang: "fil-PH",
    section: { field: "subjective", label: "Subjective" },
    why: "a therapist correcting themselves mid-burst must not leave both sides in the note",
    turns: [
      { who: "clinician", text: "Patient reports left knee pain going down stairs." },
      { who: "clinician", text: "Sorry, correction, it is the right knee. The right knee is the painful one." },
      { who: "clinician", text: "About five out of ten, and it feels unstable." },
    ],
    heard: { wer: 0.2, must: ["knee"] },
    expect: [
      { name: "the section was written at all", weight: 3,
        test: (r) => secText(r).length > 15, detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the corrected RIGHT knee is what got written", weight: 3,
        test: (r) => /\bright\b/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the withdrawn LEFT is not left standing as a finding", weight: 3,
        test: (r) => !/\bleft\b/.test(secText(r)) || /correct|not the left|initially/.test(secText(r)),
        detail: (r) => `tidied: "${secText(r)}"` },
      { name: "the pain score survived", weight: 2,
        test: (r) => /5\s*\/\s*10|five out of ten/.test(secText(r)), detail: (r) => `tidied: "${secText(r)}"` },
    ],
  },
];

/** The section endpoint's answer, normalised for the assertions above. */
const secText = (r) => norm((r && r.tidied) || "");

/** The reference text a transcript is scored against: everything said, in order. */
const spokenText = (s) => s.turns.map((t) => t.text).join(" ");

module.exports = { SCRIPTS, spokenText };
