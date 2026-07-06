# TheraChart EMR

A streamlined EMR for physical therapy clinics, built around one core idea:
**the therapist just talks, and the chart writes itself.** While the patient
speaks, TheraChart pins what they say onto a body map, files measurements into
the right sections, keeps the full word-for-word transcript, and lets you
click any finding to see exactly where it was said.

> **New here? Read [ABOUT.md](ABOUT.md)** — what TheraChart is, what it gives
> physical therapists, and why it beats a hand-written paper chart. It's the
> heart and soul of the project.

Runs on phone, iPad, or computer as a responsive web app.

## Run it

**Clinic mode (shared database, recommended)** — run the included zero-dependency
server on one machine in the clinic:

```bash
node server.js            # serves the app + shared database on :8080
```

Open `http://<that-machine>:8080` from every device. Logins authenticate
server-side, changes sync between devices within seconds, and the reminder
scheduler runs every minute (set `REMINDER_WEBHOOK=<url>` to forward each due
reminder as JSON to a real SMS/email gateway; otherwise reminders are marked
sent and logged). Data lives in `data/therachart.json` on that machine —
hardware your facility controls, never a third-party cloud.

**On-device mode** — serve the folder statically and each device keeps its own
records (the sync badge shows which mode you're in):

```bash
python3 -m http.server 8000
# open http://localhost:8000 in Chrome or Edge
```

Sign in with any demo account (PIN **1234**):

| Account | Role | Demonstrates |
|---|---|---|
| Maria Santos, PT | Therapist | Full documentation workflow |
| Jose Ramirez, PT | Therapist | **Expired license** — EMR access blocked |
| Carlo Mendoza, PT | Therapist | **Access voided** — cannot sign in |
| Ana Dela Cruz | Front desk | Intake + scheduling, no clinical docs |
| Grace Lim, PT | Admin | Facility settings, staff licenses |

## The core feature: talk → chart

Open a patient, start a **Daily note / Evaluation / Progress report**, press
**🎤 Listen**, and speak — in **English, Tagalog, or Cebuano** (code-switching
works; the body-part lexicon understands all three at once):

- *"masakit ang kaliwang balikat ko"* → pins the **left shoulder** with a
  summarized note ("Pain")
- *"shoulder flexion measured at 130 degrees"* → files ROM into the
  **objective measurements table** (also MMT "4 out of 5", pain "7 out of
  10" / "pito sa sampu", special tests "positive Neer test")
- Evaluation dictation is auto-filed by section: reason for referral,
  precautions, past medical history, subjective, objective, assessment
- Negations become denials ("walang sakit" → *Denies pain*), follow-up
  sentences attach to the point under discussion, and the **full transcript
  is saved** — click any pinned finding to jump to and highlight its source
- No mic? A typed-dictation box does the same thing

## EMR features

- **Therapist accounts & licensing** — name, license number, expiration.
  An expired license or voided access automatically blocks the EMR and all
  document creation/editing/signing.
- **Patient intake** (front desk) — personal info, referring physician,
  insurance/payment details.
- **Patient center** — demographics, insurance, uploaded referrals/X-rays,
  and every therapy document (daily notes, evaluations, progress reports,
  discharges). **Print or export the whole chart as a PDF.**
- **Daily treatment notes** — treatment summary, subjective, objective
  measurements (voice-filled), therapist name + time, **e-sign & lock**.
  Later edits require a signed amendment with an authorization reason.
- **Evaluations** — full section set with voice auto-filing; e-sign & lock.
- **Progress reports** — flagged automatically after the Nth visit
  (facility-configurable, default 5); carries the evaluation's subjective
  baseline forward; e-sign & lock.
- **Calendar** — facility-wide day grid of open slots, booking with
  creator/change history recorded, automatic reminders (3 days before +
  morning-of; simulated in this on-device build), per-therapist or full
  schedule printing, Google Calendar hand-off link.
- **Privacy & security panel** — on-device storage explained honestly
  (including what the browser's speech service does), role/PIN/license
  access controls, export/erase controls, and a live audit log.

## Two transcription engines — compare them yourself

Every note's dictation bar has an engine toggle:

- **Browser (Google servers)** — the Web Speech API. Fast and streams live,
  but audio goes to the browser vendor's servers with **no healthcare data
  agreement** (HIPAA BAA / RA 10173).
- **Private — Whisper on clinic server** — the page records locally, detects
  natural pauses, converts each segment to 16 kHz WAV in the browser, and
  posts it to your own server, which transcribes with OpenAI's free
  MIT-licensed Whisper model and deletes the audio. **Nothing reaches a
  third party.** Segments upload in order and queue if the server is busy —
  on a CPU-only server the transcript arrives a few seconds behind your
  speech, but nothing is ever lost.

Enable the private engine on the clinic server (one time):

```bash
pip install faster-whisper        # the engine (free, MIT)
WHISPER_MODEL=small node server.js   # model auto-downloads on first use, then cached
```

Model sizes: `tiny`/`base` for older CPUs (fastest), `small` (default,
good accuracy), `medium`/`large-v3` with a GPU. Any other engine works via
`WHISPER_CMD='whisper-cli -m model.bin -nt -f {file}' node server.js`
(e.g. whisper.cpp). Whisper supports English and Tagalog directly; for
Cebuano the engine auto-detects (and the body-part lexicon understands
Cebuano regardless of engine).

## Two-pass documentation: live capture, then AI clean-up

TheraChart captures in two passes so the therapist gets instant feedback *and*
a verified final record:

1. **Live pass (while you talk)** — every finished sentence is transcribed,
   pinned to the body map, and filed into sections in real time, so the PT can
   watch what's being logged and catch problems immediately.
2. **Review & clean-up pass (at the end)** — press **✦ Review & clean up with
   AI** and the whole transcript is re-read by AI, which:
   - **splits the dialogue into patient vs clinician** turns (a therapist's
     questions, instructions, and read-out measurements are separated from
     what the patient reports),
   - **cleans up transcription errors** without changing meaning or language,
   - **re-extracts the findings, focused on the patient's statements.**

   A review screen then lets the user **edit everything** — relabel any
   speaker, fix any wording, edit or uncheck any finding — before applying.
   Applying writes the speaker-labeled transcript back, rebuilds the body-map
   findings, and records a **live-vs-cleanup comparison** ("what changed") you
   can reopen any time. Transcript lines and finding summaries are also
   **editable inline** at any point, independent of the AI pass.

The AI pass uses **Google Gemini** when the clinic server is configured with a
key; otherwise a **local, on-device reviewer** runs (no network, no key), so
the feature always works. Enable Gemini on the clinic server:

```bash
GEMINI_API_KEY=... GEMINI_MODEL=gemini-2.0-flash node server.js
# for PHI/compliance, point GEMINI_BASE_URL at Vertex AI Gemini under a BAA
```

Only transcript **text** (never audio) is sent for refinement. Because that
text can contain PHI, using the consumer Gemini API means sending PHI to
Google; the Privacy panel explains the compliant path (paid Vertex AI Gemini
under a signed BAA) and the local reviewer alternative.

## Navigation & visual design

- **Modern sidebar** — grouped nav (Clinic / Account), gradient brand mark,
  animated active indicator, avatar + one-tap sign-out.
- **Breadcrumb + Back** on every screen inside a patient (Patients › Name ›
  Document), so you always know where you are and can step back one level;
  **scroll position is remembered** when you return to a screen.
- **Colour-coded document types** — Evaluation, Daily Note, Progress, and
  Discharge each carry a consistent colour on their tag, header stripe, chart
  rows, and "new document" buttons.
- **Clinical body chart as a callout diagram** — the dictation & body map is
  the large primary column. Each finding is a small dot at the exact spot with
  a **leader line out to a numbered marker in the gutter**, so several findings
  can point at the same area and each stays pinpoint-precise. Marker colour
  encodes **severity** (severe / moderate / mild / resolved), derived from the
  pain rating and wording.

## Working offline (home visits, brownouts)

Devices that belong to a clinic server keep working when it's unreachable:

- **Unlock with your PIN** against the last-synced copy (refused if that copy
  is older than 72 hours, so stale security/license data can't be abused).
- **Full offline editing** — read every chart; create and edit notes,
  intakes, and bookings. The badge counts queued changes.
- **On reconnect everything merges**: records created offline always
  survive; when both sides edited the same record, the newer edit wins,
  a signed document always beats a draft, signatures/amendments/history are
  unioned, and every superseded edit is preserved in the audit log
  (`sync-conflict` entries).
- **Offline Whisper dictation**: recordings queue in the device's browser
  storage, then transcribe on the clinic server and are deleted the moment
  the transcript lands — this temporary on-device audio is disclosed in the
  Privacy panel. If a note was signed while a segment waited, its words are
  preserved as a `late-transcript` audit entry instead of being lost.

## Reaching the clinic server from outside the clinic

On the clinic's WiFi, devices connect directly (no internet needed at all).
For home visits or working from home, install a mesh VPN like Tailscale on
the server and each phone — devices then reach the clinic server from
anywhere over an encrypted tunnel, without exposing it to the public
internet. Note that phone browsers require HTTPS (or localhost) to allow the
microphone, so give the server a certificate when deploying (Tailscale can
issue one).

## Install on phones and tablets

TheraChart is an installable web app (PWA). Open the clinic server's address
on the phone, then **Add to Home Screen** (Safari share menu on iOS, Chrome
menu on Android) — it launches fullscreen like a native app, with its own
icon, and the app shell loads instantly from cache. Dictation, the body
chart, printing to PDF, and sync all work from the phone; heavy Whisper
transcription runs on the clinic server, so phones don't need any special
hardware.

## Testing

The parsing brain (`parser.js`) and data rules (`store.js`) are DOM-free and
checked offline:

```bash
node test/parser.test.js   # 82 checks: EN/TL/CEB parsing, measurements, classifier
node test/store.test.js    # 29 checks: licenses, e-sign locking, amendments, calendar
node test/merge.test.js    # 13 checks: offline merge never loses records
node test/refine.test.js   # 25 checks: speaker split + AI-cleanup finding extraction
```

## Files

- `index.html` / `styles.css` — shell and design system (light + dark)
- `server.js` — zero-dependency clinic server: shared database, server-side
  login, reminder scheduler, static hosting
- `sync.js` — client sync layer (auto-detects the server, degrades to
  on-device mode)
- `parser.js` — multilingual body-part lexicon, symptom summarizer,
  measurement extraction, section classifier, speaker split + local refiner,
  coordinate-by-name (saved findings re-pin to the current mannequin)
- `store.js` — on-device data layer: users, patients, documents, calendar,
  audit log, license gating
- `app.js` — application: routing, views, dictation, body maps, printing
- `test/` — offline checkers for parser and store
