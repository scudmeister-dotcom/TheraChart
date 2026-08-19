# Deploying TheraChart

> ## ⚠️ Cost hold: Cloud SQL is intentionally STOPPED
>
> **As of 2026-07-26 the `therachart-db` Cloud SQL instance is stopped**
> (`activation-policy NEVER`) to stop the ~US$8–10/mo compute charge during
> development. It is the only resource in the project that billed around the
> clock — Cloud Run scales to zero, and Gemini/STT/GCS are per-use.
>
> **Consequence:** the deployed Cloud Run service
> (https://therachart-cmcoe52aaa-uc.a.run.app) returns 503 while the database is
> down. This is expected, not an outage to debug.
>
> **Development continues on local Postgres 15** — see
> [Local Postgres for development](#local-postgres-for-development) below. Every
> feature works locally, including Vertex Gemini and Cloud Speech-to-Text.
>
> **Before go-live, this must be turned back on** — see the
> [Go-live checklist](#go-live-checklist) at the bottom of this file. A safety
> export of the database was taken first:
> `gs://therachart-prod-files/backups/therachart-20260726.sql`

TheraChart runs three ways. Pick the one that matches how you want to use it.

## 1. Vercel (easiest — great for a demo or single-device use)

Vercel serves the app as a static site and runs the AI features (transcript
clean-up + clinical insights) as serverless functions that read your Gemini
key from an **environment variable**. There is no shared database in this mode
— each device keeps its own records in the browser (on-device mode).

**Steps**

1. Push this repo to GitHub (already done if you're reading this there).
2. In Vercel: **Add New → Project → Import** this repository. No build command
   or framework preset is needed — `vercel.json` configures everything.
3. In **Project → Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `GEMINI_API_KEY` | your Google Gemini API key |
   | `GEMINI_MODEL` *(optional)* | `gemini-3.6-flash` (default) — transcript cleanup (thinking `medium`) + document reading (thinking `high`) |
   | `GEMINI_INSIGHTS_MODEL` *(optional)* | `gemini-3.6-flash` (default) — Clinical Insights, thinking level `high` |
   | `GEMINI_BASE_URL` *(optional)* | a Vertex AI endpoint if using a BAA |

   Set these **once** in the platform's env settings and every future deploy
   inherits them automatically — you don't re-enter the key per deploy.

4. **Deploy.** Open the URL — the "✦ Review & clean up with AI" and
   "✦ Clinical insights" features now use Gemini. Without the key, the app
   still works using the built-in local reviewer.

**What the key touches:** only transcript/chart **text** is sent to Gemini,
never audio. The key lives only in Vercel's env (never in the database or the
browser). See the in-app Privacy panel for the PHI/BAA note — for real PHI,
use paid **Vertex AI Gemini under a signed BAA** via `GEMINI_BASE_URL`.

**Note on the AI endpoints:** on Vercel the `/api/refine` and `/api/insights`
functions are public to your deployment. For a private clinic, either keep the
deployment behind Vercel's Deployment Protection, or use option 2 below.

## 2. Self-hosted clinic server (shared database across devices)

Run the included zero-dependency Node server on one machine in the clinic:

```bash
GEMINI_API_KEY=... node server.js      # serves app + shared DB on :8080
```

Every phone/tablet/computer on the network opens `http://<that-machine>:8080`.
This mode adds the shared database, server-side login, offline sync, and the
reminder scheduler. The Gemini backend is configured with the `GEMINI_API_KEY`
env var (or the Vertex path below) — there is no in-app key field.

By default the database is a flat file under `data/`. For durable, restart-safe
storage (required on Cloud Run), set **`DATABASE_URL`** to a Postgres instance —
the app persists there automatically. See **[GOOGLE_SETUP.md](GOOGLE_SETUP.md)**.

Voice dictation falls back to the browser engine out of the box; to run it on
**Google Cloud Speech-to-Text** (Chirp 2, under a BAA) set `GCP_PROJECT` +
credentials — see **[GOOGLE_SETUP.md](GOOGLE_SETUP.md)**.

For **real PHI**, run Gemini through **Vertex AI** (BAA-covered) instead of the
consumer key: set `GEMINI_VERTEX=1` + `GCP_PROJECT` + a Google credential (the
same chain STT uses). No API key needed. See **[GOOGLE_SETUP.md](GOOGLE_SETUP.md)**.

See `README.md` for the full clinic-server details (reminders, reaching it
from outside the clinic via Tailscale, PWA install).

## 3. Plain static hosting (no AI backend)

Serve the folder from any static host (or `python3 -m http.server`). Everything
works on-device; the AI features fall back to the local reviewer (no Gemini).

## 4. Google Cloud Run — recommended for going live worldwide

The same `server.js` runs as a container on **Cloud Run**, reachable by every
clinic anywhere, with hosting + database + Speech-to-Text + Gemini all under
**one Google Cloud BAA**. Because Cloud Run supplies the service-account
credentials automatically, no key files are needed. This is the path off Vercel
(which won't sign a BAA on standard plans).

Full step-by-step for a first-timer — create the account, sign the BAA, enable
the APIs, deploy, and flip on Google Cloud STT + Vertex Gemini — is in
**[GOOGLE_SETUP.md](GOOGLE_SETUP.md)**.

---

### Which AI runs where

| Deployment | Data | Transcript clean-up & Insights |
|---|---|---|
| Vercel + `GEMINI_API_KEY` | on-device (per browser) | **Gemini** via serverless functions |
| Vercel, no key | on-device | local reviewer |
| Clinic server + key | shared DB | **Gemini** (server-side) |
| Clinic server, no key | shared DB | local reviewer |
| Static host | on-device | local reviewer |

The app auto-detects which is available (`GET /api/ai-status`) and shows the
active engine (Gemini vs local) on each result.

---

## Local Postgres for development

Cloud SQL is stopped (see the note at the top). To develop against the **same
durable code path** production uses, without paying for Cloud SQL, run Postgres
locally. Match the production major version — Cloud SQL is **POSTGRES_15**:

```bash
brew install postgresql@15 && brew services start postgresql@15
```

Create the role and database using the same names production uses:

```bash
psql postgres -c "CREATE ROLE therachart LOGIN PASSWORD 'localdev';" -c "CREATE DATABASE therachart OWNER therachart;"
```

Run the server against it:

```bash
DATABASE_URL=postgresql://therachart:localdev@localhost:5432/therachart node server.js
```

The boot banner should read `data: Postgres (durable) — keys: store, rev, sessions`.

**How faithful is this?** The app's entire SQL surface is four plain statements
against a two-column `kv` table ([db.js](db.js)) — no extensions, no
version-specific syntax — so local Postgres 15 and Cloud SQL behave identically
at the database layer. What differs is the *connection*, not the code:

| | Cloud Run | Local |
|---|---|---|
| Transport | Unix socket via Cloud SQL proxy | TCP |
| `DATABASE_URL` | `postgresql://therachart:PASS@/therachart?host=/cloudsql/therachart-prod:us-central1:therachart-db` | `postgresql://therachart:localdev@localhost:5432/therachart` |
| Source of the URL | Secret Manager (`--set-secrets`) | plaintext env var |

Leave the pool at `max: 4` ([db.js](db.js)) — it is sized for `db-f1-micro`'s low
connection ceiling, which a local box will not reveal.

### Simulating Cloud Run's ephemeral disk

The reason Postgres exists in this app is that Cloud Run's disk resets on every
deploy, restart, and scale event. Locally your disk persists, which hides bugs
where something durable is written to disk instead of the database. Reproduce
production by wiping the data directory between runs:

```bash
rm -rf /tmp/tc-eph && DATABASE_URL=postgresql://therachart:localdev@localhost:5432/therachart THERACHART_DATA=/tmp/tc-eph node server.js
```

If patients, notes, and logins all survive the wipe, records really do live in
the database. If **attachments** vanish, that is correct — it is exactly what
production does when `GCS_BUCKET` is unset, which is why production sets it.

### What local Postgres still does *not* exercise

These are Cloud Run differences, not database differences. They can only be
proven by an actual deploy:

- **Cloud Storage file backend** — production sets `GCS_BUCKET`, so
  [files.js](files.js) takes the GCS branch; locally it takes the local-disk
  branch. Attachments and session audio run through genuinely different code.
- **Metadata-server credentials** — production resolves Google credentials via
  `K_SERVICE`/the metadata server; locally you use `GCP_ACCESS_TOKEN`.
- **Secret Manager + IAM** — the `roles/secretmanager.secretAccessor` and
  `roles/cloudsql.client` bindings from [deploy-gcp.sh](deploy-gcp.sh).
- **Cold start under a live request** — `start()` awaits `db.init()` before it
  listens.

---

## Go-live checklist

Work through this when moving off the cost hold and back to production.

1. **Start Cloud SQL** and wait for `RUNNABLE` (~1–3 min):

   ```bash
   gcloud sql instances patch therachart-db --activation-policy ALWAYS
   ```

2. **Deploy the current code.** The server connects to Postgres *before* it
   listens ([db.js](db.js)), so a deploy attempted while the database is
   stopped fails its health check and traffic stays on the old revision —
   Cloud SQL has to be running first. Deploy with:

   ```bash
   ./deploy-gcp.sh
   ```

   Or, if the image is already current and you only need a restart (the service
   crash-loops with `exit(1)` and serves 503s if it booted while the database
   was down), force a fresh revision with no rebuild:

   ```bash
   gcloud run services update therachart --region us-central1 --update-env-vars RESTART_TS=$(date +%s)
   ```

3. **Verify.** Run the read-only checker against the live service — it confirms
   the app is up, that every API endpoint refuses unauthenticated access, that
   private paths and server-side source are not served, and that AI is on the
   Vertex/BAA path rather than a consumer key:

   ```bash
   ./verify-prod.sh
   ```

   It changes nothing. Do **not** point the development probe at production —
   that one resets passwords and deletes records to prove the tenancy boundary.

   Then sign in once and confirm a chart loads.

4. **Confirm `GCS_BUCKET` is set** on the service — without it, attachments and
   session audio land on Cloud Run's ephemeral disk and are lost on every
   restart. Exercise an attachment upload and download once against the real
   bucket, since local development never runs that code path.

5. **Keep `--max-instances 1`.** The whole store is a single `kv` row, so the
   design assumes ONE writer ([db.js](db.js)). Raising this will corrupt data
   until the schema is normalized.

6. **Re-check the AI credentials.** The consumer `GEMINI_API_KEY` path is
   separate from Vertex; production uses `GEMINI_VERTEX=1` + the metadata-server
   credential, which needs no key.

7. **Take a fresh backup** before any risky change:

   ```bash
   gcloud sql export sql therachart-db gs://therachart-prod-files/backups/therachart-$(date +%Y%m%d).sql --database=therachart
   ```
