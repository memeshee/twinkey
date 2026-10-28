# Build log

Commands actually run, with the output that matters. Anything not reproducible is not in here.

## 2026-10-19 — provider shim, app, corrected pruning facts

### The provider works end to end

`app/scripts/e2e-provider.ts` drives the EIP-1193 provider the way `viem` would: handshake →
`eth_call` → `eth_estimateGas` → `eth_sendTransaction` → `eth_getTransactionReceipt` → `eth_getLogs`.

```
$ cd app && npx tsx scripts/e2e-provider.ts 2077
signer ss58 : 5DMLUzwxrQsPwc9dsjz4WUVSy4qryn2xWhtvv4RDkjBko9C7
contract    : 0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725
[1] PASS  eth_chainId — 0x190f1ca9
    PASS  eth_requestAccounts returns the mapped H160 — 0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934
[2] PASS  lastCaller is the mapped address of the ss58 signer
[3] TwinKey (dry-run) : 50604168      EVM RPC (raw) : 417905553159   (8258x larger)
    PASS  TwinKey estimate is the real execution cost
[4] tx hash 0x6aac8a660b307b6bb09dab690f4d692922804e6aa374f4d999c6b4f91da534f8   8.5 s
[5] PASS  receipt exists — status 0x1     block 0x1913c
        log: ValueSet({caller: 0xE70F…4d934, value: 2077, callCount: 4})
[6] value 2026 -> 2077, callCount 3 -> 4
[7] 1 log(s) in block, 1 decoded
RESULT: 12/12 checks passed
```

### The app serves real chain state over HTTP

```
$ curl -s localhost:3000/api/state
{"chain":{"name":"PortaldotV3 Test","spec":"portaldot-v3","specVersion":3002,"head":102798,…},
 "identity":{"ss58":"5DMLUzwxrQsPwc9dsjz4WUVSy4qryn2xWhtvv4RDkjBko9C7",
             "h160":"0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934","nativeFreeFormatted":"401.6862"},
 "contract":{"address":"0x19d5aa…7725","codeBytes":686,
             "state":{"value":"2077","lastCaller":"0xe70f…d934","callCount":"4"}},
 "demoSigning":true}

$ curl -s "localhost:3000/api/events?lookback=300"
{"scanned":301,"candidateBlocks":11,"events":[
  {"blockNumber":102680,"kind":"ContractEmitted","contract":"0x19d5aa…7725",
   "parsed":{"eventName":"ValueSet","args":{"caller":"0xE70F…4d934","value":"2026","callCount":"3"}}},
  {"blockNumber":102688,"kind":"Instantiated","deployer":"0x1807dbe0…8547","contract":"0xdf8567f1…c07f"},
  {"blockNumber":102716,…}]}                     # 6.7 s for 300 blocks

$ curl -sX POST localhost:3000/api/demo-write -d '{"value":31337,"action":"set"}'
{"ok":true,"txHash":"0x8a13b582f35c122ba3138a93bddde7c210c0751c520610c2be9070ab6af3942a",
 "receipt":{"status":"0x1","blockNumber":"0x19193","logs":[{"parsed":{
   "eventName":"ValueSet","args":{"caller":"0xE70F…4d934","value":"31337","callCount":"5"}}}]},
 "elapsedMs":7433}
```

### Corrections made to earlier notes

- `docs/VERIFIED-FACTS.md` said the node is not archival. Wrong for the Substrate RPC: `api.at()` reads
  real per-block state at block 1, 1000, 50000 and 90995, and `Balances.TotalIssuance` differs per
  block, which a pruned node could not produce. Only the EVM RPC prunes state (~256 blocks).
- The comparable project `youthisguy/portalIndex` is built on the same wrong premise — its README says
  history "cannot be backfilled from it" and its index starts at block 92322. Its own earliest EVM log
  is at 91528 and blocks 1–92321 are missing even though all of it is readable today.

## Deployment

```
browser ──▶ https://twinkey.vercel.app            Next.js app (Vercel, rootDirectory=app)
                │
                ├── /api/state   ──▶ Substrate RPC (identity, head) + EVM RPC (contract state)
                ├── /api/events  ──▶ Substrate System.Events scan, SCAN blocks cached
                ├── /api/demo-write ─▶ revive.call signed by the throwaway demo account
                └── /api/parity  ──▶ https://twinkey-verifier.onrender.com   (Rust, subxt)
```

| Piece | Where | Notes |
|---|---|---|
| app | Vercel, git-linked to `memeshee/twinkey` main | `rootDirectory` **must** be `app` or the Git build fails to resolve `@/*` aliases |
| verifier | Render, `srv-dbb1lddg1s2s73duaeog`, rootDir `agent` | native Rust runtime, free plan, `RUST_VERSION=1.90.0`, cold start ~30–60 s |
| demo signer | env `PORTALDOT_SECRET_URI` on Vercel | separate 5 tPOT throwaway account; the project key is never deployed |

The Vercel failure that looked like "missing module `@/lib/twinkey/extension`" was a project-config
problem: the file was committed, but with no `rootDirectory` the Git build ran `next build` from the
repo root, where `app/tsconfig.json`'s `"@/*": ["./*"]` resolves against the wrong base. Webpack
reports only the first unresolved specifier. Setting `rootDirectory: "app"` fixed it; a build
triggered straight from GitHub then returned READY.

Public proof, checked from outside this machine:

```
$ curl https://twinkey-verifier.onrender.com/verify/block/90990
  event: Instantiated deployer 0xe70fd7e2…d934 contract 0x19d5aa10…7725
  current EVM state: read() = (value=31337, lastCaller=0xfd2d914e…62e7, callCount=8)

$ curl https://twinkey.vercel.app/api/parity?block=90995
  available: True   verifier: https://twinkey-verifier.onrender.com   verdict: True
  ok  contract_has_code · ok  caller_is_mapped_signer · ok  state_consistent_with_event
```

## 2026-10-21 — the Render-only 503

The first deployment's public proof above was collected from a laptop and did not hold on the
host. `/verify/block/90990` and `/parity/90995` returned 503 on `twinkey-verifier.onrender.com`
with `The ChainHead V1 RPCs do not support obtaining a block hash from a number`, while the same
binary answered correctly from this machine — the verifier's history path asked subxt to turn a
block number into a hash, and which backend does that is decided from the node's method list *as
seen by that instance*. Fixed by pinning `LegacyBackend` and resolving `chain_getBlockHash`
ourselves; `/diagnostics` added so the next such difference is visible. Details in
[DEPLOYMENT.md](DEPLOYMENT.md#the-render-only-failure-2026-10-21-and-what-removed-it).

## 2026-10-28 — reliability, a call surface, a token, a JSON-RPC endpoint

Everything below was measured against the live chain and the deployed hosts today.

### Three live failures, found by probing the deployment rather than trusting it

- `/api/state` answered `{"error":"WebSocket is not connected …"}`: the memoised `ApiPromise`
  could be a socket the node had already closed, and nothing checked `isConnected`.
- `/api/demo-write` returned `FUNCTION_INVOCATION_TIMEOUT` **after the write had landed**
  (`callCount` went 9 → 11 across two POSTs). A judge would have read "failed" about a
  successful transaction.
- `/api/parity` and the verifier's own `/verify/block/90990` returned 503 for days with
  `The background task closed connection closed; restart required`, while `/health` kept
  answering from memory. The Rust process held one `OnlineClient` for its whole life.

Fixes: `getApi` checks `isConnected` and rebuilds; `withApi` retries once behind a fresh
connection; every upstream call runs under a deadline; the verifier's client lives in a slot
that rebuilds every 240 s and once per error, with `client.age_s` / `client.rebuilds` exposed
in `/health` and `/ready`. `/api/health` reports each upstream with live latency, and a write
whose receipt is slow returns 202 + the hash instead of 500.

### The call surface stopped being a demo of one function

`/api/call`, `/api/read`, `/api/estimate` take any address and any calldata; the new `CallPane`
takes any JSON ABI. Measured through it:

```
$ curl -sX POST localhost:3000/api/call -H 'content-type: application/json' \
    -d '{"to":"0x19d5aa…7725","data":"0x55241077…1092"}'          # setValue(4242)
tx hash 0x6bcd0dfa1b1e0b25a5b60a9e5b68e058c6baae8c63e3ef84635626043d5efd84
block   0x377cb (227275)   log ValueSet(caller=0xfd2d…62e7, value=4242, callCount=12)
```

```
$ curl -sX POST localhost:3000/api/estimate … setValue(4242)
evm_estimate     570540468341
runtime_dry_run  gasConsumed 50604168 · weightRequired {refTime 506041677, proofSize 31937}
ratio            11274×        verdict: do not trust eth_estimateGas on this chain
```

### An ERC-20 written by the ss58 key

`tooling/deploy-token.mjs` compiles `contracts/TwinKeyToken.sol` and dispatches
`revive.instantiate_with_code` signed by `5DMLUzwx…Bko9C7`. Two runtime traps cost an hour and
are now documented in `/pitfalls`:

- EVM constructor input must be **inside the code blob**; a non-empty `data` fails with
  `revive.EvmConstructorNonEmptyData`.
- `@polkadot/api`'s `reviveApi.instantiate` wants `code` as the `ContractCode` enum, i.e.
  `{ Upload: codeHex }`, not raw bytes, and takes **7** arguments (salt included).

```
contract     0x06f6e882ada6cd5cab74214ad90c3bd1b070e4e9
deploy tx    0x0af3d62c95eec4cf4b2e7a292adc8a8db2009a0aaf92db620b43028184de7ba9
block        0x35ef90df…733e2c
owner()      0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934  (the ss58 account's mapped H160)
totalSupply  1000000000000000000000000  · decimals 18 · code 1863 bytes
```

`tooling/token-transfer.mjs` then moved 5,000 TKT to the demo account
(`0x65ea6059…7cbe3`, `Transfer(0xe70f…d934 → 0xfd2d…62e7, 5000e18)`).

### A JSON-RPC endpoint whose writes are sr25519 extrinsics

`/api/rpc` forwards reads to the EVM node and signs writes with the demo key, so **ordinary
viem code works against a URL** — that is `/viem`, running in a browser with no extension:

```
eth_sendTransaction → 0x2485483de2bf58b4ecde553a32f2f60bf3b2762b20698ebb6cd6bfb9526f5a77
eth_getTransactionReceipt → block 230867, status 0x1, 1 log,
  topic0 0xddf252ad… (Transfer) value 2e18
  source: "substrate archive (extrinsic hash resolved by scanning blocks)"
```

The receipt is the interesting part: the hash is an **extrinsic** hash the EVM node has never
seen, and the write may have been handled by a different lambda. `resolveExtrinsic()` in
`lib/twinkey/demo.ts` scans recent blocks for it and rebuilds an EVM-shaped receipt from
`revive.ContractEmitted`, so `waitForTransactionReceipt` works statelessly.

### Deploying the app, correctly

Both CLI modes fail, for different reasons:

- from inside `app/`: `[NEXT_NO_VERSION]` — the project has `rootDirectory = app`, so the CLI
  uploads `app/` as the root *and* Vercel applies the setting, putting `package.json` one level
  too deep;
- from the repo root: `File size limit exceeded (100 MB)` — the workspace contains
  `agent/target`, which is 2.7 GB.

The project is git-linked, so **pushing `main` is the deploy**. `tooling/deploy-app.sh` pushes,
then polls `/api/health` until the live build reports `VERCEL_GIT_COMMIT_SHA == HEAD`, then checks
`/`, `/viem`, `/pitfalls`, `/traps.json`, `/api/read`, `/api/estimate`, `/api/health` and the
verifier — and fails the run if any of them is not green. A green build is not proof; a commit sha
and a 200 are. `.vercelignore` exists so a CLI deploy cannot try to upload build artefacts.

While wiring that up, `/api/health` was caught reporting a healthy chain as degraded on the first
request after every deploy: the substrate check went through the cold websocket (handshake + 2 MB
metadata, >14 s). It now asks `chain_getHeader` over plain JSON-RPC (~300 ms) and reports the
shared socket's age separately.

### The viem claim, checked against production

`app/scripts/viem-prod-check.ts` runs the same client code the `/viem` page runs, pointed at the
deployed endpoint:

```
$ npx tsx scripts/viem-prod-check.ts
rpc        https://twinkey.vercel.app/api/rpc
account    0xFd2d914Eefc568C86F907E29E02dbd2C51C462e7
token      TKT at 0x06f6e882ada6cd5cab74214ad90c3bd1b070e4e9
balance    4998
tx hash    0x995c7ee1134f5dfb896536e5641fb4b681ea8b6a22aad94f0d8317704d80df4f
block      231193 status success logs 1
balance    4998 -> 4997
transfer   0x06f6e882…e4e9 value 1
RESULT     PASS — ordinary viem settled a write on Portaldot
```

`app/scripts/e2e-provider.ts` still passes 12/12 against the live chain after the reconnect work
(`ValueSet` decoded from the receipt, `callCount` incremented). Note its "value updated" check
compares against the value it wrote last run, so writing the same number twice reports one failure
that is a test artifact, not a chain failure.

Also fixed after watching the deployed host: `/api/health` called the chain degraded when the EVM
endpoint took >10 s on a cold lambda, and `/api/receipt` returned an empty body because the
hash scan was 240 serial RPCs. The probe now retries once, and the scan reads blocks 24 at a time.
