#!/usr/bin/env bash
# Push TwinKey and make the Render verifier actually build the result.
#
# Why this exists: service srv-dbb1lddg1s2s73duaeog has `autoDeploy: yes`, but the
# repo is attached as a plain public URL (no GitHub App), so a push starts no
# build — four commits once sat undeployed behind a perfectly green /health,
# which is why the live verifier kept failing on code that was already fixed here.
# This script pushes, triggers the deploy through the API, waits for a terminal
# state, and then proves the running build works by calling the endpoints.
#
#   ./tooling/deploy-verifier.sh              # push (if needed), deploy, verify
#   ./tooling/deploy-verifier.sh --no-push    # deploy the commit already on main
set -uo pipefail

SID="${TWINKEY_RENDER_SERVICE:-srv-dbb1lddg1s2s73duaeog}"
BASE="${TWINKEY_VERIFIER_URL:-https://twinkey-verifier.onrender.com}"
API="https://api.render.com/v1/services/$SID"
KEY="${RENDER_API_KEY:-$(cat "$HOME/.hermes/keys/render-api-key" 2>/dev/null)}"
PUSH=1
[ "${1:-}" = "--no-push" ] && PUSH=0

[ -z "$KEY" ] && { echo "deploy-verifier: no Render API key (RENDER_API_KEY or ~/.hermes/keys/render-api-key)"; exit 1; }
cd "$(git rev-parse --show-toplevel)" || exit 1

want=$(git rev-parse HEAD)
have=$(git ls-remote origin -h refs/heads/main | cut -f1)
if [ "$have" != "$want" ]; then
  if [ "$PUSH" = "0" ]; then
    echo "deploy-verifier: origin/main ($have) is not HEAD ($want) and --no-push was given"
    exit 1
  fi
  echo "deploy-verifier: pushing $want -> origin/main"
  git push origin main || exit 1
fi

echo "deploy-verifier: triggering a build of $(git log --oneline -1)"
code=$(curl -sS -m 60 -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"clearCache":"do_not_clear"}' "$API/deploys")
case "$code" in
  200|201|202) : ;;
  *) echo "deploy-verifier: deploy trigger FAILED (HTTP $code)"; exit 1 ;;
esac

# Poll the newest deploy until it reaches a terminal state. Free-tier Rust builds
# take a couple of minutes; give it 20 before giving up.
for _ in $(seq 1 40); do
  line=$(curl -s -m 60 -H "Authorization: Bearer $KEY" "$API/deploys?limit=1" |
    python3 -c 'import sys,json; d=json.load(sys.stdin)[0]["deploy"]; print(d["id"], d["status"], (d.get("commit") or {}).get("id",""))')
  set -- $line
  case "$2" in
    live)      echo "deploy-verifier: LIVE $1 ($3)"; break ;;
    build_failed|update_failed|canceled|deactivated)
               echo "deploy-verifier: FAILED $1 status=$2 commit=$3"; exit 1 ;;
    *)         printf '.' ;;
  esac
  sleep 30
done
[ "${2:-}" = "live" ] || { echo; echo "deploy-verifier: timed out waiting for a live deploy (last status: ${2:-none})"; exit 1; }

sleep 3
echo "deploy-verifier: backend + endpoints"
curl -s -m 120 "$BASE/health" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("  /health      ok=%s backend=%s head=%s" % (d.get("ok"), d.get("subxt_backend"), d.get("head_block")))' || exit 1
curl -s -m 150 "$BASE/verify/block/90990" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("  /verify/block ok=%s events=%d %s" % (d.get("ok"), len(d.get("revive_events") or []), (d.get("error") or "")))' || exit 1
curl -s -m 150 "$BASE/parity/90995" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("  /parity/90995 verdict=%s checks=%s" % (d.get("verdict"), [(c["name"], c["ok"]) for c in d.get("checks") or []]))' || exit 1
