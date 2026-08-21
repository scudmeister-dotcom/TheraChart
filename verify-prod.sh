#!/usr/bin/env bash
# Post-deploy verification for the live service — STRICTLY READ-ONLY.
#
# This is NOT the adversarial probe used in development: that one resets
# passwords and deletes records to prove the tenancy boundary, and must never
# be pointed at production. Everything here is a GET or an unauthenticated
# POST that is expected to be refused. It creates nothing, changes nothing,
# and deletes nothing.
#
#   ./verify-prod.sh                     # checks the default prod URL
#   ./verify-prod.sh https://staging...  # or any other deployment
#
# Exit code is non-zero if any check fails, so it can gate a release.

set -uo pipefail
BASE="${1:-https://therachart-cmcoe52aaa-uc.a.run.app}"

pass=0; fail=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31m✗\033[0m %s\n     %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
body() { curl -s --max-time 20 "$@"; }

echo
echo "Verifying $BASE  (read-only)"
echo

# ---- is it up at all? -------------------------------------------------------
root=$(code "$BASE/")
if [ "$root" = "200" ]; then ok "app root returns 200"
elif [ "$root" = "503" ]; then
  bad "app root returns 503" "Cloud SQL is probably still stopped — start it, then force a fresh revision (see DEPLOY.md)"
  echo; echo "  Stopping here: nothing else can be checked while the service is down."; echo; exit 1
else bad "app root returned $root" "expected 200"; fi

ping=$(body "$BASE/api/ping")
echo "$ping" | grep -q '"ok":true' && ok "/api/ping healthy" || bad "/api/ping unhealthy" "$ping"

# ---- security response headers ---------------------------------------------
# The service sent none of these before 2026-08-21. They are checked here and
# not only in the test suite because they are set by the running revision, and
# a deploy that carried the wrong image would still pass every local test.
hdrs=$(curl -s -D - -o /dev/null --max-time 20 "$BASE/" | tr 'A-Z' 'a-z')
check_hdr() {
  if printf '%s' "$hdrs" | grep -q "$2"; then ok "$1"
  else bad "$1" "no '$2' in the response headers for /"; fi
}
check_hdr "a Content-Security-Policy is sent"        "content-security-policy:"
check_hdr "…and it forbids framing (clickjacking)"  "frame-ancestors 'none'"
check_hdr "…and it forbids inline script"           "script-src 'self'"
check_hdr "MIME sniffing is off"                    "x-content-type-options: nosniff"
check_hdr "the microphone is restricted to this origin" "microphone=(self)"

# ---- the security fixes, as far as they can be seen from outside -----------
# Unauthenticated reads must be refused. Before the tenancy work these were the
# endpoints that handed over every clinic's records.
for path in "/api/state" "/api/rev" "/api/audio?docId=x" "/api/files?key=x"; do
  c=$(code "$BASE$path")
  [ "$c" = "401" ] && ok "unauthenticated $path is refused (401)" \
                   || bad "unauthenticated $path returned $c" "expected 401"
done

for path in "/api/refine" "/api/insights" "/api/extract-doc" "/api/patient-assistant" "/api/state"; do
  c=$(code -X POST -H 'content-type: application/json' -d '{}' "$BASE$path")
  [ "$c" = "401" ] && ok "unauthenticated POST $path is refused (401)" \
                   || bad "unauthenticated POST $path returned $c" "expected 401"
done

# A bad login must not reveal whether the account exists.
lg=$(body -X POST -H 'content-type: application/json' \
     -d '{"email":"nobody@example.invalid","password":"x"}' "$BASE/api/login")
echo "$lg" | grep -qi "incorrect email or password" \
  && ok "a failed login does not disclose whether the account exists" \
  || bad "login error message may enumerate accounts" "$lg"

# The sign-in screen must not publish the staff roster.
boot=$(body "$BASE/api/bootstrap")
if echo "$boot" | grep -q '"testAccounts"' && ! echo "$boot" | grep -qi 'therachart\.demo'; then
  ok "bootstrap exposes no demo logins (production seed)"
elif echo "$boot" | grep -qi 'therachart\.demo'; then
  bad "bootstrap is publishing demo logins and their password" "remove the seeded @therachart.demo accounts before real patients are on this instance"
else
  ok "bootstrap exposes no staff roster"
fi

# Private files must never be served over HTTP.
for path in "/data/therachart.json" "/.secrets/run-live-test.js" "/data/sessions.json" "/../server.js"; do
  c=$(code "$BASE$path")
  [ "$c" = "404" ] && ok "private path $path is not served (404)" \
                   || bad "private path $path returned $c" "expected 404"
done

# ---- configuration sanity ---------------------------------------------------
st=$(body "$BASE/api/ai-status")
echo "$st" | grep -q '"provider":"vertex"' \
  && ok "AI is on Vertex (the BAA path), not a consumer key" \
  || bad "AI is NOT on the Vertex/BAA path" "$(echo "$st" | head -c 200)"
echo "$st" | grep -q '"available":true' \
  && ok "Speech-to-Text is configured" \
  || bad "Speech-to-Text is not configured" "$(echo "$st" | head -c 200)"

echo
if [ "$fail" -gt 0 ]; then
  printf '  \033[31m%d check(s) failed\033[0m, %d passed\n\n' "$fail" "$pass"; exit 1
fi
printf '  \033[32mall %d checks passed\033[0m\n\n' "$pass"
