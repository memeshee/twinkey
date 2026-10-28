#!/usr/bin/env bash
# Deploy the Next.js app to Vercel and prove the result on the live URL.
#
# Why this exists: the Vercel project has `rootDirectory = app` (required — without
# it the git build resolves `@/*` against the repo root and fails on a missing
# module). Running `vercel deploy` from inside app/ makes the CLI upload app/ as the
# project root *and* have Vercel apply rootDirectory, so package.json ends up one
# level too deep and the build dies with:
#
#   Error: [NEXT_NO_VERSION] No Next.js version detected
#
# Deploying from the repository root is the only form that works. This script does
# that, then checks the routes a judge actually touches — build green is not proof.
#
#   ./tooling/deploy-app.sh            # deploy, then verify
#   ./tooling/deploy-app.sh --verify   # verify the current production only
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

APP_URL="${TWINKEY_APP_URL:-https://twinkey.vercel.app}"
VERIFY_URL="${TWINKEY_VERIFIER_URL:-https://twinkey-verifier.onrender.com}"

verify() {
  echo "deploy-app: verifying $APP_URL"
  local ok=0

  code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 "$APP_URL/") || code=000
  echo "  /                 HTTP $code"; [ "$code" = "200" ] || ok=1

  curl -s -m 60 "$APP_URL/api/health" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("  /api/health       ok=%s degraded=%s head=%s verifier=%s" % (
    d.get("ok"), d.get("degraded"),
    (d.get("substrate") or {}).get("head"),
    (d.get("checks") or {}).get("verifier", {}).get("ok")))
' || ok=1

  curl -s -m 40 -X POST "$APP_URL/api/read" -H 'content-type: application/json' \
    -d '{"to":"0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725","data":"0x57de26a4"}' |
    python3 -c 'import sys,json; d=json.load(sys.stdin); print("  /api/read         ok=%s result=%s" % (d.get("ok"), (d.get("result") or "")[:18]))' || ok=1

  curl -s -m 90 -X POST "$APP_URL/api/estimate" -H 'content-type: application/json' \
    -d '{"to":"0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725","data":"0x552410770000000000000000000000000000000000000000000000000000000000001092"}' |
    python3 -c 'import sys,json; d=json.load(sys.stdin); print("  /api/estimate     ratio=%s verdict=%s" % (d.get("ratio_evm_over_runtime"), (d.get("verdict") or "")[:40]))' || ok=1

  for path in /viem /pitfalls /traps.json; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 45 "$APP_URL$path") || code=000
    echo "  $path$(printf '%*s' $((18 - ${#path})) '')HTTP $code"; [ "$code" = "200" ] || ok=1
  done

  curl -s -m 120 "$VERIFY_URL/ready" |
    python3 -c 'import sys,json; d=json.load(sys.stdin); print("  verifier /ready   ok=%s head=%s client_age=%ss rebuilds=%s" % (d.get("ok"), d.get("head_block"), d.get("client_age_s"), d.get("client_rebuilds")))' || ok=1

  return $ok
}

if [ "${1:-}" = "--verify" ]; then
  verify; exit $?
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "deploy-app: uncommitted changes — commit first so the live build matches a commit"
  git status --short
  exit 1
fi

echo "deploy-app: deploying $(git log --oneline -1) from $(pwd) (rootDirectory=app)"
npx vercel deploy --prod --force --yes 2>&1 | grep -vE 'Uploading|npm notice' | tail -8 || exit 1

# The alias can take a few seconds to point at the new build.
sleep 8
verify
