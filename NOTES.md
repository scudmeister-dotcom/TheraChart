# Open items

Things known to be outstanding, with enough context to pick them up cold.
Not a backlog of ideas — only work that is *already implied by something we
ship*, or a decision that has been made and not yet carried out.

---

## Legal documents a clinic may ask for

**Status:** not written, and **the product now says nothing about any of this**.
The compliance conversation is had with the clinic directly, by Amador, rather
than through the app — so the landing page and the Privacy panel describe only
where records go and what the software does, and make no legal claims at all.
Read "What the app says today" before touching any of that copy.

Because clinics are tenants on our Google Cloud project rather than each
running their own, TheraChart holds their patients' records. That makes us a
**personal information processor** under RA 10173, with the clinic as the
**personal information controller**. Two documents follow from that:

### 1. Data processing agreement (RA 10173) — the one that actually matters

The Data Privacy Act expects the controller/processor relationship to be
written down. Every Philippine clinic on the platform is in this relationship
with us, so this document applies to all of them, not to a subset.

Should cover, at minimum:
- what we process and why (clinical records, on the clinic's instruction only)
- the sub-processor: Google Cloud, and which services
- the **cross-border transfer** — servers are in a US region by default, which
  RA 10173 permits but requires the clinic to disclose and remain accountable for
- security measures, breach notification timing, and what happens on termination
  (the clinic can already Export backup / Erase all data unaided, which is most
  of the answer)

### 2. HIPAA Business Associate Agreement — only if a clinic raises it

**Almost certainly not needed, and deliberately not mentioned in the product.**
HIPAA is US law binding US covered entities.
A Philippine clinic treating Philippine patients and billing PhilHealth or an
HMO is not a covered entity, so no BAA between that clinic and TheraChart is
required. Who *we* bill for the subscription has no bearing on this — HIPAA
follows the patient data and the clinic's status, not our invoice.

It would only arise for a clinic whose care is billed to a **US health plan**.
Have a template ready for that conversation, but do not lead with it.

> Note the separate, unrelated BAA that *does* exist: **ours with Google**,
> signed and active on the account running production, covering Cloud Run,
> Cloud SQL, Speech-to-Text and Vertex AI. That one is a live fact and both the
> landing page and the Privacy panel state it — but they now describe it as a
> "data protection agreement" rather than by its HIPAA name, since HIPAA
> terminology means nothing to a Philippine clinic and reads as a US-market
> artifact. The contract is unchanged; only how we describe it is.

### What the app says today

Deliberately worded so nothing promises a document that does not exist yet:

- **Landing page → "The records stay yours"** — states the controller
  relationship and the cross-border transfer. Promises no paperwork.
- **Privacy panel → "Where your data lives"** — states controller / processor /
  sub-processor. Promises no paperwork.
- **Privacy panel → "What your clinic still has to do"** — **removed entirely.**
  It listed RA 10173 obligations (appoint a DPO, register with the NPC, record
  consent, retention) and closed with a "confirm this with your own counsel"
  disclaimer.

**No legal or regulatory language appears anywhere in the product**, by
decision on both counts:

- **HIPAA** — US law, does not bind a Philippine clinic, and naming it invented
  a compliance obstacle in front of clinics that do not have one.
- **RA 10173 / NPC / DPO / "confirm with your counsel"** — real and relevant,
  but the conversation belongs with the client in person, not on a splash page
  where it reads as a hurdle before signing up.

Both are decisions, not oversights. Do not helpfully restore either. The words
come back in a conversation, or in the documents above once they exist.

If either document gets written, that copy is where to mention it — and the
screenshots covering both surfaces need recapturing:

```bash
node tools/capture-screenshots.js 00 11
```

---

## Speaker labels are wrong for third-person dictation

**Not mine to fix — raised with the session that owns the dictation path, and
recorded here so it does not get lost between us.**

`guessSpeaker` has no pattern for third-person clinical narration and defaults
to "patient". So "patient reports…", "patient denies…", "patient tolerated…"
— the register clinical documentation is *taught* in — are all tagged as the
patient speaking, when they are a clinician narrating. A therapist who dictates
that way has to relabel most of a note by hand.

It is **not** the one-line fix it looks like. `routeUtterance` sends
clinician-spoken sentences away from Subjective, so simply relabelling
"patient reports right shoulder pain 7/10" as clinician would push a genuine
subjective report into Objective and make the note worse. The label is wrong
but currently produces the right routing by accident. Fixing it properly means
separating **who spoke** from **whose voice the content is**, which the data
model does not currently carry.

Confirmed empirically on the four-line transcript the screenshot harness
dictates: the real model tags all four lines clinician; the old heuristic
tagged lines 1 and 4 as patient. Both of those are a clinician narrating in the
third person.

---

## Deploy

Production is on `057ca2e` (revision `therachart-00055-w6n`). `main` is well
ahead of both prod and `origin/main`, and **nothing has been pushed**.

Unshipped work on `main` includes a behaviour change to the AI paths — the
extraction schema gained a `side` field on `mmt` and `pain`, the refine prompt
changed, and a failed AI call now shows a failure dialog instead of quietly
presenting the offline reviewer's output as the AI's. That is worth a look
before it reaches a clinic, rather than after.

Reminders for whoever runs it:
- `deploy-gcp.sh` ships the **working directory**, not a commit — make sure the
  tree is clean and is what you mean to send
- it reads the live service's settings and carries them forward, so scrub
  `THERACHART_DEMO_LOGINS` from your shell first; production is INVITE-only
- `./verify-prod.sh` afterwards — 19 read-only checks, non-zero exit on failure
