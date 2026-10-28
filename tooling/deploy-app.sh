#!/usr/bin/env bash
# Ship the Next.js app and prove the live build is the one you pushed.
#
# Two ways to break this, both hit for real:
#
#  1. `vercel deploy` from inside app/ fails with [NEXT_NO_VERSION]: the project has
#     rootDirectory = app, so the CLI uploads app/ as the root AND Vercel applies the
#     setting — package.json ends up one level too deep.
#  2. `vercel deploy` from the repo root uploads the workspace: agent/target alone is
#     2.7 GB, and the CLI aborts at "File size limit exceeded (100 MB)".
#
# So this does not use the CLI. The project is git-linked: pushing main starts the
# build. This script pushes, waits for the deployment to report the commit it built
# (the app exposes VERCEL_GIT_COMMIT_SHA on /api/health), then checks the routes a
# judge actually touches. A green build is not proof; a commit sha and a 200 are.
#
#   ./tooling/deploy-app.sh            # push if needed, wait for that build, verify
#   ./tooling/deploy-app.sh --verify   # verify whatever is live right now
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

APP_URL="${TWINKEY_APP_URL:-https://twinkey.vercel.app}"
VERIFY_URL="${TWINKEY_VERIFIER_URL:-https://twinkey-verifier.onrender.com}"

health() { curl -s -m 90 "$APP_URL/api/health"; }

verify() {
  echo "deploy-app: verifying $APP_URL"
  local ok=0

  health | python3 -c '
import sys, json
d = json.load(sys.stdin)
c = d.get("checks") or {}
bad = []
print("  /api/health       ok=%s degraded=%s head=%s git=%s" % (
    d.get("ok"), d.get("degraded"),
    (d.get("substrate") or {}).get("head"), d.get("git_sha_short")))
for name in ("substrate", "evm", "verifier"):
    chk = c.get(name) or {}
    if not chk.get("ok"):
        bad.append(name)
        print("  !! %s failing: %s" % (name, chk.get("detail") or "no detail"))
sys.exit(1 if bad else 0)
' || ok=1

  curl -s -m 40 -X POST "$APP_URL/api/read" -H 'content-type: application/json' \
    -d '{"to":"0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725","data":"0x57de26a4"}' |
    python3 -c 'import sys,json; d=json.load(sys.stdin); print("  /api/read         ok=%s result=%s" % (d.get("ok"), (d.get("result") or "")[:18]))' || ok=1

  curl -s -m 120 -X POST "$APP_URL/api/estimate" -H 'content-type: application/json' \
    -d '{"to":"0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725","data":"0x552410770000000000000000000000000000000000000000000000000000000000001092"}' |
    python3 -c 'import sys,json; d=json.load(sys.stdin); print("  /api/estimate     ratio=%s" % d.get("ratio_evm_over_runtime"))' || ok=1

  for path in / /viem /pitfalls /traps.json; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 60 "$APP_URL$path") || code=000
    printf "  %-17s HTTP %s\n" "$path" "$code"
    [ "$code" = "200" ] || ok=1
  done

  curl -s -m 150 "$VERIFY_URL/ready" |
    python3 -c 'import sys,json; d=json.load(sys.stdin); print("  verifier /ready   ok=%s head=%s age=%ss rebuilds=%s" % (d.get("ok"), d.get("head_block"), d.get("client_age_s"), d.get("client_rebuilds")))' || ok=1

  if [ "$ok" = "0" ]; then echo "deploy-app: ALL GREEN"; else echo "deploy-app: FAILURES ABOVE"; fi
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

want=$(git rev-parse HEAD)
have=$(git ls-remote origin -h refs/heads/main 2>/dev/null | cut -f1)
if [ "$have" != "$want" ]; then
  echo "deploy-app: pushing $(git log --oneline -1)"
  git push origin main || exit 1
else
  echo "deploy-app: origin/main already at $(git log --oneline -1)"
fi

short=$(echo "$want" | cut -c1-7)
echo "deploy-app: waiting for a deployment of $short (Vercel builds on push)"
live=""
for i in $(seq 1 40); do
  live=$(health | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("git_sha_short") or "")
except Exception: print("")' 2>/dev/null)
  if [ "$live" = "$short" ]; then
    echo "deploy-app: live build is $short (after ~$((i * 15))s)"
    sleep 3
    verify
    exit $?
  fi
  printf '.'
  sleep 15
done

echo
echo "deploy-app: timed out waiting for $short to go live (last seen: ${live:-none})"
echo "            check https://vercel.com/memeshe-s-projects/twinkey/deployments"
exit 1
