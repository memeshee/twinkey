# Deployment log — Portaldot V3 testnet

Everything below is a real transaction on `PortaldotV3 Test` (chain id `420420777`, runtime
`portaldot-v3` v3002). No local chain, no mocks. Reproduce with `tooling/deploy.mjs` and
`tooling/call.mjs`.

## Accounts

| Role | Value |
|---|---|
| Signer (Substrate) | `5DMLUzwxrQsPwc9dsjz4WUVSy4qryn2xWhtvv4RDkjBko9C7` (sr25519, ss58 42) |
| Mapped EVM address | `0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934` — resolved by `reviveApi.address(pubkey)`, never derived locally |
| Balance at deploy | 499.9 tPOT on the mapped address (`eth_getBalance`), 0.05 tPOT withdrawn for the first call (`balances.Withdraw` event) |

## 1. Contract instantiated by a native origin (no EVM key, no MetaMask)

Command: `node tooling/deploy.mjs` → `revive.instantiateWithCode(0, weight, 1e16, code, 0x, null)`
signed by the sr25519 key above.

| Field | Value |
|---|---|
| Contract address | `0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725` |
| Block hash | `0x175067730ea843b357716e2bea6d64cda976b3ec8c201e35afd82b14e7cfe02f` |
| Deployer (from `revive.Instantiated`) | `0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934` |
| Fee | 8,491,248,056,973 base units (~0.0849 tPOT) |
| Weight used | `refTime 1,539,211,634`, `proofSize 19,007` |
| Deposits held | `revive:CodeUploadDepositReserve` 4.536 tPOT, `revive:StorageDepositReserve` 2.1258 tPOT |
| Code on the EVM side | `eth_getCode` → 687 bytes (`0x60806040…`) |

Contract source: [`contracts/TwinKeyProbe.sol`](../contracts/TwinKeyProbe.sol), compiled with
solc 0.8.37 (optimizer on, 200 runs, `evmVersion: paris`) to plain EVM bytecode — the runtime
accepts EVM bytecode directly (`revive.allowEVMBytecode`), which is what makes the EVM-tooling
story credible.

## 2. Contract called by the same native origin

Command: `node tooling/call.mjs 0x19d5aa…7725 42` → `revive.call(dest, 0, weight, 1e16, calldata)`
with `calldata = 0x55241077…002a` (`setValue(42)`).

| Field | Value |
|---|---|
| Block hash | `0xfd7a38989af1608df763f9138a2b7a457baa2d778e4e334780d67085c8ee8211` |
| Event | `revive.ContractEmitted` — topics `[0xc0e903…0e59, 0xe70fd7e2…d934, 0x…2a]`, i.e. `ValueSet(caller = mapped H160, value = 42, callCount = 1)` |
| Fee | 1,851,306,905,650 base units (~0.00185 tPOT) |
| Storage deposit | 1.15245 tPOT reserved (`revive:StorageDepositReserve`) |

**Read back through the EVM JSON-RPC**, as an unmodified `viem` client would:

```
eth_call read() → 0x
  000000000000000000000000000000000000000000000000000000000000002a   value       = 42
  000000000000000000000000e70fd7e24a9eee0d3a7302866e0e1e9597f4d934   lastCaller  = mapped H160
  0000000000000000000000000000000000000000000000000000000000000001   callCount   = 1
```

That triple is the product's core claim, on chain:

1. the call was signed by an **ss58 sr25519 key** and submitted as a Substrate extrinsic;
2. the contract executed and emitted a real EVM log;
3. the contract recorded `msg.sender` as the account's **mapped H160**;
4. the state it wrote is readable, unchanged, through the **standard EVM JSON-RPC**.

Same account, both runtimes, one signature.

## 3. Notes for anyone building here

- A native-origin call is a **Substrate extrinsic**, so its id is a block/extrinsic hash, not an
  `eth_getTransactionByHash` entry. Tooling that only looks at the eth-rpc side will show "no
  receipt" for a perfectly successful call. TwinKey's verifier reads both sides for this reason.
- `revive.call` takes a **weight limit** (`{refTime, proofSize}`), not a gas limit. Unused weight is
  refunded; the numbers above show what the two operations actually consumed, which is 3–4 orders of
  magnitude below the limit used.
- Storage deposits are real balance reservations on the *caller* (`revive:StorageDepositReserve`),
  so a contract write costs more than the fee suggests. Budget for it in any UI that shows costs.
- The **Substrate** RPC is a full archive: `api.at(blockHash)` returns real per-block state back to
  block 1. The **EVM** RPC prunes state (~256 blocks) — `eth_call` and `eth_getBlockByNumber` fail
  beyond that with `UnknownBlock: State already discarded`, while `eth_getLogs` still spans the full
  chain (but silently omits logs emitted by native-path `revive.call`). So: take history from the
  Substrate RPC and current state from the EVM RPC at `latest`. Never `eth_call` at a historical
  block. Reproductions in [`VERIFIED-FACTS.md`](VERIFIED-FACTS.md).

## 4. Where this runs, and the plan flip

| Piece | Host | Detail |
|---|---|---|
| App | Vercel → <https://twinkey.vercel.app> | git-linked to `memeshee/twinkey` `main`; project **`rootDirectory` must be `app`** or the Git build cannot resolve `@/*` aliases |
| Verifier | Render → <https://twinkey-verifier.onrender.com> | service `srv-dbb1lddg1s2s73duaeog`, rootDir `agent`, native Rust, `RUST_VERSION=1.90.0` |
| Demo signer | Vercel env `PORTALDOT_SECRET_URI` | throwaway 5 tPOT account; the project key is never deployed |

The verifier runs on Render's **free** plan, which sleeps after ~15 min idle. Two scheduled Hermes
cron jobs manage the judged window — both are `no_agent` shell jobs that report their result:

- `79d58f8162f0` — **2026-10-24 12:00 UTC** (check-in): flips the service to **Starter**. No cold
  start, and it hands the workspace's 750 shared free hours back to the other two free services on
  that account (`confidant-demo`, `fieldday`).
- `184771508622` — **2026-11-14 00:00 UTC+7**: returns it to **free**.

While it is on the free plan, job `9f31c3cc865d` pings `/health` every 10 minutes so a judge never
waits out a cold start; it is silent unless the verifier is unhealthy. If you stop needing the demo,
remove all three jobs before the free-hour pool matters again.

### The Render-only failure (2026-10-21), and what removed it

`/verify/block/:n` and `/parity/:n` answered 503 on Render while the *same binary* served the same
blocks from a laptop:

```
at_block(90990): Cannot construct OnlineClientAtBlock: failed to get block hash from node for
block 90990: Custom backend error: The ChainHead V1 RPCs do not support obtaining a block hash
from a number.
```

subxt's default `CombinedBackend` picks the **chainHead** backend as soon as the node lists
`chainHead_v1_*`, and chainHead's `block_number_to_hash` is a hard error — not a fallback. The
choice is made from the method list the node returns *to that host*, so it is not a property of
the source: the archive backend that normally answers the lookup was not usable from that
instance. `/health` was green throughout, because every check it made used either plain
`reqwest` JSON-RPC or `at_latest`, and neither goes near that code path.

Two changes, both in `agent/src/chain.rs`:

- the legacy backend is **pinned** (`LegacyBackend` over wss) instead of autodetected, and the
  choice is reported as `subxt_backend` in `/health`;
- `revive_events` no longer asks subxt to map a number to a hash at all — it resolves
  `chain_getBlockHash(height)` over plain JSON-RPC (the transport already proven to work from that
  host) and hands subxt the hash. `chain_getBlockHash` carries no backend choice, so this is the
  same call everywhere.

`GET /diagnostics` makes the next occurrence debuggable instead of mysterious: it reports the
methods the node advertises to *this* instance, `chain_getBlockHash` for a probe block, and both
shapes of `archive_v1_hashByHeight` — this node accepts a JSON **number** and rejects the spec's
string form with `invalid type: string, expected u64`.

### Pushing does not deploy

The service says `autoDeploy: yes`, but its repo is attached as a plain public URL rather than
through the GitHub App, so **a push starts no build**: commit `149df59` was the only deploy that
ever ran, and the four commits after it sat undeployed behind a healthy `/health`. Use
`tooling/deploy-verifier.sh` — it pushes if needed, triggers the build through the API, waits for
`live`, then calls `/health`, `/verify/block/90990` and `/parity/90995` so a green result means the
running build actually answers.

### The health-check alert emails (2026-10-21)

Render emailed about failed health checks because the instance kept being marked unhealthy:

```
server_failed  reason: {"unhealthy": "HTTP health check failed (timed out after 5 seconds)"}
```

Render's probe budget on `healthCheckPath` is **5 seconds**, and `/health` was making five
sequential calls to two external RPC hosts; healthy it took ~1.2 s, so any upstream hiccup
(or a cold TLS handshake) blew the budget, Render killed and restarted the instance, and each
restart produced an email. `/health` is now I/O-free — it answers from process memory in about a
millisecond — and the upstream checks moved to `/ready`, which queries both endpoints concurrently
under a 6 s ceiling and returns a labeled 503 when one is down. The keep-warm job now pings
`/health` (liveness) and `/ready` (deep) and stays silent unless one of them fails.
