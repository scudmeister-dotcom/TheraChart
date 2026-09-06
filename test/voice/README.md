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

## What it costs

The ElevenLabs half is **cached on disk by content hash**, so only the first run
pays for speech; the scripts don't change between runs. The Google half is paid
every time — about 2½ minutes of audio across the six scripts, which is roughly
**$0.04 of Speech-to-Text** plus six Vertex refine calls. Every run prints the
bill, and `--say-only` costs nothing at Google at all.

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
"limited, about 10 degrees" with a comma — a comma between the motion and the
value silently drops the reading (parser.js `ROM_FILLER`). Until that is fixed,
read a single run of that assertion as a coin flip, not as a verdict.

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
