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
from scratch is about **5,100 characters**. The Google half is paid every time —
roughly 7 minutes of audio, about **$0.11 of Speech-to-Text** plus fifteen
Vertex refine calls. Every run prints the bill, and `--say-only` costs nothing
at Google at all.

## The scripts

Six, in `scripts.js`, each aimed at something the codebase already worries about:

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

Everything else here measures the speaker and the transcriber in series and
cannot say which one is weak. ElevenLabs' own speech-to-text (Scribe) gives a
second pair of ears on the *identical WAV*, which separates them.

**Most of the Cebuano problem was the script, not either engine.** The first
version of `knee/cebuano-heavy` used the contracted `tuong tuhod` and
`motungas ko sa hagdanan`, and scored 26.1% word error. Ordinary written
Cebuano — `tuo nga tuhod`, `mosaka ko ug hagdan` — took the same script to
**7.5%**, and took the laterality word from a coin flip to 7 takes in 10.

What is left is a real but modest gap. One line, `"Sakit ang tuo nga tuhod"`,
10 fresh takes on the harness's default voice and model, same WAV to both:

```
"tuo" (right) survived    Google Chirp 2: 7/10     ElevenLabs Scribe: 10/10
```

Over a wider sample — 4 scripts × 3 takes, 480 reference words, errors
classified by hand into real mishearings versus Cebuano spelling variation:

| | real errors | spelling variants |
|---|---|---|
| Google Chirp 2 | 14.6% | 3.5% |
| ElevenLabs Scribe | **8.3%** | 5.0% |

And Chirp 2 is not a weak transcriber in general — on Tagalog it beats Scribe
(1.7% vs 5.1%). It is specifically, and moderately, weaker on Cebuano.

**A correction worth keeping.** An earlier version of this file reported that
figure as **0/6 for Chirp 2 against 6/6 for Scribe**, and concluded that Cebuano
laterality simply does not survive dictation. That measurement was taken on
`eleven_v3` audio, which had been switched on while investigating whether v3
helped — and v3 is *worse* at this word than the default `multilingual_v2`
(0/10 against 7/10). The number described the wrong speech model, not the
transcriber. Check which TTS model a take came from before drawing a conclusion
from it; `--sweep` and `--takes` exist for exactly this reason and neither was
used for that test.

### What this means for the product

**About three Cebuano visits in ten lose the side.** A patient saying `tuo nga
tuhod` gets a knee pinned with no side whenever the word does not survive — the
transcript never carries it, so the model has nothing to read it from. Usually
it does survive; sometimes it does not, and nothing downstream can tell the
difference. That is not a harness artefact, and the dictation menu offers
`ceb-PH` today.

Four levers were tried. **None is worth shipping**, and `chirp_2` + the phrase
list stays exactly as it was.

- **Speech adaptation.** Adding `tuo/tuong/wala/kanan/kaliwa` to `STT_PHRASES`
  at boost 15 changed nothing: still 0/6. An ineffective phrase only dilutes a
  list whose own comment says so.
- **A different language code.** `fil-PH` on Cebuano audio scores 13.2% against
  `ceb-PH`'s 14.9% real errors. Noise.
- **A newer model.** Probed live across every model and region this project can
  reach. `chirp_3` is **unsupported or has no `ceb-PH`** in all four regions
  tried; `latest_long`, `long`, `short` and `telephony` have no `ceb-PH` at all.
  `chirp_2` and `chirp` are the only two options that exist.
- **The older model.** `chirp` v1 looked like the answer — it keeps `tuo` **8
  takes out of 8** where `chirp_2` gets 0, and scores better on pure Cebuano.
  It was implemented, measured against the real scripts, and **reverted**: it
  silently drops whole utterances. On `ankle/cebuano` it lost the entire first
  half of the visit, and on `knee/cebuano-heavy` it dropped the pain rating.
  That is the same failure the `STT_LANGS` comment describes for `en-US` on
  Tagalog, and a note missing whole sentences is worse than one missing a side.

**So `chirp_2` is the best available**, and the gap it leaves is handled in the
review screen instead: a finding on a region that has a left and a right,
arriving with no side, is now labelled *"which side?"* rather than pinned at the
figure's centre as though that were an answer. See `PR.isPaired` in parser.js.

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

**Some assertions are variance-dependent, not stable.** `ankle/cebuano`'s ROM
check passes or fails depending on whether the refine pass happens to write
"limited, about 10 degrees" with a comma. Until that is fixed, read a single run
of it as a coin flip, not a verdict.

### The open ROM-extraction bug, as currently understood

`ROM_FILLER` in parser.js joins filler words with `\s+`, so **anything between
the motion and the value that is not on its short allow-list drops the reading
entirely** — silently, with nothing on screen to say a number was spoken:

```
right shoulder flexion is 60 degrees        → found
shoulder flexion on the right is 60 degrees → LOST   (a side, stated after the motion)
knee flexion, 90 degrees                    → LOST   (a comma)
knee flexion today is 90 degrees            → LOST   (a time word)
```

It was first found as "a comma bug" via `ankle/cebuano`; `numbers/confusables`
then caught the same failure with no comma in sight. Both `ankle/cebuano` and
the shoulder assertion in `numbers/confusables` are really measuring this one
defect.

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
