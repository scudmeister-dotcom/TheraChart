# Deploying TheraChart

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
   | `GEMINI_MODEL` *(optional)* | `gemini-3.5-flash` (default) — Flash tier: transcript cleanup + document reading |
   | `GEMINI_INSIGHTS_MODEL` *(optional)* | `gemini-3.1-pro-preview` (default) — Pro tier: Clinical Insights. Bump to `gemini-3.5-pro` once it ships |
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
reminder scheduler. The Gemini key can be the `GEMINI_API_KEY` env var
(recommended) or pasted in **Facility Admin**.

Voice dictation uses the browser engine out of the box; to enable **Google
Cloud Speech-to-Text** (Standard/Chirp, under a BAA) set `GCP_PROJECT` +
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
