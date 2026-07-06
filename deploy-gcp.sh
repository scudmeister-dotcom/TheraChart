#!/usr/bin/env bash
# One-shot GCP deploy for TheraChart: wires the already-created Cloud SQL
# instance to Cloud Run, turns on Vertex + STT, and ships the current code.
# Safe to re-run — every step is idempotent. No secrets are printed.
set -euo pipefail

PROJ=therachart-prod
REGION=us-central1
SA=1060950042386-compute@developer.gserviceaccount.com
CONN="$PROJ:$REGION:therachart-db"
SECRET=therachart-db-url

cd "$(dirname "$0")"

echo "==> 1/5  Enabling Secret Manager API (was missing)…"
gcloud services enable secretmanager.googleapis.com --project "$PROJ"

echo "==> 2/5  Setting a fresh password on the 'therachart' DB user…"
DBPASS="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)"
gcloud sql users set-password therachart --instance=therachart-db --project "$PROJ" --password="$DBPASS"

echo "==> 3/5  Storing DATABASE_URL in Secret Manager…"
DBURL="postgresql://therachart:${DBPASS}@/therachart?host=/cloudsql/${CONN}"
if gcloud secrets describe "$SECRET" --project "$PROJ" >/dev/null 2>&1; then
  printf '%s' "$DBURL" | gcloud secrets versions add "$SECRET" --data-file=- --project "$PROJ"
else
  printf '%s' "$DBURL" | gcloud secrets create "$SECRET" --data-file=- --project "$PROJ"
fi
unset DBPASS DBURL

echo "==> 4/5  Granting the runtime service account its roles…"
for R in roles/cloudsql.client roles/aiplatform.user roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJ" \
    --member="serviceAccount:$SA" --role="$R" --condition=None >/dev/null
  echo "    granted $R"
done

echo "==> 5/5  Deploying current code to Cloud Run (Postgres + Vertex + STT)…"
gcloud run deploy therachart --source . --project "$PROJ" --region "$REGION" \
  --allow-unauthenticated --add-cloudsql-instances "$CONN" --max-instances 1 \
  --set-secrets "DATABASE_URL=${SECRET}:latest" \
  --set-env-vars "GCP_PROJECT=${PROJ},STT_LOCATION=${REGION},GEMINI_VERTEX=1,GEMINI_LOCATION=${REGION}"

echo ""
echo "✅ Done. Verify with:"
echo "   curl -s https://therachart-cmcoe52aaa-uc.a.run.app/api/ai-status"
