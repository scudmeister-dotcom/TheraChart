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

- **Live listening** with continuous speech recognition and a live transcript bar
- **60+ body regions** across front and back views, with left/right detection
  (front view is mirrored, like looking at a patient)
- **Summarized notes** in plain words: symptom type (pain, stiffness, numbness,
  swelling, clicking…), qualifiers (sharp, dull, burning…), intensity, pain
  ratings ("7 out of 10"), duration ("for two weeks"), and triggers ("when I
  bend over") — plus the original quote for reference
- Repeated mentions of the same spot stack onto one numbered point
- Click a point to jump to its note (and vice versa)
- **Export** the session as a text file; **Clear** starts a fresh session

## Files

- `index.html` — page layout
- `styles.css` — styling
- `app.js` — body-part lexicon, symptom summarizer, speech recognition, and rendering
