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
