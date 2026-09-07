# Voice eval — the dictation chain, out loud

Three things test dictation, and until now they stopped short of each other:

| | what it proves | what it never sees |
|---|---|---|
| `test/dictation.test.js` | the recorder's backstops release the mic, don't double-start, don't gate out speech | any audio, any transcript |
| `test/eval/run.js` | the note the model writes from a **clean typed** transcript | anything Chirp 2 got wrong |
| **`test/voice/run.js`** | the note the model writes from **audio Google actually transcribed** | — |

The gap between rows two and three is the reason this exists. A refine prompt
that scores 100% on typed text can still produce a wrong chart in a clinic,
because the text it gets there has been through Chirp 2 first. A run here scores
both halves separately, so a failure says which one broke.

## Setup

1. Put your ElevenLabs key in `.secrets/elevenlabs-key.txt` — one line, nothing
   else. That folder is git-ignored (same place the Gemini key lives). Or set
   `ELEVENLABS_API_KEY`.
2. Be signed in to gcloud (`gcloud auth login`), the same credential `./start.sh`
   uses for Vertex and Speech-to-Text.

```bash
node test/voice/run.js --list-voices     # what your account has
node test/voice/run.js --say-only        # generate the audio only — nothing sent to Google, no cost
node test/voice/run.js --no-refine       # transcription + word error rate only (the cheap half)
node test/voice/run.js                   # everything
```

Pick voices deliberately — **accent is the variable that matters here**:

```bash
node test/voice/run.js --voice-clinician <id> --voice-patient <id>
```

Other flags: `--case knee/` to filter, `--keep-wav out/` to listen to the takes,
`--save-baseline` to record the bar, `--json`, `--room 0.004` for the noise
floor, `--gap 500` for the pause between speakers.

## The voice sweep

```bash
node test/voice/run.js --sweep              # every Filipino-accented voice on the account
node test/voice/run.js --sweep id1,id2,id3  # voices you choose
node test/voice/run.js --sweep --case knee/cebuano-heavy
```

One voice pair produces one number, and a single number cannot tell you whether
a script failed because the **system** is weak there or because that particular
synthetic speaker mangled a word. A clinic is many speakers; the baseline is one.

The sweep speaks every script in several voices — one voice playing both parts,
which keeps attribution clean — and prints the spread, then sorts the rows into
**bad in every voice** (the product's problem) and **voice-sensitive** (the
speaker's). It also reports which `must` words never arrived, and in how many
voices: a word lost by *every* voice is a vocabulary problem, a word lost by one
is a pronunciation problem.

It grades transcription only. Running fifteen notes once per voice would
multiply the Vertex bill to answer a question about hearing.

### What the first full sweep found

15 scripts × 4 Filipino voices, transcription only, $0.45:

```
script                            Juvy  JuanTamad  MangJose    Pedro   spread
knee/cebuano-heavy               30.4%      23.9%     19.6%    10.9%    19.6%
precautions/post-op               8.3%       1.7%      3.3%     1.7%     6.7%
shoulder/tagalog-heavy            3.4%       1.7%      5.1%     1.7%     3.4%
…every other script              ≤8.5%                                  ≤2.8%
MEAN                              6.6%       5.1%      5.3%     4.7%
```

That table reads as though one script is voice-sensitive and it is the Cebuano
one — twenty points of spread on identical words. **It is not. That spread was
noise, and the table above is one take per cell.**

Re-measured with `--takes 5`, reporting the median of five independent
recordings, `knee/cebuano-heavy` is **21.7% for Pedro and 23.9% for Mang Jose**
— a 2.2% spread. Pedro's headline 10.9% was a single lucky generation. Cebuano
sits near 22% for every voice, because `eleven_multilingual_v2` does not speak
Cebuano; the voice was never the variable.

This is the single most important thing to know about this harness: **one take
is one sample.** Anything the number of takes can move, the number of takes will
move. Use `--takes` before believing a Cebuano or Tagalog result.

**Five scripts show 0.0% spread** — identical word error across four different
voices. That is not luck; it means those errors are deterministic properties of
Chirp 2 on that text rather than noise, which is exactly what you want a
regression baseline built on.

**`"negative"` was lost by 4 voices out of 4.** That settles it as a vocabulary
failure rather than a pronunciation one: Chirp 2 drops the word regardless of
who says it, so "extension is negative five" is charted as five degrees of
hyperextension every single time.

## What it costs

The ElevenLabs half is **cached on disk by content hash**, so only the first run
pays for speech; the scripts don't change between runs. Generating all fifteen
from scratch is about **6,900 characters**. The Google half is paid every time —
roughly 9 minutes of audio, about **$0.15 of Speech-to-Text** plus twenty
Vertex refine calls. Scope a run with `--case` and it bills only what it speaks:
`--case lang/` is 135 seconds and about $0.04. Every run prints the bill, and `--say-only` costs nothing
at Google at all.

## The scripts

Twenty, in `scripts.js`. Fifteen aimed at something the codebase already
worries about, and five more — the `lang/` matrix, described further down — that
hold the visit fixed and vary only the language:

- **`shoulder/clinical-vocab`** — the `STT_PHRASES` boost list, spoken. MMT,
  AROM, Neer, Hawkins, scaption, subacromial, therex, HEP. That list was
  reasoned about and never measured.
- **`knee/laterality-correction`** — a mid-sentence retraction. The pin has to
  move, not duplicate. Weight 3 both ways.
- **`back/taglish-negation`** — code-switched speech, and `walang numbness`,
  where dropping one Tagalog word turns a denial into a red flag.
- **`ankle/cebuano`** — the `ceb-PH` code, which is offered in the language menu
  and had never been exercised end to end.
- **`hip/not-the-patient`** — a hypothetical and another patient's hip, both
  transcribed faithfully, neither of which may reach the chart.
- **`numbers/dense`** — degrees, MMT grades, pain scores. The one class of error
  that leaves the sentence looking perfectly fine.
- **`shoulder/tagalog-heavy`** — near-monolingual Tagalog, no English to lean on.
- **`knee/cebuano-heavy`** — near-monolingual Cebuano, same idea. See the caveat
  below: this one measures ElevenLabs as much as it measures TheraChart.
- **`visit/long-full-session`** — a 90-second visit, so it is cut into two
  chunks. The path that transcribes each piece separately and stitches them back
  — leaving a marked hole when one fails, rather than welding two unrelated
  sentences together — had never been exercised by anything.
- **`numbers/confusables`** — thirty/thirteen, fifteen/fifty, forty/fourteen,
  sixty/sixteen, in the places a chart uses them.
- **`multi-region/shoulder-and-back`** — two complaints must stay two. Every
  other script has one region, which is the easy case.
- **`relay/third-person`** — a note dictated entirely as "patient reports…",
  which is how documentation is taught. `refineSystem` has a paragraph on it.
- **`precautions/post-op`** — a weight-bearing limit and an anticoagulant. The
  one section where an omission reads as clearance.
- **`smalltalk/nothing-clinical`** — nothing clinical is said. An empty findings
  array is the correct answer, and the microphone is open through the small talk
  at the start of every appointment.
- **`bilateral/both-knees`** — "pareho" must pin both sides; half a bilateral
  finding reads as a unilateral problem.
- **`lang/english-only`**, **`lang/tagalog-only`**, **`lang/cebuano-only`**,
  **`lang/taglish`**, **`lang/bisaya-english`** — one visit, five languages,
  nothing else changed. See [The language matrix](#the-language-matrix--lang).

## Can ElevenLabs actually speak Tagalog and Cebuano?

Measured, not assumed:

| | word error | verdict |
|---|---|---|
| Taglish (`back/taglish-negation`) | **1.8%** | excellent |
| Near-monolingual Tagalog | **3.4%** | excellent |
| Cebuano + English (`ankle/cebuano`) | 8.1% | usable |
| Near-monolingual Cebuano | **26.1%** | **treat with suspicion** |

**Tagalog is genuinely supported** by `eleven_multilingual_v2` and it shows —
3.4% word error on a script with almost no English in it.

**Cebuano is not a language that model officially speaks**, and the failures
look like pronunciation rather than transcription. The giveaway: `tuhod` (knee)
came back as `tungtuhod` **both** times it was spoken, including once where the
preceding word was different — so the speech, not the transcriber, is inserting
the sound. That swallowed `tuong` (right) and the note pinned a knee with **no
side at all**.

So read `knee/cebuano-heavy` as a test of ElevenLabs first and TheraChart
second. `--keep-wav` plus a native ear is the only thing that settles which
half is at fault, and a real Bisaya speaker would very likely do better than
this take does. Do not conclude from it that `ceb-PH` dictation is broken.

### Why Cebuano is not "fixed", and what was tried

Four levers, measured rather than assumed. The target was the word `tuong`
(Cebuano for *right*), which decides which knee reaches the chart:

| lever | result |
|---|---|
| `eleven_v3` (natively supports `ceb`) | **helps, with the right voice** — see below |
| `stability` 0.5 → 0.85 | no help — 1/5 → 2/5 survival |
| fixed `seed` | **does not reproduce** — same byte length, different audio |
| pronunciation dictionary | **applied and confirmed, but no gain** — 2/8 → 3/8 |

`eleven_v3` was written off here on single-take evidence and that was wrong.
Re-measured as the median of five takes on `knee/cebuano-heavy`:

```
                      Pedro   Mang Jose
eleven_multilingual_v2 21.7%      21.7%
eleven_v3              15.2%      28.3%
```

So v3 is the best Cebuano available — **but only paired with the right voice**,
and it re-introduces a 13-point spread that multilingual_v2 does not have. Even
at its best it is ~9× the error of the equivalent Tagalog script (1.7%).

The one Cebuano result that IS solid is `ankle/cebuano`, the mixed
Cebuano-and-English script: **8.1% with 0.0% spread across both models and both
voices.** English scaffolding carries it. That is the Cebuano coverage to trust,
and `knee/cebuano-heavy` is marked `advisory` — reported, and in the baseline
diff, but it does not fail a run.

The dictionary was verified working with a sentinel rule (`tuong` → `kaliwang`,
which came back as "kaliwang" on both models), so that is a real negative
result, not broken plumbing. Aliases tried: `tu-ong`, `tuo nga`, `tuóng`,
`too-ong`, `twong`.

`tuong` survives roughly **half the time**, and nothing moved it. An assertion
resting on it is reporting a coin toss. That is a limit of synthetic Cebuano, not
of TheraChart — the fix is to know it, which is what `--takes` is for.

### Which half is actually failing — settled

Two things were blamed here before the measurement was done properly, and
neither was at fault.

**Most of it was the script.** The first `knee/cebuano-heavy` used the
contracted `tuong tuhod` and `motungas ko sa hagdanan`, and scored 26.1% word
error. Ordinary written Cebuano — `tuo nga tuhod`, `mosaka ko ug hagdan` — took
the same script to **7.5%**.

**The rest was one voice.** Twelve takes of the rewritten script, same
transcriber, same model, same phrase list — only the reader changes:

| audio | real word error | laterality kept |
|---|---|---|
| Pedro reads both parts | **1.7%** | **12/12** |
| Mang Jose reads the patient | 6.0% | 7/12 |

Mang Jose speaks the `tuo nga tuhod` line, and he is the reason it went missing.
With a voice that says the word, **Cebuano transcribes about as well as Tagalog**
(the Tagalog script sits at 1.7%). That is why the script carries a per-script
voice override.

The phrase list turned out to be near-neutral here — 6.0% with it, 5.4% without,
on the two-voice audio — so it stays on, as it is measurably worth having on
clinical English.

**Two corrections worth keeping**, because both were confident and both were
wrong:

1. This file once reported **0/6 for Chirp 2 against 6/6 for Scribe** and
   concluded Cebuano laterality does not survive dictation. That was measured on
   `eleven_v3` audio, switched on while investigating whether v3 helped. It does
   not — v3 scores 0/10 on that word where the default `multilingual_v2` scores
   7/10. The number described the wrong speech model.
2. It then reported **7/10, "three visits in ten lose the side."** That was
   measured on two-voice audio and was really 12/12 for a good voice against
   7/12 for a poor one. The number described the wrong voice.

Both mistakes have the same shape: a single configuration measured once and
generalised. `--takes` and `--sweep` exist to prevent exactly that, and neither
was used before drawing the conclusion.

### What this means for the product

**Less than it appeared.** Cebuano dictation reads about as well as Tagalog when
the speech is clean. The review-time "which side?" prompt stays, but it is a
general guard rather than a Cebuano patch: a side that was spoken and not
transcribed cannot be recovered downstream in any language, and that is the one
word whose loss puts a finding on the wrong half of the body.

Four levers were tried against the Cebuano gap while it still looked large.
**None is worth shipping**, and `chirp_2` + the phrase list stays exactly as it
was.

- **Speech adaptation.** Adding `tuo/tuong/wala/kanan/kaliwa` to `STT_PHRASES`
  at boost 15 changed nothing.
- **A different language code.** `fil-PH` on Cebuano audio scores level with
  `ceb-PH`. Noise.
- **`chirp_3`.** Probed live across nine regions. It **does not exist** in
  us-central1, us-east1, us-west1, europe-west4 or global; in asia-southeast1
  and asia-south1 it returns *403 "no longer generally available"* for this
  project; and in `us` and `eu` it **has no Cebuano at all** — both `ceb-PH` and
  `ceb` are refused. Reachable only as `fil-PH` in `us`, where it scores 10.9%
  real error against `chirp_2`'s 3.1% on the same audio. Worse, and without the
  language.
- **`chirp` v1.** Keeps the laterality word well, but silently drops whole
  utterances — it lost the entire first half of `ankle/cebuano`. Implemented,
  measured, reverted. A note missing sentences is worse than one missing a side.

**What would settle it:****What would settle it:** two minutes of a real Bisaya speaker reading
`knee/cebuano-heavy`. The harness takes any 16 kHz mono WAV, so a human take
drops straight in — and running it through both transcribers would answer, for
real audio, whether `ceb-PH` is good enough to offer in the dictation menu.

Note the scorer knows Tagalog and Cebuano numerals (`isa`…`sampu`,
`usa`…`napulo`), because a patient asked "kung isa hanggang sampu?" answers in
them — without that it charged an error every time Chirp 2 correctly heard
`sampu` and wrote `10`.

Each carries a `heard` block (word-error ceiling, and words that must survive at
all) and an `expect` block graded on the refine result exactly the way
`test/eval/cases.js` grades it, same weights.

## The language matrix — `lang/`

Everything above varies the clinical problem and lets the language fall where it
may. That is the right way to test the chart and the wrong way to answer *how
does dictation hold up in the language this clinic actually speaks*, because no
two of those scripts say the same thing: a worse score on the Cebuano one could
be the language, or it could be that it is a different visit.

The five `lang/` scripts are the controlled version. Same patient, same visit,
same facts every time — left elbow, sore three weeks, worse lifting, six out of
ten, no numbness, flexion 120° where a clinician would say it in English. Only
the language changes.

```bash
node test/voice/run.js --case lang/                                  # scored, ~$0.04
node test/voice/run.js --sweep <pedro>,<mangjose> --takes 3 --case lang/   # the table below
```

Two things are deliberate. The monolingual scripts have **no ROM turn** — a
Filipino PT says "flexion is one hundred twenty degrees" in English even
mid-Tagalog sentence, and inventing a Tagalog rendering nobody speaks would
measure a language that does not exist. And the side is **left**, which is the
sharp end for Cebuano: `wala` is both *left* and *none*, and this visit says it
in both senses. `knee/cebuano-heavy` tests one direction (a denial must not
become the left knee); `lang/cebuano-only` tests the harder one.

### What the matrix found

Median of 3 takes per cell, two voices, transcription only, $0.22:

```
script                    Pedro  Mang Jose   spread
lang/english-only          2.7%       2.7%     0.0%
lang/tagalog-only          1.7%       0.0%     1.7%
lang/cebuano-only         20.0%      18.2%     1.8%
lang/taglish               4.1%       4.1%     0.0%
lang/bisaya-english       15.9%      14.3%     1.6%
```

**Tagalog transcribes better than English does.** 0.0–1.7% against the English
control's 2.7%, on the same visit. That is not a rounding artifact — it holds in
both voices, and it retires any lingering worry that `fil-PH` is a second-class
path. **Taglish is solid too** at 4.1% with 0.0% spread in both voices, which is
the shape almost every Manila visit actually has.

**Cebuano is genuinely harder, and it is not the voice.** Both Cebuano rows land
in "bad in every voice" with **1.6–1.8% spread** — the speaker is not the
variable, so this is the language, the transcriber, or `eleven_multilingual_v2`'s
grasp of Cebuano, exactly as the sweep is designed to separate.

**English scaffolding rescues Cebuano less than this file previously claimed.**
The measured verdict above — mixed Cebuano-and-English holds 8.1%, "that is the
Cebuano coverage to trust" — came from `ankle/cebuano`, four short turns.
`lang/bisaya-english` is the same idea over a full seven-turn visit and scores
**15.1% mean**, roughly double. The English words help in proportion to how many
there are; a visit that is mostly Cebuano scores mostly like Cebuano. Read the
8.1% as a property of that short script, not of code-switching in general.

**`siko` is a coin flip in both languages** — heard in 5 of 6 recordings in
`lang/tagalog-only` *and* 5 of 6 in `lang/cebuano-only`. Same word, same rate,
two different languages and two voices, which makes it a vocabulary gap rather
than anyone's diction. It matters more than a typical dropped word: `siko` is
the *region*, mapped at `parser.js:100` and `parser.js:825`, so losing it loses
the elbow entirely rather than garbling a detail. At the time this was measured
no Filipino body-part word was in `STT_PHRASES` at all.

That observation is what prompted `probe/`, and the probe then **walked it
back**: `siko` arrives 6/6 in a different carrier sentence, so it is marginal
rather than broken and it was NOT boosted. See
[The vocabulary probe](#the-vocabulary-probe--probe) for what was, and for the
measured before-and-after.

### The part that matters for the product

**The note came out right in all five languages.** A scored run of `--case lang/`
took 57 of 57 weighted points — every language pinned the left elbow, none
invented a right one, every 6/10 rating reached the chart, and no denial was
offered as a pin. That includes both Cebuano scripts, at 14–16% word error.

So the chart survived word error that looks alarming in a table. The refine pass
is reading around the gaps, which is the whole reason this harness scores the
note separately from the transcript. **But that is one take per language**, and
`siko` arriving is a coin flip — a run where it drops is the run worth watching,
and nothing here has measured how often the note survives that. That is the next
measurement, not a conclusion this file can offer yet.

## The vocabulary probe — `probe/`

Two scripts that are instruments rather than regression tests. They exist to
answer one question: **which** of the Filipino body-part words the parser
already understands actually survive Chirp 2. They are excluded from a bare run
(`probe: true`) and have to be named:

```bash
node test/voice/run.js --sweep <pedro>,<mangjose> --takes 3 --case probe/
```

The question is live because the two halves of the app disagree. `parser.js`
maps about twenty-five Tagalog and Cebuano body-part words (`REGIONS` at
:90-120, `JOINT_ALIASES` at :822) — so the chart understands every one of them
if it arrives — while **none** is in `STT_PHRASES`, so nothing nudges Chirp 2
to produce them. Losing one of these words does not garble a detail; it loses
the **region**, and a region that never arrives cannot be treated or billed for.

Each word sits in a clinical carrier sentence, because a word spoken alone is a
different recognition problem than the same word mid-clause, and mid-clause is
the one the clinic has. The word error rates these two report are meaningless —
the density is nothing like speech — so both are advisory and neither carries an
`expect` block. The `must` survival rates are the entire output.

### What the probe found

30 words, 2 voices × 3 takes = 6 recordings each, $0.10:

```
                                     Pedro  Mang Jose
probe/tagalog-parts                   1.1%       2.2%
probe/cebuano-parts                  28.3%      21.7%

word          meaning   heard   language
bat-ang       hip        0/6    Cebuano     NEVER
lulod         shin       1/6    Tagalog
kumagko       thumb      2/6    Cebuano
buol-buol     ankle      4/6    Cebuano
hita          thigh      5/6    Tagalog
hinlalaki     thumb      5/6    Tagalog
…the other 24 words     6/6                 arrived every time
```

**A table of all twenty-five would be about 80% waste.** Fifteen of eighteen
Tagalog words and eight of twelve Cebuano words arrived in every single
recording. Six words is the whole shortlist, and boosting thirty to fix six
would take on the homophone risk of `paa`, `palad` and `hita` for no gain — the
list already refuses ordinary words for exactly that reason.

**`siko` arrived 6/6 here**, having been 5/6 in both `lang/` scripts. Same word,
different carrier sentence. The one data point that motivated this whole
question is *marginal*, not broken — which is a good argument for probing before
tabulating, and a reminder that a 5/6 is a coin flip in both directions.

**The Cebuano failures may not be TheraChart's at all.** This is the confound
that runs through this entire file: `probe/cebuano-parts` scores 25% word error,
so the audio itself is suspect, and `bat-ang` at 0/6 is as easily
`eleven_multilingual_v2` failing to *say* the word as Chirp 2 failing to hear
it — exactly the way `tuhod` came back as `tungtuhod` because the speech, not
the transcriber, inserted the sound. Speech adaptation cannot fix a word the
speaker never pronounced. **Tagalog carries no such doubt** — it transcribes at
0.0–2.2% here, so `lulod` at 1/6 is a credible recognizer gap rather than a
synthesis artifact.

### Did the boost work — yes, and the run came with its own control

`lulod` was added to `STT_PHRASES_BY_LANG["fil-PH"]` and everything re-measured
the same way, median of 3 takes across the same two voices:

```
                          BEFORE            AFTER
                      Pedro  MangJose   Pedro  MangJose
probe/tagalog-parts    1.1%      2.2%    0.0%      0.0%
probe/cebuano-parts   28.3%     21.7%   28.3%     20.0%

lulod (shin)            1/6                6/6
```

**`lulod` went from 1 of 6 recordings to 6 of 6**, and `probe/tagalog-parts`
fell to 0.0% word error in both voices — every Tagalog body-part word in the
region table now arrives every time except `hinlalaki`. So speech adaptation
*does* work on this class of word, which is worth knowing given it did nothing
for the laterality words: the difference is that `lulod` is a long, distinctive
content noun and `wala`/`tuo` are short function words with homophones
everywhere.

**The `ceb-PH` scripts are the control, and they are why the other movements
should be ignored.** Nothing was added to the Cebuano list, so any change there
is noise by construction — and there was plenty:

```
                       BEFORE          AFTER
lang/cebuano-only   20.0 / 18.2    14.5 / 18.2     Pedro moved 5.5 points
lang/bisaya-english 15.9 / 14.3    15.9 / 17.5     Mang Jose moved 3.2 points
kumagko                    2/6            1/6
siko in cebuano-only       5/6            4/6
```

Those scripts were not touched by this change, so **the noise band on a
median-of-3 Cebuano cell is roughly ±3–5 points.** `lang/english-only` moving
2.7% → 4.0% for one voice sits inside the same band and is not a regression from
the boost — it is one word in seventy-five. Read nothing into any of it.

That is the useful methodological result: an untouched language in the same run
is a free control, and it calibrates how big a change has to be before it means
anything. On this evidence, only the `lulod` result clears the bar.

`hita` also went 5/6 → 6/6 without being boosted, which is the same point from
the other direction — 5/6 is a coin flip, and it landed heads this time.

### How the table is gated

`STT_PHRASES` used to be sent unconditionally — `sttRequestBody` took `language`
and used it only for `languageCodes`, so every request got the same list.
`STT_PHRASES_BY_LANG` (server.js) now adds per-code entries on top of the shared
clinical-English list.

What that buys is keeping Cebuano vocabulary out of Manila's audio. What it does
**not** buy is protection for English: the menu offers only two codes — fil-PH
is "English & Tagalog", ceb-PH is "English & Cebuano" (app.js:4382) — so there
is no English-only path, and anything added for fil-PH is boosted against
English speech in the same room. That is why `hita` (thigh) was measured as a
candidate and refused: "hit a" is an ordinary thing to say, and a false thigh
finding is worse than a missed one. `lulod` has no such neighbour.

And temper the expectation: this lever has underperformed twice here. Adding
`tuo`/`tuong`/`wala`/`kanan`/`kaliwa` at boost 15 changed nothing, and
`negative` still went missing in half the voices at 15 and needed 20. Measure
after, not just before.

### Cebuano: the sound was always there — corrected 2026-09-06

This file has said in several places that synthetic Cebuano is the instrument's
limit, and that a word lost in a Cebuano script is as likely to be ElevenLabs
failing to *say* it as Chirp 2 failing to hear it. For at least some words
**that is now measurably wrong.**

The experiment holds the audio byte-identical — every take was cached — and
changes only the recognizer's phrase list. Adaptation cannot recover a sound
that is not in the recording, so any recovery proves the sound was there:

```
word                 no boost   boost 15   boost 20
bat-ang   (hip)           0/6        3/6        5/6
kumagko   (thumb)         1/6        4/6        3/6
buol-buol (ankle)         4/6        5/6        5/6
lapa-lapa (sole)          6/6        5/6        6/6   ← never boosted
```

**`bat-ang` went from never arriving to 5 of 6 without a single sample of audio
changing.** ElevenLabs was saying it all along. Chirp 2 had the acoustic
evidence and was not confident enough to return the word, which is a *lexicon*
problem and exactly what speech adaptation is for. The progression 0 → 3 → 5 is
monotonic in the boost, which is what a genuine confidence effect looks like and
not what noise looks like.

`buol-buol` and `kumagko` are weaker results — `kumagko` runs 1 → 4 → 3 and
should not be claimed as an improvement at all. `bat-ang` is the finding, and it
is the only one of the three that shipped.

**The other two were tried and removed, and removing them mattered.** With all
three boosted, `knee/cebuano-heavy` ran 12.5% for Pedro against 10.0% unboosted;
with `bat-ang` alone it is back to 10.0% and `bat-ang` still holds 5/6. So the
2.5 points were the cost of two words that could not show a gain — which is the
whole argument for measuring each entry rather than adding a table. `ankle/cebuano`
never moved through any of it, sitting at its documented 8.1%.

**Watch the fourth row.** `lapa-lapa` was never boosted and dropped to 5/6 at
boost 15 before returning at 20. `kumagko` and `lapa-lapa` sit in the *same
sentence* of the probe, so that is boost competition — making one reading
likelier at a neighbour's expense, which is the cost the top of `STT_PHRASES`
warns about. The probe overstates it, though: it packs two body parts per
sentence, and no real visit says "thumb" and "sole of the foot" in one breath.

**What this does NOT settle.** The overall Cebuano word error — 18% on
`lang/cebuano-only`, 25% on the probe — is still unattributed, and the
`tuhod` → `tungtuhod` evidence for synthesis being at fault still stands for
*that* word. What is settled is narrower and still useful: **"synthetic Cebuano
is too broken to measure" is not a blanket excuse.** Individual word failures
have to be tested one at a time, and the boost test is cheap and decisive
because the audio never changes.

The realistic scripts confirm the change is safe rather than helpful:
`lang/cebuano-only` sits at 18.2% and `lang/bisaya-english` at 15.9% after,
both inside the ±3–5 point band those two scripts already demonstrate. Neither
contains any of the three words, so no movement was expected in either
direction — the point of running them was to catch a regression, and there
isn't one.

## What this does NOT prove

**The word error rates are a floor, not a clinic measurement.** ElevenLabs speech
is clean, evenly-levelled, one speaker at a time, with no room, no mic distance
and no overlap. Chirp 2 does better on it than on a real visit. Read these
numbers as a *regression signal* — "did this change make transcription worse" —
not as an accuracy claim. The 8.8% / 27.7% figures in `README.md` and
`server.js` came from real human readings and should stay that way; don't
overwrite them with numbers from here.

`--room` mixes a low noise floor under the speech, which makes the audio a
little more honest and gives the voice gate something to calibrate against, but
it is not a clinic.

**Some assertions were variance-dependent.** `ankle/cebuano`'s ROM check used to
pass or fail on whether the refine pass happened to write "limited, about 10
degrees" with a comma. Both that and the wider extraction bug behind it are
fixed; five independent takes now score it 100% each time.

### Does the chart survive a lost Cebuano word? Measured — yes, 10/10

The open question after the language matrix was the one the matrix could not
answer: every Cebuano note scored 100%, but each was a single take, and `siko`
arrives only 4-6 times in 6. A note cannot pin a region that never reached the
transcript, so the runs that mattered were the ones nobody had sampled.

`--takes` now works on a scored run (it used to be read only by the sweep, so a
scored run silently ignored it and reported one sample as if it were a result).
Five independent recordings of each Cebuano script, graded end to end:

```
ankle/cebuano       #1 16.2%  #2 8.1%  #3 5.4%  #4 10.8%  #5 10.8%   note 100% ×5
lang/cebuano-only   #1 14.5%  #2 16.4%  #3 27.3%  #4 10.9%  #5 14.5%  note 100% ×5

TRANSCRIPTION  mean word error 13.5%
NOTE           100.0%  (80/80 weighted points)
```

**Takes #3 and #5 lost `siko` outright** — the transcript did not contain the
word for elbow at all — and both still pinned the left elbow, filed the 6/10 and
kept the denial off the body map. Take #3 did it at 27.3% word error, the worst
recording in the set.

So the refine pass is recovering the region from the surrounding sentences
rather than from the single word, which is the behaviour you would want and
which nothing had previously demonstrated. **80 of 80 weighted points across ten
independent Cebuano recordings** is the strongest evidence in this file that
Cebuano dictation is safe to offer.

Two limits, as always. This is synthetic speech, so the word error is a floor
and not a clinic number. And "the model recovered it twice out of ten" is not
"the model always recovers it" — a script whose ONLY mention of the region is
the lost word would have nothing to recover from, and this one mentions the
elbow more than once.

### The ROM-extraction bug — fixed 2026-09-06

`ROM_FILLER` in parser.js joined filler words from a closed allow-list, so
**anything between the motion and the value that was not on the list dropped the
reading entirely** — silently, with nothing on screen to say a number had been
spoken. Six of twelve realistic phrasings were lost:

```
right shoulder flexion is 60 degrees        → found
knee flexion, 90 degrees                    → found  (the comma was fixed earlier)
shoulder flexion on the right is 60 degrees → LOST   a side, stated after the motion
hip flexion in supine is 110 degrees        → LOST   a position
knee flexion today is 90 degrees            → LOST   a time word
knee flexion passively 120 degrees          → LOST   a manner word
shoulder abduction after therapy is 100 deg → LOST   a context phrase
```

All twelve now read. An unnamed word passes, up to four of them, and three
guards keep the reach honest: the unit is still required, so `3 sets of 10` and
`4 out of 5` cannot match; a joint, a motion or a clause connector ends the run,
so a value belonging to the next measurement is never stolen by the one before
it; and the separator takes only whitespace and commas, so a full stop stops it.

**Two things the test suite caught that the first attempt got wrong**, both
worth knowing before touching this again:

1. **The gap ate the SIGN.** `negative`, `minus` and `neg` belong to `ROM_SIGN`,
   which lives inside the value's own capture group. An unnamed-word run that
   walks past `negative` leaves the reading with its sign stripped — "extension
   is negative five" files as five degrees of *hyperextension* where the
   therapist dictated a flexion *contracture*. The opposite finding, in a signed
   chart, reading perfectly well. They are stop words now.
2. **It was applied to the unitless pass.** `ROM_FILLER` is shared with the
   pattern that accepts a bare number with no `degrees` after it, where the
   "unit is required" guard does not exist — and widening that invented a
   3-degree abduction out of ordinary prose. There are two fillers now: the wide
   one is used only where `ROM_DEGREES` demands a literal unit.

`numbers/confusables` and `ankle/cebuano` were both really measuring this one
defect. `ankle/cebuano` was also described here as variance-dependent for that
reason; across five independent takes it now scores 100% every time.

### What the review screen does and does not catch

Worth stating plainly, because it decides how much a transcription gap actually
costs. The review screen chips every finding with where it came from — `no-side`
("which side?"), `misheard`, `ungrounded` ("not traceable to the transcript"),
`live-only`, `corrected`, `hypothetical`, `not-the-patient`, `denied` — and it
explains every measurement it declined to file ("Not filed — …: reason").

**What it could not show was something that never arrived.** A region word lost
in transcription produces no finding, so there is no row to chip; a ROM reading
the parser failed to extract was in neither the "to file" list nor the "not
filed" one. The therapist saw a note that looked complete. That is why the
extraction bug above mattered more than its size suggests.

Half of that is now closed. `unfiledMeasurements()` (parser.js) scans the
transcript for every number carrying a unit the chart files — degrees, `/5`,
`/10` — subtracts the ones that landed in a row, and the review screen warns
about the remainder in the therapist's own words:

> **A number was spoken that isn't in the list above.** Check the transcript and
> add it by hand if it belongs in the chart.
> *"Knee flexion was limited by pain to 90 degrees."*

It is deliberately **digits only, and only where the unit is spoken**. A
word-form "pito sa sampu" that the parser read correctly is never detected, and
that is the right way round to be wrong: a missed warning costs nothing, while a
false one teaches a therapist to ignore the banner and then the real ones go
unread too. Measured at **zero false positives across all twenty-two voice
scripts**, and the two it did produce in development were both sign bugs — a
range dash read as a minus, and a missed word-form `negative` — each inventing a
mismatch against a row that was perfectly correct. Both are regression tests now.

**The other half is closed too, by a different tell.** A lost region word still
creates no finding, and a finding that was never created cannot be chipped — so
the signal has to come from what survived. A **laterality word** is that signal:
it is only ever said about a body part, so a side spoken with nothing sided on
the body map means the part went missing between the microphone and the chart.
`unpinnedSide()` reports it, and the review screen says so under Findings:

> **A side was mentioned, but nothing on the body map has one.** Dictation may
> have missed the body part.
> *"Masakit po ang kaliwang ___ ko, mga tatlong linggo na."*

Measured the same way as the other one — by deleting the region word from real
scripts to simulate the failure:

```
                                       false positives   caught
side word, nothing sided pinned            0 / 22         6 / 6
pain score, no region at all               0 / 22         1 / 4
motion implies a joint that isn't pinned   3 / 22         2 / 4
```

Only the first shipped. The pain signal is clean but weak — pain usually rides
in a sentence that names the region anyway. The motion signal is too noisy as
it stands, and all three of its false positives are near misses where the region
WAS named under a neighbouring word: `dorsiflexion` expects `Ankle` and the
patient said `tiil`, which maps to `Foot`. A joint-synonym map would probably
rescue it; until someone writes one it would cry wolf three visits in
twenty-two, which is how a banner stops being read.

Two traps worth knowing if this is ever edited. **Bare `wala` must never
trigger it** — Cebuano for LEFT, Tagalog for NONE, and the Tagalog sense is how
half these visits record a denial, so only the uncontracted `wala nga` counts.
And the English idioms need real care: "right" is an ordinary word and "left" an
ordinary verb. The exclusion list for those was written without `\b` anchors at
first, which silently matched the `he right` inside **the** right — and the
warning went quiet on the exact sentence it exists for.

**It does not exercise the browser recorder at all.** The voice gate, the idle
backstop, the per-visit ceiling and the chunk-at-a-pause logic all live in
`app.js` and are bypassed here — this posts finished WAVs straight to
`/api/stt`. `test/dictation.test.js` covers those against a fake AudioContext.

To close that last gap, `--keep-wav` writes the takes in exactly the format the
recorder produces, and Chromium will play a WAV file into `getUserMedia`:

```
--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<take>.wav
```

Dropped into `playwright.config.js` launch args, that would drive the real
recorder end to end. Not built yet — the scripts and the audio are the
prerequisite, and they're here.
