# TheraChart — Heart & Soul

> **The therapist just talks. The chart writes itself.**

TheraChart is an electronic medical record (EMR) built for physical therapy
clinics — designed first for the Philippines, and for any clinic where
therapists spend more of the day writing about care than giving it.

It exists to answer one question: *what if documentation got out of the
therapist's way?*

---

## The problem we're replacing

For most PT clinics, the patient record is still a **paper chart** — a folder
of handwritten evaluation forms, daily notes, and progress reports. It works,
barely, and it costs the clinic every single day:

- **Documentation steals time from patients.** A therapist can spend 10–15
  minutes handwriting a note after each visit. Across a full day that's hours
  bent over paperwork instead of treating people.
- **Handwriting is lossy.** Rushed notes are cramped, abbreviated, sometimes
  illegible even to the person who wrote them. Details a patient mentioned in
  passing — "it's worse at night," "only when I climb stairs" — never make it
  onto the page.
- **Nothing is searchable.** Finding a patient's history means flipping through
  a folder. Comparing this month's range of motion to last month's means
  hunting across pages.
- **The record lives in one place.** A paper chart is in the drawer at the
  clinic. It can't be in two rooms at once, can't be read from a home visit,
  and is one flood, fire, or misfile away from being gone forever.
- **Language gets flattened.** Patients describe pain in Tagalog, Cebuano, or a
  natural mix of both and English. On paper it gets translated, summarized, and
  compressed by whoever is holding the pen — and nuance is lost.
- **No safety rails.** A paper note can be edited later with no trace. There's
  nothing stopping an expired-license clinician from writing in a chart. There's
  no log of who changed what, or when.
- **Scheduling and reminders are manual.** A wall calendar and phone calls.
  No-shows happen because reminders depend on someone remembering to call.

Handwriting isn't just slower. It quietly loses information, and it can't be
audited, shared, searched, or trusted the way modern care requires.

---

## What TheraChart does

The therapist opens the patient's chart, taps **Listen**, and simply talks
through the visit the way they naturally would. As they speak, TheraChart:

1. **Transcribes every word** and keeps the full conversation, saved with the
   note.
2. **Pins what the patient says to a body map** — "my left shoulder is sore"
   drops a marker on the left shoulder, colored by how severe it is.
3. **Files the details into the right sections** — subjective complaints,
   objective measurements (range of motion, strength, special tests, pain
   ratings), assessment — automatically.
4. Understands **two languages at the same time** — you set the dictation to
   **English & Tagalog** or **English & Cebuano**, and either pairing is
   transcribed together, including the natural code-switching real patients
   use mid-sentence. The clinical lexicon behind it recognizes English,
   Tagalog and Cebuano body-part and pain terms regardless of the pairing.

When the visit is done, an optional **AI review pass** re-reads the whole
transcript, separates what the *patient* said from what the *therapist* said,
cleans up any transcription errors, and presents a final, editable summary. The
therapist confirms it, **e-signs**, and the note locks.

That's the heart of it: **the therapist talks to their patient, and a complete,
structured, legible clinical note exists at the end — with almost none of the
typing or handwriting.**

---

## What it provides — features

### The talk-to-chart core
- **Live voice dictation** in **English & Tagalog** or **English & Cebuano**
  — both languages of the chosen pairing transcribed at once, code-switching
  included.
- **Body-map pinning** across 60+ regions, front and back, with left/right
  detection — findings appear as numbered markers *outside* the figure with
  leader lines to the exact spot, colored by severity.
- **Automatic clinical extraction** — symptom type, severity, pain ratings
  ("seven out of ten" / "pito sa sampu"), duration, and triggers; range of
  motion in degrees, manual muscle grades, and special-test results filed into
  the objective tables.
- **Reads like a clinician** — "no pain in the right knee" is recorded as a
  *denial*, not a finding; idioms and the therapist's own questions are not
  mistaken for symptoms; nothing valuable is silently dropped.
- **Full transcript, always saved** — click any finding to jump to the exact
  words that produced it.
- **Two-pass workflow** — instant live capture the PT can watch, then a final
  AI review that splits speakers, cleans up, and lets the therapist edit
  everything before signing.

### A complete EMR around it
- **Patient records** — intake (front desk), demographics, insurance, referring
  physician, and a patient home page with every document, referral, and X-ray
  in one place. Print or export the whole chart as a PDF.
- **The four PT documents** — daily treatment notes, evaluations, progress
  reports (triggered automatically after a set number of visits), and
  discharges — each color-coded and voice-enabled.
- **E-signatures and locking** — a finished note is signed and locked; any later
  change requires a signed, authorized amendment. The original is never
  overwritten.
- **Calendar & reminders** — facility-wide scheduling with automatic
  appointment reminders (3 days before and the morning of), printable
  schedules, and a full record of who booked or changed each visit.
- **Roles & licensing** — therapist, front desk, and admin roles; an expired
  license or revoked account automatically loses the ability to open charts or
  sign documents.
- **Audit log** — every sign-in, signature, amendment, booking, and edit is
  recorded.

### Built to be trusted and to work anywhere
- **Runs on phone, tablet, or computer** — installable like a native app.
- **Shared clinic database** on hardware the clinic controls — no third-party
  cloud required.
- **Works offline** — home visits and power outages don't stop documentation;
  everything syncs and safely merges when the connection returns.
- **Speech-to-text under a healthcare agreement** — dictation can run through
  Google Cloud Speech-to-Text under a signed BAA, alongside an honest privacy
  panel that explains exactly where data goes.
- **Accessible & bilingual by design** — because the clinics that need this most
  can't assume the newest phones or the fastest internet.

---

## Hand-written charts vs. TheraChart

| | Antiquated paper chart | TheraChart |
|---|---|---|
| **Creating a note** | 10–15 min of handwriting after each visit | Spoken during the visit; done when the visit is |
| **What gets captured** | Whatever the pen has time for | Every word, plus structured findings and measurements |
| **The patient's own words** | Summarized and translated by hand | Kept verbatim, in the patient's language, linked to each finding |
| **Language** | Tagalog/Cebuano flattened to written notes | English paired with Tagalog or Cebuano, understood natively — Taglish included |
| **Where pain is** | A sketch, if there's time | Precise, severity-colored markers on a body map |
| **Legibility** | Depends on handwriting | Always clean, typed, structured |
| **Finding old information** | Flip through the folder | Searchable; findings link to their source |
| **Access** | One folder, one drawer, one location | Every device in the clinic; works offline in the field |
| **Signatures & edits** | Editable later with no trace | E-signed, locked, amendments tracked, fully audited |
| **License / access control** | Nothing stops an unqualified entry | Expired or revoked accounts are locked out automatically |
| **Scheduling & reminders** | Wall calendar and phone calls | Shared calendar with automatic reminders |
| **If the folder is lost** | The record is gone | Backed up and synced across devices |
| **Progress reports** | Remembered (or forgotten) manually | Triggered automatically at the right visit |

---

## Who it's for

- **Physical therapists** who want to spend their attention on patients, not
  paperwork — and still finish the day with better documentation than they
  could ever handwrite.
- **Front-desk staff** who need fast intake and scheduling without touching
  clinical records.
- **Clinic owners** who need legible, auditable, defensible records — and a
  system that respects patient privacy and their budget.
- **Patients** who deserve to have what they actually said make it into their
  chart, in their own language.

---

## What we believe

Documentation should be a **byproduct of good care, not a tax on it.**

A patient's story — where it hurts, how badly, since when, what makes it worse —
is clinical gold, and it should be captured faithfully, in their own words and
their own language, without a clinician racing a pen to keep up.

Records should be **legible, searchable, shareable, and trustworthy** by
default. Privacy should be **explained honestly**, not buried. And good software
shouldn't require the newest hardware or the fastest internet — the clinics that
would benefit most from getting off paper are often the ones with the least.

TheraChart is our attempt to give physical therapists back the thing paper quietly
takes from them: **time, and their full attention on the person in front of them.**
