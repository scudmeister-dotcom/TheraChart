# Going live on Google Cloud — a first-timer's guide

This walks you from "it runs on my laptop / Vercel" to "it runs on Google
Cloud, reachable anywhere, with speech-to-text under a healthcare agreement."
No prior Google Cloud experience assumed. Do the parts in order.

**What you'll end up with**

- The app hosted on **Cloud Run** (Google runs the server; you pay per use).
- Voice dictation switched to **Google Cloud Speech-to-Text** (Standard + Chirp)
  **under a signed BAA** — so spoken patient info is covered.
- One vendor, one bill, one agreement.

> **Terms in one line.** A **BAA** (Business Associate Agreement) is the contract
> that makes Google legally responsible for protecting patient data. It's **free**
> to sign; you only pay for usage. Signing it is what separates "a Google demo"
> from "HIPAA-eligible."

---

## Part 1 — Create your Google Cloud account and project (~15 min)

1. Go to **https://console.cloud.google.com** and sign in with a Google account
   (use a work account you control, not a personal one, for a real clinic).
2. New customers get **$300 free credit** — click through the free-trial prompt
   and add a billing card (you won't be charged unless you exceed the credit or
   turn off the trial). Speech-to-Text also has a small monthly free tier.
3. Top of the page, click the **project dropdown → New Project**.
   - Name it e.g. `therachart-prod`.
   - After it's created, **select it** in the dropdown.
   - Note the **Project ID** — the exact string in the console's **ID** column
     (e.g. `therachart-prod`). Google appends a random number (e.g.
     `therachart-prod-472213`) **only if** that name was already taken, so yours
     may or may not have one — use whatever is shown. This is your `GCP_PROJECT`.
   - Not to be confused with the **Project number** (all digits, e.g.
     `483920571028`), also shown on the console dashboard. You don't need it now,
     but you'll use it in Part 5 for the service-account name.

## Part 2 — Sign the BAA (do this BEFORE any real patient data)

The BAA is accepted **once, for the whole account**, and then covers the
HIPAA-eligible services (Cloud Run, Speech-to-Text, Vertex AI, Cloud SQL).

1. In the console, open the menu (☰) → **Compliance** (or search "BAA" in the
   top search bar).
2. Review and **accept the Business Associate Agreement**. On some accounts this
   is self-serve; on others you request it through your Google Cloud account
   team / support. It is free.
3. **Confirm it shows as active before uploading real PHI.** Until it's in place,
   only use fake/demo data.

> If you're not sure whether your account can self-accept, open a support case
> asking to "execute a HIPAA Business Associate Agreement for project
> `<your-project-id>`." This is a routine request.

## Part 3 — Turn on the APIs you'll use (~5 min)

In the console, use the top search bar to open each API page and click
**Enable**:

- **Cloud Speech-to-Text API** (for dictation)
- **Cloud Run Admin API** (for hosting)
- **Cloud Build API** (Cloud Run uses it to build your container)
- *(later, when you wire Gemini through Vertex)* **Vertex AI API**

## Part 4 — Install the `gcloud` tool (~10 min)

`gcloud` is Google's command-line tool. Install it once:

- Mac: `brew install --cask google-cloud-sdk` (or the installer at
  https://cloud.google.com/sdk/docs/install)

Then sign in and point it at your project:

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID      # the id from Part 1
```

> **Seeing a yellow `WARNING: Your active project does not match the quota
> project…`?** That's harmless — as long as the last line says
> `Updated property [core/project]`, the project is set and you can continue. The
> warning is only about **Application Default Credentials** (a separate local
> file), which the Cloud Run deploy doesn't use. If you later do the optional
> "test STT locally" step, silence it with
> `gcloud auth application-default set-quota-project YOUR_PROJECT_ID` (run
> `gcloud auth application-default login` first if it complains).

## Part 5 — Deploy the app to Cloud Run (this replaces Vercel)

From the TheraChart folder, run **one command**:

```bash
gcloud run deploy therachart \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GCP_PROJECT=YOUR_PROJECT_ID,STT_LOCATION=us-central1
```

- `--source .` tells Cloud Run to build a container from this folder and run
  `node server.js`. (The server already reads the `PORT` Cloud Run gives it.)
- `--allow-unauthenticated` makes the web app reachable in a browser. Your own
  PIN login still protects the data.
- It prints a public **URL** (like `https://therachart-xxxx.run.app`) — that's
  your app, reachable from anywhere.

**Credentials are automatic.** On Cloud Run the app uses the service account
attached to the service — no key files. Grant that account permission to call
Speech-to-Text:

1. Console → **IAM & Admin → IAM**.
2. Find the Cloud Run service account (usually
   `PROJECT_NUMBER-compute@developer.gserviceaccount.com`).
3. **Edit → Add role** → give it access to Speech-to-Text (the role listed under
   "Cloud Speech"; if you can't find it, use **Editor** while setting up and
   tighten later).

> ### ⚠️ Important: data storage on Cloud Run is temporary
> Right now the app keeps its database in a **file** (`data/therachart.json`),
> and any kept **session-audio** in `data/audio/`. Cloud Run's disk is **wiped
> every time it restarts or scales**, so those are **not safe for real records**
> on Cloud Run. For the preview it's fine. For real go-live, the database must
> move to **Cloud SQL (Postgres)** and kept audio to **Cloud Storage** (encrypted,
> with a lifecycle rule that auto-deletes) — that's the next build. Don't store
> real patient data on Cloud Run until that's done.

### Optional: temporary session-audio review

The app can keep dictation audio **briefly** so a clinician can replay it to
double-check the transcript, then it auto-deletes (on sign, or after the
retention window). It's **off by default** and only kept for **patients who
consent** — turn it on in **Facility Admin → Allow temporary session-audio
review**. It works only with the Google Cloud dictation engines (the browser
engine's audio never reaches your server). At go-live, point this at **Cloud
Storage** with a lifecycle auto-delete rule and object encryption, all under the
same BAA — see the storage caveat above.

## Part 6 — Turn on Google Cloud dictation and verify

Once Part 5's env vars are set and the service account has access:

1. Open your Cloud Run URL, sign in, open any note.
2. In the dictation bar, the **"Google Cloud — Standard"** and **"— Chirp"**
   options are now **enabled** (they were greyed out as "needs Google Cloud
   setup" before). Pick one and dictate.
3. If something's off, check the logs: **Cloud Run → your service → Logs**. The
   startup line shows `dictation: Google Cloud Speech-to-Text (project …)` when
   it's wired correctly.

To change models later, just re-deploy with a different `STT_LOCATION` or pick
Standard vs Chirp per note in the dictation bar. **Chirp** needs a regional
location (e.g. `us-central1`), not `global`.

## Testing STT locally (optional)

You don't need this if you deploy straight to Cloud Run, but to try Google STT
on your own machine:

1. Console → **IAM & Admin → Service Accounts → Create service account**, give it
   Speech-to-Text access, then **Keys → Add key → JSON** and download the file.
2. Run the server pointing at it:

   ```bash
   GCP_PROJECT=YOUR_PROJECT_ID \
   STT_LOCATION=us-central1 \
   GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json \
   node server.js
   ```

   (Quick one-off alternative: `GCP_ACCESS_TOKEN=$(gcloud auth print-access-token)`
   — but that token expires in ~1 hour.)

3. **Keep the key file secret** — never commit it. It's already covered by
   `.gitignore` patterns for secrets, but double-check.

## What about Gemini (AI cleanup) under the BAA?

Two separate things share your Google Cloud project:

- **Speech-to-Text** (dictation) — **fully wired now**, as above.
- **Gemini** (the "Review & clean up" + insights + PDF import) — today the app
  calls Gemini with a **consumer API key** (`GEMINI_API_KEY`). That works, but it
  is **not** the BAA-covered path. Running Gemini through **Vertex AI** (which
  *is* under the BAA) needs a small change to `ai.js` (switch to the Vertex
  endpoint + the same service-account token STT already uses). It's a quick
  follow-up — ask when you want it turned on, and until then leave Gemini off (the
  built-in local reviewer) for real PHI.

## Rough monthly cost (per active clinic)

| Piece | Estimate |
|---|---|
| Cloud Run + (later) Cloud SQL | ~$50–150 |
| Speech-to-Text (Standard ~$0.024/min · Chirp ~$0.064/min) | ~$210–420 |
| Gemini cleanup (once on Vertex) | a few dollars |
| **BAA** | **$0** |

Speech-to-text is the dominant cost — use the **Standard** model to roughly
halve it, or **Chirp** when you need the best Tagalog/Cebuano accuracy.

## Before you store real patient data — checklist

- [ ] BAA accepted and confirmed active (Part 2)
- [ ] Database moved off the flat file to Cloud SQL (Postgres)
- [ ] Demo PIN logins (1234) replaced with real per-user credentials
- [ ] Google Cloud STT selected and tested (Part 6)
- [ ] Gemini either off, or moved to Vertex under the BAA
- [ ] If session-audio review is on: kept audio moved to Cloud Storage (encrypted, lifecycle auto-delete) and patient consent captured
