#!/usr/bin/env bash
# One-shot GCP deploy for TheraChart. Ships the current code to Cloud Run with
# Postgres (Cloud SQL) + Vertex Gemini + Cloud STT + file storage wired up.
# Safe to re-run — every step is idempotent. No secrets are printed.
#
# USAGE:
#   ./deploy-gcp.sh            # deploy/refresh the US stack (us-central1) — prod
#
# Settings already on the service (Google sign-in, demo logins, demo invite,
# allowlist) are READ AND CARRIED FORWARD, so a plain code deploy never turns a
# feature off behind your back. Export a variable to change it; export it to 0
# or "" to explicitly turn it off:
#   THERACHART_DEMO_LOGINS=0 ./deploy-gcp.sh      # turn the demo panel OFF
#   ./deploy-gcp.sh us         #   …same thing, explicit
#   ./deploy-gcp.sh asia       # deploy an INDEPENDENT stack in asia-southeast1
#                              #   (Singapore) — for testing latency/residency
#                              #   from the Philippines
#
# The two stacks are fully separate: their own Cloud SQL instance, bucket,
# secret, database, and Cloud Run URL. Deploying one never touches the other.
# On its FIRST run, `asia` provisions a new Cloud SQL instance (~5–10 min) that
# bills ~US$8–10/mo until deleted — see the teardown note at the bottom.
#
# STT region: follows the deploy region by default. Dictation runs on Chirp 2,
# which is GA for fil-PH and ceb-PH in both us-central1 and asia-southeast1, so
# neither stack needs pinning. To pin it anyway:
#   STT_REGION=us-central1 ./deploy-gcp.sh asia
set -euo pipefail

ENVIRONMENT="${1:-us}"

PROJ=therachart-prod
SA=1060950042386-compute@developer.gserviceaccount.com
SERVICE=therachart          # Cloud Run service names are per-region, so the
                            # same name yields one 'therachart' per region

case "$ENVIRONMENT" in
  us)
    REGION=us-central1
    DB_INSTANCE=therachart-db
    BUCKET="${PROJ}-files"
    SECRET=therachart-db-url
    ;;
  asia)
    REGION=asia-southeast1
    DB_INSTANCE=therachart-db-asia
    BUCKET="${PROJ}-files-asia"
    SECRET=therachart-db-url-asia
    ;;
  *)
    echo "Unknown environment '$ENVIRONMENT'. Use:  us  |  asia" >&2
    exit 1
    ;;
esac

CONN="$PROJ:$REGION:$DB_INSTANCE"
STT_REGION="${STT_REGION:-$REGION}"   # override to pin STT to a Chirp region

echo "==> Target [$ENVIRONMENT]  region=$REGION  sql=$DB_INSTANCE  bucket=$BUCKET  stt=$STT_REGION"
cd "$(dirname "$0")"

echo "==> 1/6  Enabling required APIs…"
gcloud services enable \
  secretmanager.googleapis.com sqladmin.googleapis.com run.googleapis.com \
  aiplatform.googleapis.com speech.googleapis.com \
  --project "$PROJ"

echo "==> 2/6  Ensuring Cloud SQL instance $DB_INSTANCE exists…"
if ! gcloud sql instances describe "$DB_INSTANCE" --project "$PROJ" >/dev/null 2>&1; then
  echo "    creating $DB_INSTANCE in $REGION (this takes several minutes)…"
  gcloud sql instances create "$DB_INSTANCE" --project "$PROJ" \
    --database-version=POSTGRES_15 --tier=db-f1-micro --region="$REGION" \
    --storage-size=10GB
else
  echo "    $DB_INSTANCE already exists"
fi

echo "==> 3/6  Ensuring the 'therachart' database + user, and rotating the password…"
if ! gcloud sql databases describe therachart --instance="$DB_INSTANCE" --project "$PROJ" >/dev/null 2>&1; then
  gcloud sql databases create therachart --instance="$DB_INSTANCE" --project "$PROJ"
fi
DBPASS="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)"
if gcloud sql users list --instance="$DB_INSTANCE" --project "$PROJ" --format="value(name)" | grep -qx therachart; then
  gcloud sql users set-password therachart --instance="$DB_INSTANCE" --project "$PROJ" --password="$DBPASS"
else
  gcloud sql users create therachart --instance="$DB_INSTANCE" --project "$PROJ" --password="$DBPASS"
fi

echo "==> 4/6  Storing DATABASE_URL ($SECRET) in Secret Manager…"
DBURL="postgresql://therachart:${DBPASS}@/therachart?host=/cloudsql/${CONN}"
if gcloud secrets describe "$SECRET" --project "$PROJ" >/dev/null 2>&1; then
  printf '%s' "$DBURL" | gcloud secrets versions add "$SECRET" --data-file=- --project "$PROJ"
else
  printf '%s' "$DBURL" | gcloud secrets create "$SECRET" --data-file=- --project "$PROJ"
fi
unset DBPASS DBURL

echo "==> 5/6  Ensuring the attachments bucket + service-account roles…"
if ! gcloud storage buckets describe "gs://${BUCKET}" --project "$PROJ" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${BUCKET}" --project "$PROJ" --location="$REGION" --uniform-bucket-level-access
else
  echo "    bucket gs://${BUCKET} already exists"
fi
for R in roles/cloudsql.client roles/aiplatform.user roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJ" \
    --member="serviceAccount:$SA" --role="$R" --condition=None >/dev/null
done
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:$SA" --role="roles/storage.objectAdmin" >/dev/null

# --set-env-vars REPLACES the whole environment, so every variable below has to
# be supplied on every deploy or it is silently dropped. Defaulting them to
# "off" meant a bare ./deploy-gcp.sh turned off Google sign-in and the demo
# logins on a live service — a deploy that changed only frontend code would
# quietly log everyone out of a feature. So the running service is the default:
# read what it already has, and let the environment override it.
current_env() {   # current_env VAR -> its value on the deployed service, or ""
  gcloud run services describe "$SERVICE" --project "$PROJ" --region "$REGION" \
    --format="value(spec.template.spec.containers[0].env.filter(\"name:$1\").extract(value).flatten())" \
    2>/dev/null || true
}

if gcloud run services describe "$SERVICE" --project "$PROJ" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Reading the live service's settings to carry forward…"
  LIVE_CLIENT_ID="$(current_env GOOGLE_CLIENT_ID)"
  LIVE_OWNER="$(current_env GOOGLE_OWNER_EMAIL)"
  LIVE_DEMO_LOGINS="$(current_env THERACHART_DEMO_LOGINS)"
  LIVE_ALLOWLIST="$(current_env GOOGLE_ALLOWLIST)"
else
  echo "==> No existing $SERVICE in $REGION — first deploy, using defaults."
  LIVE_CLIENT_ID=""; LIVE_OWNER=""; LIVE_DEMO_LOGINS=""; LIVE_ALLOWLIST=""
fi

echo "==> 6/6  Deploying code to Cloud Run [$SERVICE @ $REGION]…"
# Google Sign-In (optional): export GOOGLE_CLIENT_ID to change it; leave it
# unset and whatever the service already has is kept. GOOGLE_OWNER_EMAIL is
# always mapped to admin. The allowlist (who else may sign in, and as what) is
# set separately, below, because it contains commas that would clash with
# --set-env-vars' delimiter.
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-$LIVE_CLIENT_ID}"
GOOGLE_OWNER_EMAIL="${GOOGLE_OWNER_EMAIL:-${LIVE_OWNER:-amador.moriles@gmail.com}}"

# Demo/sales box: export THERACHART_DEMO_LOGINS=1 to seed the demo clinic's
# logins and list them (with their password) on the sign-in screen, so a
# prospect can click a role and be inside the app. /api/bootstrap is
# unauthenticated, so this publishes a working admin password to anyone who
# asks — leave it off on any deployment that will hold real patients. The demo
# accounts live in their own clinics and cannot see another clinic's records,
# but they are still a published credential on a public URL.
# Turning it OFF on a service that has it on needs an explicit
# THERACHART_DEMO_LOGINS=0 — silence means "keep what is there".
THERACHART_DEMO_LOGINS="${THERACHART_DEMO_LOGINS:-${LIVE_DEMO_LOGINS:-0}}"
if [ "$THERACHART_DEMO_LOGINS" = "1" ]; then
  echo "    ⚠️  DEMO LOGINS ON — the sign-in screen will publish demo accounts + password."
fi
# Same rule for the invite-only demo switch, which is a different question:
# LOGINS is "may the password be public", INVITE is "may an approved account
# try the demo clinic". Carried forward rather than reset for the same reason.
LIVE_DEMO_INVITE="$(current_env THERACHART_DEMO_INVITE)"
THERACHART_DEMO_INVITE="${THERACHART_DEMO_INVITE:-${LIVE_DEMO_INVITE:-0}}"

echo "    carrying forward: google-signin=$([ -n "$GOOGLE_CLIENT_ID" ] && echo on || echo off)  demo-logins=$THERACHART_DEMO_LOGINS  demo-invite=$THERACHART_DEMO_INVITE"

gcloud run deploy "$SERVICE" --source . --project "$PROJ" --region "$REGION" \
  --allow-unauthenticated --add-cloudsql-instances "$CONN" --max-instances 1 \
  --set-secrets "DATABASE_URL=${SECRET}:latest" \
  --set-env-vars "GCP_PROJECT=${PROJ},STT_LOCATION=${STT_REGION},GEMINI_VERTEX=1,GCS_BUCKET=${BUCKET},GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID},GOOGLE_OWNER_EMAIL=${GOOGLE_OWNER_EMAIL},THERACHART_DEMO_LOGINS=${THERACHART_DEMO_LOGINS},THERACHART_DEMO_INVITE=${THERACHART_DEMO_INVITE}"

# Optional email allowlist for additional Google users (owner is always admin).
# Uses a custom delimiter (^@^) so the commas inside the value are preserved.
GOOGLE_ALLOWLIST="${GOOGLE_ALLOWLIST:-$LIVE_ALLOWLIST}"
if [ -n "${GOOGLE_ALLOWLIST:-}" ]; then
  echo "==> Setting GOOGLE_ALLOWLIST…"
  gcloud run services update "$SERVICE" --project "$PROJ" --region "$REGION" \
    --update-env-vars "^@^GOOGLE_ALLOWLIST=${GOOGLE_ALLOWLIST}"
fi
# GEMINI_LOCATION is intentionally NOT set -> defaults to "global": the Gemini
# 3.x publisher models are ONLY served from the global Vertex location (regional
# endpoints 404 on them and the app would silently fall back to the local engine).

URL="$(gcloud run services describe "$SERVICE" --project "$PROJ" --region "$REGION" --format='value(status.url)')"
echo ""
echo "✅ [$ENVIRONMENT] deployed: $URL"
echo "   verify:  curl -s $URL/api/ai-status"
