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
- **Replace `YOUR_PROJECT_ID` with your real id** (e.g. `therachart-prod`) — don't
  paste the placeholder literally.

> ### Deploy fails with `storage.objects.get denied` / `403` on
> ### `PROJECT_NUMBER-compute@developer.gserviceaccount.com`?
> New projects don't auto-grant permissions to the build service account, so the
> first source deploy can't read your uploaded code. Grant it (use **your**
> project id and the compute service account from the error message), wait ~1
> minute, then re-run the deploy:
> ```bash
> gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
>   --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
>   --role="roles/cloudbuild.builds.builder"
> gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
>   --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
>   --role="roles/storage.objectViewer"
> ```

**Credentials are automatic.** On Cloud Run the app uses the service account
attached to the service — no key files. Grant that account permission to call
Speech-to-Text:

1. Console → **IAM & Admin → IAM**.
2. Find the Cloud Run service account (usually
   `PROJECT_NUMBER-compute@developer.gserviceaccount.com`).
3. **Edit → Add role** → give it access to Speech-to-Text (the role listed under
   "Cloud Speech"; if you can't find it, use **Editor** while setting up and
   tighten later).

> ### ⚠️ Important: data storage on Cloud Run is temporary WITHOUT Postgres
> By default the app keeps its database in a **file** (`data/therachart.json`).
> Cloud Run's disk is **wiped every time it restarts or scales**, so the flat
> file is **not safe for real records** on Cloud Run. **The fix is built:** set
> `DATABASE_URL` and the app persists to **Cloud SQL (Postgres)** instead (see
> the next section). Similarly, set **`GCS_BUCKET`** so patient attachments **and**
> kept session-audio go to **Cloud Storage** rather than the ephemeral disk. Don't
> store real patient data on Cloud Run until both `DATABASE_URL` and `GCS_BUCKET`
> are set (the `deploy-gcp.sh` script sets both).

### Durable storage: Cloud SQL (Postgres)

The server auto-detects `DATABASE_URL`. When set, the store, sync revision, and
device sessions live in a tiny `kv` table (auto-created on first boot) instead
of the flat file — surviving restarts and scale events. No schema step needed.

```bash
# 1) Create a small Postgres instance
gcloud sql instances create therachart-db \
  --database-version=POSTGRES_15 --tier=db-f1-micro \
  --region=us-central1 --storage-size=10GB
# 2) Create the database + an app user
gcloud sql databases create therachart --instance=therachart-db
gcloud sql users create therachart --instance=therachart-db --password=SECRET
# 3) Deploy Cloud Run wired to it (note the Cloud SQL socket in DATABASE_URL)
gcloud run deploy therachart --source . --region us-central1 \
  --add-cloudsql-instances YOUR_PROJECT:us-central1:therachart-db \
  --max-instances 1 \
  --set-env-vars "DATABASE_URL=postgresql://therachart:SECRET@/therachart?host=/cloudsql/YOUR_PROJECT:us-central1:therachart-db"
```

> **`--max-instances 1` matters.** The whole store is one row with an offline-merge
> sync model, so it assumes a **single writer**. Keep it at one instance until the
> schema is normalized per-table. (Cloud SQL bills ~$8–10/mo the moment the
> instance exists — it does *not* scale to zero. Set a budget alert first.)

Confirm on boot: the server logs `data: Postgres (durable) …`. Locally, leaving
`DATABASE_URL` unset keeps the zero-dependency flat-file behavior.

### File attachments: Cloud Storage

Patient attachments (referrals, imaging, **scanned old charts**) are bytes — too
big to sit in the database blob. Set `GCS_BUCKET` and they're stored in **Google
Cloud Storage** instead (~$0.02/GB/month), keeping the database small and fast.
The database only holds a small reference per file; downloads stream back through
the server, behind the login. `deploy-gcp.sh` sets this up automatically, or
manually:

```bash
gcloud storage buckets create gs://YOUR_PROJECT-files \
  --location=us-central1 --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding gs://YOUR_PROJECT-files \
  --member="serviceAccount:YOUR_SA" --role="roles/storage.objectAdmin"
# then deploy with --set-env-vars GCS_BUCKET=YOUR_PROJECT-files
```

Uses the same credential chain as STT/Vertex (no key files on Cloud Run). Boot
log shows `files: Google Cloud Storage (bucket …)`. Without `GCS_BUCKET`, files
go to local disk (fine for dev; ephemeral on Cloud Run). Do this **before bulk-
uploading scanned records** so big batches stay cheap and the database stays fast.

### Optional: temporary session-audio review

The app can keep dictation audio **briefly** so a clinician can replay it to
double-check the transcript, then it auto-deletes (on sign, or after the
retention window). It's **off by default** and only kept for **patients who
consent** — turn it on in **Facility Admin → Allow temporary session-audio
review**. It works only with the Google Cloud dictation engines (the browser
engine's audio never reaches your server). When `GCS_BUCKET` is set the segments
are stored in **Cloud Storage** (durable, under the same BAA) and auto-deleted on
sign or after the retention window; without it they use local disk. For defense
in depth you can add a bucket **lifecycle rule** to hard-delete anything under
`audio/` after N days as a backstop to the app's own sweep.

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
- **Gemini** (the "Review & clean up" + insights + PDF import) — **now supports
  Vertex AI**, the BAA-covered path. Two ways to run it:

  | Mode | How to enable | BAA? | Use for |
  |---|---|---|---|
  | **Consumer API key** | `GEMINI_API_KEY=...` | ❌ no | demo / non-PHI |
  | **Vertex AI** | `GEMINI_VERTEX=1` + `GCP_PROJECT` + a Google credential | ✅ yes | real PHI |

  **Vertex needs no API key.** It reuses the **exact same credential chain as
  Speech-to-Text** (`GCP_ACCESS_TOKEN` for quick tests, `GOOGLE_APPLICATION_CREDENTIALS`
  / `GCP_SA_KEY` for a service-account key, or nothing on Cloud Run — the attached
  service account is used automatically). So if STT already works on this server,
  Vertex Gemini just needs `GEMINI_VERTEX=1`.

  ```bash
  gcloud run deploy therachart \
    --set-env-vars GEMINI_VERTEX=1,GCP_PROJECT=YOUR_PROJECT_ID
  ```

  Requirements: enable the **Vertex AI API** (`aiplatform.googleapis.com`) on the
  project, and grant the service account the **Vertex AI User** role
  (`roles/aiplatform.user`). `GEMINI_LOCATION` defaults to **`global`** — the only
  Vertex location that serves the Gemini 3.x models (regional endpoints like
  `us-central1` return 404 for them). Only set `GEMINI_LOCATION` if data
  residency forces a region AND you've confirmed the models exist there.
  Confirm at `/api/ai-status` → `"provider":"vertex"`. Every path uses
  `gemini-3.6-flash` with thinking on everywhere; only the depth varies.
  Transcript cleanup runs at **`medium`** — dropping it lower measurably breaks
  the "every finding is traceable to the transcript" check on code-switched
  Taglish dictation (95.5% → 92.5% over 3 eval runs). Document import, Clinical
  Insights, and the patient assistant run at **`high`**, since each reasons
  across a whole chart or document. Note `low`/`minimal` spend zero thinking
  tokens. Override the model per env with `GEMINI_MODEL` /
  `GEMINI_INSIGHTS_MODEL` if a name differs on Vertex, and the level with
  `GEMINI_THINKING_LEVEL` when running the eval.

## Serving closer to your clinics (multi-region)

By default everything runs in **us-central1** (Iowa). That works from anywhere in
the world — `us-central1` is just where the servers live, not a restriction on
who can use the app — but users far away (e.g. the **Philippines**) see extra
latency, and their patient data is stored in the US. To test the app served from
Asia, `deploy-gcp.sh` takes a region argument:

```bash
./deploy-gcp.sh          # or ./deploy-gcp.sh us  — the US stack (us-central1)
./deploy-gcp.sh asia     # a SEPARATE stack in asia-southeast1 (Singapore)
```

Key points:

- **The two stacks are fully independent.** Each has its own Cloud SQL instance,
  bucket, secret, and Cloud Run URL. Deploying `asia` never touches US prod. The
  Singapore stack starts with an empty database (it auto-seeds the demo clinic),
  so it's a clean sandbox — testing there can't affect real US data.
- **You "flip" by opening the URL you want** — both run at the same time. Get
  each URL with:
  ```bash
  gcloud run services describe therachart --region asia-southeast1 \
    --project therachart-prod --format='value(status.url)'
  ```
- **Dictation model region.** STT follows the deploy region. If **Chirp** isn't
  offered in `asia-southeast1`, either use the Standard model, or pin STT to a
  Chirp region:  `STT_REGION=us-central1 ./deploy-gcp.sh asia`.
- **Gemini stays `global`** for both stacks (the 3.x models live only there).
- **Data residency.** Storing PH patient data in the US (or routing AI through
  the `global` Gemini endpoint) may bump into the **Philippines Data Privacy Act
  (RA 10173)** / National Privacy Commission — review before real patient data.

**Cost of the extra stack:** the only meaningful new charge is a **second
Cloud SQL instance (~$8–10/mo)** — it's always-on and doesn't scale to zero. The
Asia Cloud Run service scales to zero (~$0 idle), the bucket is pennies, and
STT/Gemini stay pay-per-use. Tear the test stack down when done to stop the bill:

```bash
gcloud run services delete therachart --region asia-southeast1 --project therachart-prod
gcloud sql instances delete therachart-db-asia --project therachart-prod
gcloud storage rm -r gs://therachart-prod-files-asia
```

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
- [ ] `DATABASE_URL` set to Cloud SQL (boot log shows `Postgres (durable)`) + `--max-instances 1`
- [ ] Demo PIN logins (1234) replaced with real per-user credentials
- [ ] Google Cloud STT selected and tested (Part 6)
- [ ] Gemini either off, or moved to Vertex under the BAA (`GEMINI_VERTEX=1`)
- [ ] `GCS_BUCKET` set so attachments + session-audio go to Cloud Storage (boot log shows `files: Google Cloud Storage`); patient consent captured before enabling audio review
