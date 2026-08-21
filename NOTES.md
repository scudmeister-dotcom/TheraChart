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

## Our fixtures only know the happy ordering

Both bugs found in production on 2026-08-20 were the same shape, and neither
could occur locally — not because the code differed, but because **every test
sets events up in the order where nothing goes wrong**.

- The delete dialog said *"0 min of dictation and 1 AI pass"*. An AI pass with
  no dictation cannot arise in a local test, because every local test dictates
  before it reviews.
- A review that was ATTEMPTED AND FAILED could not arise either, because every
  local refine succeeds — against a stub, a key, or the old offline fallback.
  Vertex's dynamic shared quota returns 429 under real load, so that state is
  reachable in production and was reachable the day it shipped.

Both are now covered by `test/aifail.test.js`, which drives the real HTTP path
against a stub model and asserts what happens when the model does not answer:
429 and 5xx retried three times, 400 not retried, the refusal carrying no
review content, the offline heuristic NOT filling the gap, and 401 deciding
before availability so an anonymous probe cannot learn whether the model is up.
It also pins every branch of the delete dialog's spend line.

**The pattern to check for when adding a feature:** list the orderings in which
a step is skipped or fails, not just the one where each step succeeds. Those
are the states no fixture will build for you, and they are the ones a clinic
meets first.

---

## Deploy

**Production is on `8926714`, revision `therachart-00059-cxk`**, deployed
2026-08-21, `main` pushed to `origin/main`.

> The commit recording a deploy always postdates the deploy it describes, so
> this line can never be inside the release it names. What matters is that the
> *artifact* matches: `NOTES.md`, `test/` and `test-results/` are all in
> `.gcloudignore`, so a commit touching only those produces a byte-identical
> image and there is nothing to re-ship.

Three deploys that day. The first, `4f4d080` / `therachart-00056-zvt`, carried 22
commits from two sessions working in the same checkout:
the note editor's workflow groups, clinic suspend/delete, draft trash with
recovery, the demo banner, the preferred-name field, the screenshot harness and
all 24 recaptured images, the removal of every legal and regulatory claim from
the product — and on the AI side the removal of the offline reviewer,
retry-with-backoff, the `side` field on `mmt`/`pain`, and the speaker/voice
split in dictation.

The second, `ffc542a` / `therachart-00057-dhv`, was a single commit: the delete
dialog no longer names a zero it never spent.

The third, `8ea04d5` / `therachart-00058-fqm`, carried no behaviour change at
all — `test/aifail.test.js` and these notes, plus one line of `package.json`'s
test script that the runtime never executes. Deployed so the running revision
sits on the current commit rather than one behind it.

### 2026-08-21 — `8926714` / `therachart-00059-cxk`

One commit, and the largest change to what a clinic pays since the ladder
existed. `PRICING.md` carries the reasoning; the short version:

- **The chart review was running two or three times a visit, not once.**
  `chartReviewKey()` hashed every document's `_mod`, drafts included, and a
  draft autosaves on every keystroke. The unit model had always assumed one
  run. A visit cost ₱13.38, not the ₱8.84 the price was set against. The key
  is now built from **signed** documents only.
- **Insights dropped `high` → `medium`**, after the eval returned 100% at both
  over three runs against Vertex. Together with the above: ₱13.38 → ₱7.59.
- **The ladder was repriced** — ₱3,450 / ₱6,700 / ₱10,900 / ₱32,900 — the pool
  cut 10 → 6 min, and overage moved to ₱42 + ₱7 as a matched pair. January
  margins 51–60% → 69–74% at typical use, and 2–6% → 50–55% at full
  entitlement.
- **Security headers**, which the service had none of. CSP with
  `frame-ancestors 'none'`, nosniff, Referrer-Policy, a microphone-scoped
  Permissions-Policy, HSTS. One inline script became `boot.js` so
  `script-src 'self'` could hold.
- **`/api/insights` and `/api/patient-assistant` now clamp their payloads.**
  Both handed the 15 MB request body to the prompt builder, which the model
  accepts and bills rather than rejecting.
- **Six dictation defects**, the worst of which charted an active painful
  shoulder for a patient who had said in Cebuano that the pain was gone.
- The note editor's billing minutes no longer clip, the source labels read in
  the third person, each document type colours its whole page, and the landing
  page finally says what a clinic needs in order to start.

`verify-prod.sh` is 24 checks now, not 19 — the five new ones are the security
headers, which can only be seen on the running revision.

Two things deliberately NOT done, both waiting on Kim's testing rather than on
us: the charge sheet still uses **US CPT codes and Medicare's 8-minute rule**
for clinics that file PhilHealth and HMO, and **nothing collects money** — the
app meters visits, minutes and overage and can suspend a clinic, but there is
no payment integration at all.

### Expect this, and don't read it as a fault

With the offline reviewer gone, **a failed AI review now shows the clinician a
dialog instead of quietly substituting a keyword pass.** Vertex's *dynamic
shared quota* — Google's shared pool, not our project limits, which are nowhere
near binding — does occasionally return 429 under load. Retry-with-backoff sits
in front of it (3 attempts on 429/5xx/timeout) and absorbs nearly all of it,
and the dialog leads with **Try again**, which normally lands.

So "AI review didn't complete" is the system working: saying so, rather than
handing a therapist a worse note and calling it an AI review. Worth knowing
before someone goes hunting through our own quota config for a problem that
isn't there.

### Three "reviewer" strings that survive on purpose

A grep for the removed offline reviewer finds three hits in `app.js`. All three
are deliberate. **Do not finish the cleanup.**

| Where | String | Why it stays |
|---|---|---|
| `app.js:3593` | `the local reviewer` | The printed attestation on a signed document. The interface names the *function*; the record names the *system*. Someone reading a note months later needs to know what actually wrote the text, and "AI" does not answer that. |
| `app.js:6106` | `offline reviewer` | The cleanup-card chip for those same historical notes. Relabelling a past local review as "AI" would be false. |
| `app.js:7414` | `built-in reviewer` | Inside a code comment explaining why that branch was rewritten. Not user-facing. |

The first two only ever render for documents reviewed **before** the
2026-08-20 deploy. Nothing produces a local review any more; these exist so the
record of one stays honest.

The general rule, worth keeping: **identity assertions keep the precise value,
the friendly surface gets the readable one.** It is the same split as legal
name vs. preferred name — a signed document and a chart header answer different
questions, and so do a signed attestation and a chip.

### Running it again

- `deploy-gcp.sh` ships the **working directory**, not a commit — the tree must
  be clean and must be what you mean to send
- it reads the live service's settings and carries them forward, **but a shell
  export beats the live value**. Run `echo "[$THERACHART_DEMO_LOGINS]"` first;
  empty is what you want. `--set-env-vars` replaces the whole environment, so
  this is not a partial update you can casually walk back, and prod is
  INVITE-only. Watch the script's own `carrying forward:` line — it should read
  `demo-logins=0  demo-invite=1`.
- `./verify-prod.sh` afterwards — 19 read-only checks, non-zero exit on failure
