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

     The Cebuano one carries a caveat the Tagalog one does not, and --sweep
     measured it: the same script, same words, read by four voices, scored
     30.4% / 23.9% / 19.6% / 10.9% word error. Nearly twenty points of spread
     with the transcriber held constant means the variable is the SPEECH model,
     not Chirp 2 — Filipino is a language it supports and Cebuano is one it
     only half does, so the voice decides how much survives.

     That is why the default voices are the two the sweep scored best (see
     run.js). On a badly-pronounced take this script measures ElevenLabs; on a
     well-pronounced one it measures TheraChart, which is what it is for. Run
     --sweep for the robustness question, and keep a native ear for the rest:
     word error alone still cannot tell a mispronounced take from a misheard
     one. */
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
    why: "near-monolingual Cebuano — laterality from \"tuo nga tuhod\", which Chirp 2 loses 6 times out of 6",
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
];

/** The reference text a transcript is scored against: everything said, in order. */
const spokenText = (s) => s.turns.map((t) => t.text).join(" ");

module.exports = { SCRIPTS, spokenText };
