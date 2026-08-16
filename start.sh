#!/usr/bin/env bash
# Start TheraChart for local development.
#
#   ./start.sh
#
# Brings up the full-feature stack: local Postgres for durable storage, Vertex
# AI for Gemini, and Google Cloud Speech-to-Text. The Cloudflare tunnel runs as
# a background service and picks this up automatically, so the public URL works
# as soon as this is listening.
#
# Cloud SQL is on a cost hold — see DEPLOY.md. This is the local stand-in.

set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8080}"
PUBLIC_URL="https://therachart.testascript.app"

# Show the seeded demo logins on the sign-in screen. This is a LOCAL/demo
# convenience and is off by default everywhere else: /api/bootstrap is
# unauthenticated, so enabling it publishes a working admin password to anyone
# who fetches it. Never set this on a deployment holding real patients.
export THERACHART_DEMO_LOGINS="${THERACHART_DEMO_LOGINS:-1}"
GCLOUD="${GCLOUD:-$HOME/google-cloud-sdk/bin/gcloud}"
[ -x "$GCLOUD" ] || GCLOUD="$(command -v gcloud || true)"

# --- already running? ---
if lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "TheraChart is already running on port $PORT."
  echo "  local:  http://localhost:$PORT"
  echo "  public: $PUBLIC_URL"
  exit 0
fi

# --- Postgres (durable storage) ---
if ! pg_isready -q 2>/dev/null; then
  echo "Starting Postgres…"
  brew services start postgresql@15 >/dev/null
  until pg_isready -q 2>/dev/null; do sleep 1; done
fi
export DATABASE_URL="postgresql://therachart:localdev@localhost:5432/therachart"

# --- Google credentials for Vertex Gemini + Speech-to-Text ---
# GCP_USE_GCLOUD makes the server pull a fresh token from gcloud whenever its
# cache lapses, so a long session never loses AI or dictation. Nothing
# long-lived is written to disk (service-account keys are disabled by org
# policy on this project anyway).
if [ -n "$GCLOUD" ] && "$GCLOUD" auth print-access-token >/dev/null 2>&1; then
  export GCP_PROJECT="therachart-prod"
  export GEMINI_VERTEX=1
  export GCP_USE_GCLOUD=1
  export GCLOUD_PATH="$GCLOUD"
else
  echo "⚠️  Not signed in to gcloud — starting without Vertex AI or Cloud dictation."
  echo "   Run: gcloud auth login"
fi

echo
echo "  local:  http://localhost:$PORT"
echo "  public: $PUBLIC_URL"
echo "  stop:   Ctrl-C"
echo

exec node server.js
