#!/usr/bin/env bash
# Deploy the verifier Worker and prove it against the live chain.
#
# The verifier used to be a Rust service on Render holding a websocket. It is now a
# stateless Cloudflare Worker: every fact comes from HTTPS JSON-RPC, so there is no
# socket to go stale and no cold-start handshake. Needs CLOUDFLARE_API_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/../verifier-worker"

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-d94fc449589da9abe759bdf5df459f5c}"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  CLOUDFLARE_API_TOKEN=$(tr -d '\r\n ' < ~/.hermes/keys/cloudflare-api-key)
  export CLOUDFLARE_API_TOKEN
fi

echo "deploy-verifier: wrangler deploy"
npx --yes wrangler@latest deploy 2>&1 | grep -E "Uploaded|Deployed|workers.dev|Version ID|Error" || true

W="${TWINKEY_VERIFIER_URL:-https://twinkey-verifier.kiter0211.workers.dev}"
echo "deploy-verifier: verifying $W"
fail=0
check() {
  local path="$1" want="$2"
  local code
  code=$(curl -s -o /tmp/tk_w.json -w '%{http_code}' -m 40 "$W$path" || true)
  if [ "$code" = "$want" ]; then
    echo "  $path  HTTP $code  $(head -c 120 /tmp/tk_w.json | tr -d '\n')"
  else
    echo "  $path  HTTP $code (wanted $want)  $(head -c 200 /tmp/tk_w.json | tr -d '\n')"
    fail=1
  fi
}
check /ready 200
check /verify/block/90990 200
check /parity/90995 200
[ "$fail" = 0 ] && echo "deploy-verifier: OK" || { echo "deploy-verifier: FAILED"; exit 1; }
