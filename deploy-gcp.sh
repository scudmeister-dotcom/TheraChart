#!/usr/bin/env bash
# One-shot GCP deploy for TheraChart. Ships the current code to Cloud Run with
# Postgres (Cloud SQL) + Vertex Gemini + Cloud STT + file storage wired up.
# Safe to re-run — every step is idempotent. No secrets are printed.
#
# USAGE:
#   ./deploy-gcp.sh            # deploy/refresh the US stack (us-central1) — prod
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
# STT region: follows the deploy region by default. If the Chirp model isn't
# offered in that region, either use the "standard" model in-app, or pin STT to
# a region that has Chirp:   STT_REGION=us-central1 ./deploy-gcp.sh asia
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

echo "==> 6/6  Deploying code to Cloud Run [$SERVICE @ $REGION]…"
gcloud run deploy "$SERVICE" --source . --project "$PROJ" --region "$REGION" \
  --allow-unauthenticated --add-cloudsql-instances "$CONN" --max-instances 1 \
  --set-secrets "DATABASE_URL=${SECRET}:latest" \
  --set-env-vars "GCP_PROJECT=${PROJ},STT_LOCATION=${STT_REGION},GEMINI_VERTEX=1,GCS_BUCKET=${BUCKET}"
# GEMINI_LOCATION is intentionally NOT set -> defaults to "global": the Gemini
# 3.x publisher models are ONLY served from the global Vertex location (regional
# endpoints 404 on them and the app would silently fall back to the local engine).

URL="$(gcloud run services describe "$SERVICE" --project "$PROJ" --region "$REGION" --format='value(status.url)')"
echo ""
echo "✅ [$ENVIRONMENT] deployed: $URL"
echo "   verify:  curl -s $URL/api/ai-status"
