#!/usr/bin/env bash
# Ship the Next.js app to Fly and prove the live build is the one you pushed.
#
# History that shaped this script, so it does not get re-learned:
#
#  - Vercel's free tier could not carry the app: every cold invocation of a route that touches
#    `@polkadot/api` pays ~2.3 s of CPU just to load the WASM crypto, and Active CPU is the metered
#    resource. The project was deleted.
#  - Render's free plan hosted it unchanged but sleeps after 15 min idle, and the wake cost ~30 s.
#  - Fly runs the process in a container and bills only while a request needs it
#    (`auto_stop_machines = "stop"`, `min_machines_running = 0`); the wake is a couple of seconds.
#
# The deploy is not the proof. The proof is the commit sha the live process reports plus a 200 on the
# routes a judge touches, which is what `verify()` below asks for.
#
#   ./tooling/deploy-app.sh            # push, deploy, wait for that commit to be live, verify
#   ./tooling/deploy-app.sh --verify   # verify whatever is live right now
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

APP_NAME="${TWINKEY_FLY_APP:-twinkey}"
APP_URL="${TWINKEY_APP_URL:-https://${APP_NAME}.fly.dev}"
VERIFY_URL="${TWINKEY_VERIFIER_URL:-https://twinkey-verifier.kiter0211.workers.dev}"
FLYCTL="${FLYCTL:-$HOME/.fly/bin/flyctl}"

health() { curl -s -m 120 "$APP_URL/api/health"; }

# A stopped machine answers the first request only after it boots; retry once so a cold start reads
# as a cold start and not as a dead deployment.
wake() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 120 "$APP_URL/api/ping" || echo 000)
  echo "deploy-app: /api/ping -> $code (a stopped machine boots here)"
}

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

  curl -s -m 60 -X POST "$APP_URL/api/read" -H 'content-type: application/json' \
    -d '{"to":"0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725","data":"0x57de26a4"}' |
    python3 -c 'import sys,json; d=json.load(sys.stdin); print("  /api/read         ok=%s result=%s" % (d.get("ok"), (d.get("result") or "")[:18]))' || ok=1

  curl -s -m 150 -X POST "$APP_URL/api/estimate" -H 'content-type: application/json' \
    -d '{"to":"0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725","data":"0x552410770000000000000000000000000000000000000000000000000000000000001092"}' |
    python3 -c 'import sys,json; d=json.load(sys.stdin); print("  /api/estimate     ratio=%s" % d.get("ratio_evm_over_runtime"))' || ok=1

  for path in / /viem /wagmi /pitfalls /traps.json; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 90 "$APP_URL$path") || code=000
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
echo "deploy-app: deploying $short to $APP_NAME (remote builder)"
# The commit sha is a secret so the running process can report it; staged first so the deploy applies it.
"$FLYCTL" secrets set GIT_SHA="$want" --app "$APP_NAME" --stage >/dev/null || exit 1
"$FLYCTL" deploy --remote-only --app "$APP_NAME" --no-cache || exit 1

echo "deploy-app: waiting for $short to answer"
live=""
for i in $(seq 1 20); do
  live=$(health | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("git_sha_short") or "")
except Exception: print("")' 2>/dev/null)
  if [ "$live" = "$short" ]; then
    echo "deploy-app: live build is $short (after ~$((i * 10))s)"
    verify
    exit $?
  fi
  printf '.'
  sleep 10
done

echo
echo "deploy-app: timed out waiting for $short to go live (last seen: ${live:-none})"
echo "            check $("$FLYCTL" status --app "$APP_NAME" 2>&1 | head -5)"
exit 1
