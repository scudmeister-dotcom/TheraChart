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

## Deploy

**Production is on `4f4d080`, revision `therachart-00056-zvt`**, deployed
2026-08-20. `main` is pushed to `origin/main` and the tree, the remote and the
running service are all the same commit.

That deploy carried 22 commits from two sessions working in the same checkout:
the note editor's workflow groups, clinic suspend/delete, draft trash with
recovery, the demo banner, the preferred-name field, the screenshot harness and
all 24 recaptured images, the removal of every legal and regulatory claim from
the product — and on the AI side the removal of the offline reviewer,
retry-with-backoff, the `side` field on `mmt`/`pain`, and the speaker/voice
split in dictation.

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
| `app.js:7394` | `built-in reviewer` | Inside a code comment explaining why that branch was rewritten. Not user-facing. |

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
