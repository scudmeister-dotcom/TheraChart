# TheraChart EMR

A streamlined EMR for physical therapy clinics, built around one core idea:
**the therapist just talks, and the chart writes itself.** While the patient
speaks, TheraChart pins what they say onto a body map, files measurements into
the right sections, keeps the full word-for-word transcript, and lets you
click any finding to see exactly where it was said.

> **New here? Read [ABOUT.md](ABOUT.md)** — what TheraChart is, what it gives
> physical therapists, and why it beats a hand-written paper chart. It's the
> heart and soul of the project.

Runs on phone, iPad, or computer as a responsive web app. Deploy to Vercel,
self-host a clinic server, or serve it statically — see **[DEPLOY.md](DEPLOY.md)**.

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
  **allergies**, **emergency contact**, insurance/payment, and the
  **visit authorisation** (visits approved, expiry, reference). Allergies show
  on the patient banner from every screen; visits used are counted from the
  chart, and the app warns before an authorisation runs out or expires.
- **Plan-of-care goals** — short- and long-term goals with a baseline, a
  target and a **target date**, set at the evaluation and reviewed in every
  progress report. Overdue goals surface on the chart's Needs-attention list.
- **Outcome measures** — LEFS, DASH/QuickDASH, NDI, ODI, NPRS, PSFS, ABC and
  TUG, recorded per visit and **trended across the episode against each tool's
  MCID**, so a change is reported as clinically meaningful or not.
- **Billing** — a CPT charge sheet on every visit with treatment minutes and
  units. Units are checked live against Medicare's **8-minute rule**: the app
  says when a claim is over-billed, under-billed, or a couple of minutes short
  of another unit, and can pre-fill the codes from the treatment text.
- **Patient center** — demographics, insurance, uploaded referrals/X-rays,
  and every therapy document (daily notes, evaluations, progress reports,
  discharges). **Print or export the whole chart as a PDF.**
- **Daily treatment notes** — a full SOAP note: subjective, treatment summary,
  objective measurements (voice-filled), assessment and plan, therapist name +
  time, **e-sign & lock**. Dictation is routed **sentence by sentence**, so one
  spoken paragraph fills every section it touches at once. Later edits require
  a signed amendment with an authorization reason.
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

## Two dictation engines — switch in the app

Every note's dictation bar has an engine selector:

- **Browser (current)** — the Web Speech API. Fast and streams live, but audio
  goes to the browser vendor's servers (on Chrome, Google's **consumer**
  service) with **no healthcare data agreement** (HIPAA BAA / RA 10173). Fine
  for demos and testing; **not for real PHI**.
- **Google Cloud — Standard / Chirp** — the page records short WAV segments and
  posts them to the server's `/api/stt`, which proxies to **Google Cloud
  Speech-to-Text under your Google Cloud BAA**. Audio is held only in memory and
  sent immediately — never written to the device. Two models: **Standard**
  (`latest_long`, lower cost) and **Chirp** (best multilingual, incl.
  Tagalog/Cebuano).

The Google Cloud options stay **disabled until the server is configured** — set
`GCP_PROJECT` and Google credentials and they light up automatically. Full
step-by-step (account, BAA, APIs, Cloud Run hosting): see **[GOOGLE_SETUP.md](GOOGLE_SETUP.md)**.

### Optional: temporary session-audio review

Off by default, and **decided per clinic** — an admin enables it in **Facility
Admin** for their own clinic only, and no other clinic on the server is
affected. Once on, **for patients who consent**, the Google Cloud dictation
audio is kept briefly so a clinician can replay it to double-check the
transcript. The audio is
**auto-deleted the moment the note is signed**, or after the clinic's retention
window (default 7 days) — whichever comes first — and consent is recorded in the
chart. It never touches the browser engine (that audio goes straight to the
vendor). Kept audio lives server-side (interim: the data dir; **Cloud Storage
with encryption + lifecycle auto-delete at go-live**). This is the one
disclosed exception to "TheraChart doesn't store audio."

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
GEMINI_API_KEY=... GEMINI_MODEL=gemini-3.6-flash node server.js
# for PHI/compliance, point GEMINI_BASE_URL at Vertex AI Gemini under a BAA
```

Only transcript **text** (never audio) is sent for refinement. Because that
text can contain PHI, using the consumer Gemini API means sending PHI to
Google; the Privacy panel explains the compliant path (paid Vertex AI Gemini
under a signed BAA) and the local reviewer alternative.

## Onboarding old charts: import visit history from PDF scans

Bringing a patient over from paper? On the patient's chart, **⇪ Import visit
history (PDF)** sends a scanned document to Gemini, which reads it into one
structured entry per visit — dates, note type (eval / daily / progress /
discharge), subjective/objective/assessment/treatment, body-map findings, and
measurements (ROM, MMT, pain, special tests). A **review screen** shows every
extracted visit for you to check against the scan and edit; likely duplicates
of existing visits are pre-unchecked, and a name-mismatch warning fires if the
document doesn't match the open chart. Applying creates each kept visit as a
**locked historical document dated to its original visit**, e-signed with an
"imported from scanned document" attestation (corrections go through the normal
amendment flow). This needs Gemini configured — there is no offline reader for
scans, so without a key the feature reports itself unavailable rather than
guessing. The whole document (which usually contains the patient's details) is
what's sent to Gemini; the Privacy panel discloses this.

Because a chart onboarded this way can hold **years of visits**, the clinical
insights pass keeps only the 12 most recent visits in full and compresses
everything older into a **history digest** (date range, recurring regions,
ROM/pain endpoints, key assessments) — so the AI context stays about a page no
matter how long the chart gets, and trends still span the whole history.

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

## Clinical insights — connections & recommendations

Beyond a single visit, TheraChart can reason across the whole chart. In any
document, **✦ Clinical insights** looks at the current findings **and the
patient's history** and surfaces:

- **Possible connections** — recurrence of a region across visits, ROM/pain
  trends over time, referred/radicular patterns, and links to past medical
  history or the referral reason (each with a confidence and the evidence it's
  based on).
- **Red flags** — anything warranting caution or medical referral.
- **Recommendations — what to do now** — concrete next steps (assessments,
  treatment considerations, precautions, referral), each with a rationale and
  priority, with one click to append into the note's plan/assessment.

It is **decision support for a licensed PT, not a diagnosis**, and says so.
It uses Gemini when a key is configured, otherwise a local heuristic — same as
the clean-up pass. See **[DEPLOY.md](DEPLOY.md)** to run it on Vercel with your
`GEMINI_API_KEY`.

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
- **Dictation needs a connection**: both engines are online — the browser
  engine uses the vendor's speech servers, and Google Cloud STT streams to
  Google. While offline you can still **type** into any note; voice dictation
  resumes when the connection is back. No audio is ever stored on the device.

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
chart, printing to PDF, and sync all work from the phone; speech-to-text runs
on Google Cloud (or the browser engine), so phones don't need any special
hardware.

## Testing

The parsing brain (`parser.js`) and data rules (`store.js`) are DOM-free and
checked offline:

```bash
node test/tenancy.test.js  # 48 checks: clinic isolation + authorization, over real HTTP
node test/workflow.test.js # 20 checks: a clinical journey across two synced devices
node test/migration.test.js # 18 checks: today's code reading a pre-tenancy database
node test/parser.test.js   # 82 checks: EN/TL/CEB parsing, measurements, classifier
node test/store.test.js    # 29 checks: licenses, e-sign locking, amendments, calendar
node test/merge.test.js    # 13 checks: offline merge never loses records
node test/refine.test.js   # 30 checks: speaker split, sections, measurements
node test/insights.test.js # 15 checks: connections, red flags, recommendations
node test/clinical.test.js # 84 checks: 8-minute rule, MCID trending, goal dates
node test/import.test.js   # 38 checks: PDF-record extraction, history digest, imported docs
```

### Browser tests

The suites above are DOM-free — fast, and they never flake. What they can't see
is the screen. Five Playwright tests cover the paths where a silent break would
be worst and which no server-side check can catch:

```bash
npm run e2e            # headless
npm run e2e:headed     # watch it drive the app
npx playwright show-trace test-results/<test>/trace.zip   # replay a failure
```

They cover: a therapist's chart rendering, **clinic isolation on screen and in
`localStorage`**, dictation pinning the body map and filing a measurement,
signing locking a note, and settings staying inside one clinic. The server is
started fresh against a throwaway data directory each run, so they never touch
`data/`.

Playwright is a **dev dependency** — it never ships. Browser binaries live in a
shared user cache outside the repo, and `.gcloudignore` keeps `node_modules/`
and `test/` out of the deploy entirely. First run needs `npx playwright install
chromium`.

### Scoring the AI passes

Unit tests pin the local heuristic's exact behaviour. The **eval harness** grades
whichever engine is configured — local or Gemini — on properties that must hold
regardless of model or prompt wording (speaker attribution, findings grounded in
the transcript, nothing invented, red flags caught):

```bash
npm run eval                                  # local engine — free and deterministic
GEMINI_API_KEY=... npm run eval               # score the real model
node test/eval/run.js --runs 3                # repeat, to see model variance
node test/eval/run.js --save-baseline         # record the current score as the bar
```

Each run is scored against `test/eval/baseline.<engine>.json` and names any
assertion that flipped, exiting non-zero on a regression — so **edit a prompt,
re-run, and see a number** instead of guessing. Safety-critical assertions
(attribution, hallucination, red flags) carry extra weight.

## Files

- `index.html` / `styles.css` — shell and design system (light + dark)
- `server.js` — zero-dependency clinic server: shared database, server-side
  login, reminder scheduler, static hosting
- `sync.js` — client sync layer (auto-detects the server, degrades to
  on-device mode)
- `parser.js` — multilingual body-part lexicon, symptom summarizer,
  measurement extraction, section classifier, speaker split + local refiner,
  coordinate-by-name (saved findings re-pin to the current mannequin)
- `clinical.js` — billing rules (CPT catalogue, 8-minute rule), outcome-measure
  catalogue and MCID trending, plan-of-care goal dates — DOM-free and checked
  offline
- `store.js` — on-device data layer: users, patients, documents, calendar,
  audit log, license gating
- `app.js` — application: routing, views, dictation, body maps, printing
- `test/` — offline checkers for parser and store
