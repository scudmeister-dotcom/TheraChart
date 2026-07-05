# TheraChart — Talk & Map

Speak naturally about how you feel, and TheraChart pins what you say to a body
map. When you mention a body part ("my left shoulder", "lower back", "right
knee"…), a numbered point appears on the front or back figure, together with a
short note summarizing what you said about it — symptoms, severity, duration,
and triggers, paraphrased in plain words.

Everything runs locally in the browser. No server, no build step, nothing
uploaded.

## Run it

Speech recognition needs a secure context, so serve the folder and open it in
**Chrome or Edge** (they ship the Web Speech API):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Press **Start listening**, allow microphone access, and talk. For example:

> "My left shoulder has been really sore for two weeks, and I get a sharp
> pain in my lower back when I bend over, maybe a 7 out of 10."

…drops a point on the left shoulder ("Significant soreness · ongoing for two
weeks") and one on the lower back ("Sharp pain · rated 7/10 · worse when I
bend over").

No microphone or unsupported browser? Type sentences into the text box at the
bottom of the notes panel, or click **Try an example** to see a scripted demo.

## Features

- **Live listening** with continuous speech recognition
- **Full saved transcript** — every finished sentence is kept word for word
  with a timestamp, viewable in the transcript panel and included in exports
- **Click a note → see the source**: clicking a summarized note (or its point
  on the body map) jumps the transcript to where it was said and highlights
  every passage related to that finding, with the body-part words emphasized
- **60+ body regions** across front and back views, with left/right detection
  (front view is mirrored, like looking at a patient)
- **Summarized notes** in plain words: symptom type (pain, stiffness, numbness,
  swelling, clicking, instability…), qualifiers (sharp, dull, burning…),
  intensity, pain ratings ("7 out of 10" or spoken "six out of ten"), duration
  ("for two weeks"), and triggers ("when I bend over")
- **Reads like a clinician**:
  - negations become denials ("no pain in my right knee" → *Denies pain*),
    never false positives
  - follow-up sentences with no body part ("It's a six out of ten at night")
    attach to the point being discussed, tagged *follow-up*
  - symptoms with no clear body area go to an amber **Needs review** card —
    nothing valuable is silently dropped
  - idioms are ignored ("I'll be back", "behind my back")
- Repeated mentions of the same spot stack onto one numbered point
- **Export** the session (findings + needs-review + full transcript) as a
  text file; **Clear** starts a fresh session

## Testing the listening logic

The parsing brain lives in `parser.js` with no DOM code, so the exact same
logic the app runs is exercised by an offline checker that reads realistic
physical-therapy intake transcripts and verifies nothing valuable is missed
(and nothing false is invented):

```bash
node test/parser.test.js
```

50 checks cover side detection, phrase precedence ("shoulder blade" vs
"shoulder", "back of my head" vs "back"), radiating-pain patterns that must
produce two points, denials, spoken ratings, injury history, and a
whole-transcript sweep asserting no symptom line is dropped.

## Files

- `index.html` — page layout
- `styles.css` — styling (light + dark themes)
- `parser.js` — body-part lexicon, symptom summarizer, utterance parser
  (shared between the app and the tests)
- `app.js` — speech recognition, transcript, body maps, notes, highlighting
- `test/parser.test.js` — the parser checker
