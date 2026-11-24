# TheraChart — Local Testing Checklist (`polish-reliability-clinical`)

All Phase 1–3 reliability, UX polish, and clinical workflow changes are on branch **`polish-reliability-clinical`** (**PR #21**). `main` is untouched until you review and merge.

*(Note: You can remove this file before merging PR #21 into `main` once you finish testing.)*

---

## 1. Run Locally

```bash
git fetch origin
git checkout polish-reliability-clinical
git pull origin polish-reliability-clinical
```

Start the local server with demo accounts enabled:
- **Mac / Linux:** `THERACHART_DEMO_LOGINS=1 npm start`
- **Windows (PowerShell):** `$env:THERACHART_DEMO_LOGINS="1"; npm start`

*(Optional — if your local `./data` folder was seeded months ago and you want fresh demo appointments dated for today: stop the server, rename `./data` to `./data-backup`, and start it again.)*

---

## 2. Feature Verification Checklist

### A. Therapist Flow — Sign in as **Maria Santos, PT** (`maria@therachart.demo`)
- [ ] **Global Quick Jump**: Click **`Quick jump… /`** in the left sidebar (or press `/` outside an input, or `Ctrl+K` / `⌘K`). Search for a patient (`Gonzales`), a clinical word inside a note (`shoulder`, `pain`), or a screen (`Calendar`).
- [ ] **Interactive Sync Badge**: Click **● Synced with clinic server** (bottom-right on desktop, top-bar dot on phone) → popover opens with last sync time and **Sync now**.
- [ ] **Patients Quick-Access**: Open **Patients** → shows **Scheduled today**, **Recently opened**, or **Active charts** (so Bautista, Gonzales, and Villanueva are reachable in one click without typing).
- [ ] **Visual Progress Charts**: Open **Bautista, Mark Anthony** → **Overview** tab shows inline SVG trend charts for Pain (0–10), repeated ROM, and Outcome measures (DASH/NPRS with MCID).
- [ ] **Full-Text Note Search**: Switch to the **Documents** tab → type a word from inside a note into **Search inside notes, findings, measurements…** → filters matching notes with highlighted snippets.
- [ ] **Balanced Desktop & Phone Note Editor**: Open a **Daily Treatment Note** (or create a new **+ Daily note**):
  - [ ] Top color wash blends smoothly behind breadcrumbs with no horizontal seam.
  - [ ] Scrolling down keeps **Findings & body map** sticky on the left (~44%) beside the spacious clinical sections on the right (~56%).
  - [ ] Resizing to phone width stacks cleanly into one column with zero top-bar overlap.
- [ ] **Section Jump Bar & Slide-Over AI Drawer**: Click **Body map / Subjective / Objective / Plan & HEP / Insights** to jump directly to each section; click **Ask AI** to open the slide-over Patient Assistant drawer.
- [ ] **Copy from Last Visit**: Click **Copy from last visit** → pick items (Plan, HEP, Goals, Subjective) → click **Copy selected** → verify attribution banner appears.
- [ ] **Home Exercise Program (HEP) + Handout**: Under **Plan & HEP**, add an exercise (name, sets, reps, hold, frequency, cues) → click **Print patient handout** (and verify HEP also appears in **Print / PDF**).
- [ ] **Autosave Shortcut**: Press `Ctrl+S` / `⌘S` inside a note → shows **"All changes are already autosaved."** toast instead of browser Save dialog.
- [ ] **Dark Mode & Idle Screen-Lock**: Open **My Profile** → switch **Light / Dark / System** (reload to confirm persistence); test **Auto-lock** selector and click **Lock screen now** → unlock returns you with drafts untouched.
- [ ] **Scan Documents**: Open **Scan documents** → smooth tab transition; clicking **Start over** uses the accessible in-app modal (never a browser `confirm()` popup); photographed pages restore after refresh and preview side-by-side in import review.

### B. Admin / Front Desk Flow — Sign in as **Grace Lim, PT (Admin)** (`grace@therachart.demo`) or **Ana Dela Cruz** (`ana@therachart.demo`)
- [ ] **Calendar Week View**: Open **Calendar** → toggle **Day | Week** to view the 7-day provider schedule; click any day header to return to Day view.
- [ ] **Appointment Lifecycle Statuses**: Click any appointment → switch status between **Booked**, **Checked in**, **Completed**, and **No-show** → badge updates and persists across reload.
- [ ] **Dashboard Feedback Loops**:
  - [ ] Admin sees **unbilled visits** alert linking to **Visit time** pre-filtered to `Unbilled`.
  - [ ] Therapist sees **answered schedule-change request** banner on Dashboard once Admin/Front Desk resolves a request.

### C. New Clinic Flow — Sign in as **Sam Rivera, PT (Admin)** (`fresh@therachart.demo`)
- [ ] **Getting Started Checklist**: Empty clinic Dashboard displays the dismissible **Getting started** onboarding card tracking first patient, clinic hours, first visit, and first evaluation.

### D. Reliability Guardrails & Automated Tests
- [ ] Short-term `localStorage` quota trimming hook (`store.save()`), `beforeunload` unsynced/scan guard, hidden-tab polling pause, `401` session-expiry & sync-error banners, and global client error boundary.
- [ ] Run automated checks:
  ```bash
  npm test          # 38/38 unit test suites (including test/reliability-clinical.test.js)
  npm run e2e       # 70/70 Playwright browser E2E tests (including e2e/reliability-clinical.spec.js)
  ```

---

## 3. Architectural & Product Constraints (`NOTES.md`)
- Keep the short-term `localStorage` approach while Cloud SQL Postgres is paused.
- Keep all deliberate `NOTES.md` decisions intact (no HIPAA/RA 10173/NPC/DPO legal wording in product UI; no copyrighted outcome-measure item text; dictation stays paused unless `THERACHART_DICTATION=1`; keep the 3 legacy local-reviewer attestation strings in `app.js`).
- Keep `index.html`, `server.js` (`CLIENT_FILES`), and `sw.js` (`SHELL`) in sync (enforced by `test/assets.test.js`). Current `sw.js` cache: `therachart-v33`.
