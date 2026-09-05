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

## Two ways to hold the microphone

**Aim it at a section.** Every narrative box on a note carries its own
**🎤 Dictate** button. Press the one on *Subjective* and what you say goes into
Subjective — not wherever the classifier decides it belongs. The dictation bar
says where the mic is pointed for as long as it is open, and pressing another
section's button re-aims the same microphone rather than opening a second one.

This answers the failure that costs the most time: when automatic filing puts
a sentence in the wrong section, finding it and moving it costs more than
typing the note would have — and it is wrong most often on the one question it
cannot see, whether a line is the patient's report or the therapist's
observation. A therapist holding the mic at a section has already answered
that, so a stated target skips the classifier rather than being fed to it as
one more hint.

**Or let it roam.** The **Listen & dictate live** button in the dictation bar
is unchanged, and still the right tool while the patient is talking and nobody
is holding a screen: it routes sentence by sentence into every section a spoken
paragraph touches. Measurements, body-map pins and outcome scores are extracted
the same way whichever button is open — and a value that reached a table is
never also written into the prose, so one finding can't sit in two places free
to disagree.

## The core feature: talk → chart

Open a patient, start a **Daily note / Evaluation / Progress report**, press
**🎤 Listen**, and speak — in **English & Tagalog** or **English & Cebuano**,
whichever pairing the dictation bar is set to (both languages of the pairing are
transcribed together, code-switching included; the body-part lexicon understands
all three languages at once):

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
  **precautions**, **emergency contact**, insurance/payment, and the
  **visit authorisation** (visits approved, expiry, reference, guarantee
  letter number, date the documents were submitted). Precautions carry
  everything anyone must know before treating — drug reactions, weight-bearing
  status, fall risk, a contraindicated modality — and show on the patient
  banner from every screen; they are edited in place on the chart's Info tab.
  Visits used are counted from the chart, the app warns before an
  authorisation runs out or expires, and an **attendance record** for the
  insurer prints every documented visit straight from the chart.
- **Plan-of-care goals** — short- and long-term goals with a baseline, a
  target and a **target date**, set at the evaluation and reviewed in every
  progress report. Overdue goals surface on the chart's Needs-attention list.
  The note **suggests goals from what it just measured** — a 3/5 muscle grade
  prompts "4/5", a restricted range prompts the patient's own other side, a
  7/10 pain prompts one NPRS MCID lower, an outcome score prompts one of its
  MCID. Each prompt shows the rule that produced it, and pressing one **fills
  the form rather than adding the goal**: a goal is a clinical commitment, and
  nothing writes one for you.
- **Outcome measures** — LEFS, DASH/QuickDASH, NDI, ODI, NPRS, PSFS, ABC and
  TUG, recorded per visit and **trended across the episode against each tool's
  MCID**, so a change is reported as clinically meaningful or not. Each
  questionnaire can be scored **item by item** rather than as one total: open
  its answer sheet, enter what the patient marked, and the app applies the
  instrument's own formula (sum, percentage, mean, or the DASH transform). A
  part-filled form says so and is never reported as the instrument's score.
  TheraChart holds each instrument's **structure and scoring, not its licensed
  wording** — the clinic reads its own copy of the form alongside — except
  PSFS, whose activities the patient names at the visit.
- **Billing** — a charge sheet on each **daily treatment note**, billing the
  clinic's own catalogue: PT/OT/ST initial evaluations and basic therapy in
  the clinic, at home and inpatient (`PT01`–`PT06`, `OT01`–`OT06`,
  `ST01`–`ST06`), plus the `A01`–`A04` equipment add-ons. A line is a code and
  a number of units; the sheet totals to a **peso subtotal**. Prices are per
  clinic and set by an **administrator with billing access** — they start
  empty, and a code with no price is left out of the subtotal rather than
  counted as free. The price is stamped onto each line as it is entered, so a
  signed note keeps the money it was signed for when the price list moves.
- **Doctor's communication log** — what the referring physician said and
  when: a phone call, a letter carried in by the patient, a new order. An
  **order stays outstanding on the chart until a clinician marks it actioned**,
  which is the whole reason for writing it down. Anyone with chart access can
  log one — the front desk is usually who takes the call — but signing off
  that an order was carried out takes a licence.
- **Patient center** — demographics, insurance, uploaded referrals/X-rays,
  and every therapy document (daily notes, evaluations, progress reports,
  discharges). **Print or export the whole chart as a PDF.** The Files tab
  takes a **photo straight from the device camera** — a wound, a posture, a
  home setup — into the chart, so a patient's photograph never has to sit in
  somebody's camera roll first. It is filed with the date and time it was
  taken rather than as another `image.jpg`.
- **Daily treatment notes** — a full SOAP note: subjective, treatment summary,
  objective measurements (voice-filled), assessment and plan, therapist name +
  time, **e-sign & lock**. Dictation is routed **sentence by sentence**, so one
  spoken paragraph fills every section it touches at once. Later edits require
  a signed amendment with an authorization reason.
- **Evaluations** — full section set with voice auto-filing; e-sign & lock.
- **Progress reports** — written on demand, at whatever point in the episode
  calls for one; carries the evaluation's subjective baseline forward; e-sign
  & lock. The chart always shows how many visits in you are (every N visits,
  facility-configurable, default 5); a clinic that wants to be **chased**
  about it turns the reminder on in Facility Admin — it is off by default.
- **Calendar** — facility-wide day grid of open slots, booking with
  creator/change history recorded, automatic reminders (3 days before +
  morning-of; simulated in this on-device build), per-therapist or full
  schedule printing, Google Calendar hand-off link.
- **Privacy & security panel** — on-device storage explained honestly
  (including what the browser's speech service does), role/PIN/license
  access controls, export/erase controls, and a live audit log.

## Two dictation engines — switch in the app

Dictation is **Google Cloud Speech-to-Text — Chirp 2**, and there is no engine
picker: the page records short WAV segments and posts them to the server's
`/api/stt`, which proxies to Google under your **Google Cloud BAA**. Audio is
held only in memory and sent immediately — never written to the device.

The dictation bar's one choice is what you'll be **speaking**: **English &
Tagalog** (the default) or **English & Cebuano**. Each sends a single language
code (`fil-PH` / `ceb-PH`) — Chirp 2 refuses a list of codes, and doesn't need
one: it's a universal model that transcribes code-switched Taglish under the PH
code, which is the point of the pairs.

**The clinical vocabulary is boosted at the source.** Chirp 2 has never seen a
physiotherapy chart, so it picks the ordinary English word over the
abbreviation every time — `MMT` comes back as "MPT", `AROM` as "a ROM", `therex`
as "there ex". The server sends a short **phrase-adaptation** list with each
request (`MMT`, `AROM`, `PROM`, `goniometer`, the special-test names…) so the
clinical reading wins. Chirp 2's feature support varies by region, so the list
is probed once: if Google rejects it, the server says so in the log and
transcribes without it from then on rather than failing or retrying every
segment. A second, deterministic pass repairs the same handful of known
misreadings in the recogniser's **output**, each one guarded by the words
around it — "MPT" becomes `MMT` next to a muscle grade and stays "MPT" next to
a therapist's name. The dictation bar names any word it changed.

**Automatic gain control is off.** It is every browser's default and it is
wrong in a clinic: it raises the microphone whenever the room goes quiet, which
is exactly when the only thing left to amplify is the conversation at the next
plinth — so a therapist pausing to think got the room brought up to meet them.
It also moves the signal level `voiceGate()` measures, underneath the gate, on
its own schedule. Echo cancellation and noise suppression stay on; both are
narrow-band and neither rescales speech the way AGC does.

**There is no English-only choice**, and that's measured rather than assumed. On
a 148-word clinical script, `en-US` beats the PH codes only on *American*-accented
English (8.8% vs 10.8% word error). On **Filipino-accented** English the PH codes
are level or ahead (`en-US` 27.7% / 20.3% against `fil-PH` 27.0% / 20.3% and
`ceb-PH` 26.4% / 19.6%). The failure is one-sided: Tagalog spoken while the code
sat on `en-US` lost **whole utterances** — a four-second segment came back as
"oppo" — and was billed for them regardless. English spoken under `fil-PH` costs
a word or two. The server therefore treats `en-US` as the default `fil-PH`, which
also covers a device still sending it from a cached copy of the app.

Where the server has **no Google credentials** (the preview, a local demo) the
bar falls back to the browser's own Web Speech API and says so. That streams
audio to the browser vendor's **consumer** service with **no healthcare data
agreement** (HIPAA BAA / RA 10173) — fine for demo data, **never for real PHI**.
Set `GCP_PROJECT` and Google credentials and Chirp 2 takes over automatically.
Full step-by-step (account, BAA, APIs, Cloud Run hosting): see **[GOOGLE_SETUP.md](GOOGLE_SETUP.md)**.

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
node test/tenancy.test.js  # 73 checks: clinic isolation, authorization, asset exposure
node test/workflow.test.js # 20 checks: a clinical journey across two synced devices
node test/migration.test.js # 18 checks: today's code reading a pre-tenancy database
node test/parser.test.js   # 222 checks: EN/TL/CEB parsing, measurements, AROM/PROM, dictation repair
node test/store.test.js    # 29 checks: licenses, e-sign locking, amendments, calendar
node test/merge.test.js    # 13 checks: offline merge never loses records
node test/refine.test.js   # 30 checks: speaker split, sections, measurements
node test/insights.test.js # 15 checks: connections, red flags, recommendations
node test/clinical.test.js # 160 checks: service catalogue, outcome item scoring, goal prompts, MCID trending
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

The **scanned-record import** is scored separately, because its fixtures are
documents rather than transcripts:

```bash
GEMINI_VERTEX=1 GCP_PROJECT=... npm run eval:extract
node test/eval/extract.js --runs 3            # repeat, to see model variance
node test/eval/extract.js --fixture scan_4visit
```

The scan fixtures are **image-only PDFs** — no text layer, so the model has to
OCR them the way it OCRs a real chart scan. A PDF built from text operators is
far easier and hides exactly the failures this eval exists to catch, so it is
kept only as a control. `test/eval/fixtures/make-scan.py` regenerates the
bitmaps deterministically (needs Pillow; they are gitignored). Document reading
has no local fallback, so this eval needs a real engine and exits 2 without one.

**Simulated degradation is a stand-in.** To score a genuine capture, print the
clean pages and photograph or scan them — a phone is fine, and is closer to how
records actually arrive than a flatbed is:

```bash
python3 test/eval/fixtures/make-scan.py --print   # print_*.pdf, clean and printable
```

Save the capture as `real_<name>.pdf` (or `.jpg`/`.png`) in
`test/eval/fixtures/`, using the same name as the page you printed —
`print_4visit.pdf` → `real_4visit.jpg`. The eval scores it automatically and
skips it until the file exists. Capture twice if you can: once with a scanner
app's auto-enhance, once as a plain photo. The enhanced version is what users
will send; the plain photo keeps the shadow and keystone that actually break
OCR. Handwritten fixtures are **advisory** — reported, never gating.

## Files

- `index.html` / `styles.css` — shell and design system (light + dark)
- `server.js` — zero-dependency clinic server: shared database, server-side
  login, reminder scheduler, static hosting
- `sync.js` — client sync layer (auto-detects the server, degrades to
  on-device mode)
- `parser.js` — multilingual body-part lexicon, symptom summarizer,
  measurement extraction, section classifier, speaker split + local refiner,
  coordinate-by-name (saved findings re-pin to the current mannequin)
- `clinical.js` — billing (the clinic's service catalogue and the visit
  subtotal; the legacy CPT catalogue and 8-minute rule are still exported and
  tested but no longer reachable from the UI), outcome-measure catalogue and
  MCID trending, plan-of-care goal dates — DOM-free and checked offline
- `store.js` — on-device data layer: users, patients, documents, calendar,
  audit log, license gating
- `app.js` — application: routing, views, dictation, body maps, printing
- `test/` — offline checkers for parser and store
