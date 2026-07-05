# TheraChart EMR

A streamlined EMR for physical therapy clinics, built around one core idea:
**the therapist just talks, and the chart writes itself.** While the patient
speaks, TheraChart pins what they say onto a body map, files measurements into
the right sections, keeps the full word-for-word transcript, and lets you
click any finding to see exactly where it was said.

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

## Voice privacy — read before dictating real PHI

Browser dictation (Web Speech API) typically sends audio to the **browser
vendor's servers** — on Chrome, Google — and the free API carries **no
healthcare data agreement** (HIPAA BAA / RA 10173 outsourcing agreement).
Safer options, also listed in the app's Privacy panel: use a device with
on-device dictation, type into the dictation box, add self-hosted
transcription (e.g. Whisper) on the clinic server, or license a medical
speech vendor that signs a BAA. The app itself never stores or sends audio.

## Testing

The parsing brain (`parser.js`) and data rules (`store.js`) are DOM-free and
checked offline:

```bash
node test/parser.test.js   # 82 checks: EN/TL/CEB parsing, measurements, classifier
node test/store.test.js    # 29 checks: licenses, e-sign locking, amendments, calendar
```

## Files

- `index.html` / `styles.css` — shell and design system (light + dark)
- `server.js` — zero-dependency clinic server: shared database, server-side
  login, reminder scheduler, static hosting
- `sync.js` — client sync layer (auto-detects the server, degrades to
  on-device mode)
- `parser.js` — multilingual body-part lexicon, symptom summarizer,
  measurement extraction, section classifier
- `store.js` — on-device data layer: users, patients, documents, calendar,
  audit log, license gating
- `app.js` — application: routing, views, dictation, body maps, printing
- `test/` — offline checkers for parser and store
