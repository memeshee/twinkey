# Portaldot V3 — verified chain facts

Every line below was produced by a command you can re-run. Snapshot: **2026-10-18** (UTC).
Public endpoints as announced by the Portaldot team:

- Node explorer: <https://node-console.portaldot.dev/>
- Substrate RPC: `wss://test-node-v3.portaldot.dev` (also answers over `https://`)
- EVM RPC: `https://test-evm-rpc-v3.portaldot.dev`
- EVM chain id: `420420777`

## Identity and denominations

| Fact | Value | How to reproduce |
|---|---|---|
| Chain name | `PortaldotV3 Test` | `system_chain` |
| Node / runtime | `PortaldotV3 Node 3.0.0-dev-fddd43141f2`, `portaldot-v3` spec **3002**, tx version 2 | `system_name`, `state_getRuntimeVersion` |
| Native token | `tPOT`, **14 decimals**, SS58 prefix **42** | `system_properties` → `{"ss58Format":42,"tokenDecimals":14,"tokenSymbol":"tPOT"}` |
| EVM-side denomination | 18 decimals (`revive.nativeToEthRatio = 10000`, i.e. 10⁴ between native base units and EVM wei) | observed: 499.9 tPOT native renders as `499900000000000000000` wei |
| EVM contract engine | `pallet-revive` (PolkaVM), **not** Frontier — no `pallet_evm` in the 561,916-byte runtime metadata; `eth_transact`, `instantiate_with_code`, `upload_code`, `map_account` present | `state_getMetadata` + ASCII scan |
| WASM contracts | `pallet-contracts` present, `ContractsApi` advertised | `state_getMetadata`, `state_getRuntimeVersion` |
| Genesis (V3 test) | `0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd` | `chain_getBlockHash(0)` |

## Address mapping — the primitive TwinKey is built on

```
state_call("ReviveApi_address", 0x38eb74935dffbc867c2fbeeac7170156b76f17c6aa1c382535125329ddb42133)
  → 0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934
```

- The input is the 32-byte public key of SS58 account `5DMLUzwxrQsPwc9dsjz4WUVSy4qryn2xWhtvv4RDkjBko9C7`.
- The mapping is **not** a truncation of the key: neither the first 20 nor the last 20 bytes of the
  public key produce `0xe70f…d934`, and neither does `blake2b-256`, `sha256` or `sha3-256` of the
  key at either offset. The runtime API is therefore the only correct source — a client that
  computes the H160 locally will be wrong. TwinKey always asks the chain.
- `ReviveApi_balance` and `ReviveApi_nonce` are callable for the same account (both returned zero
  before the account was funded).

## Liveness at snapshot time

| Fact | Value |
|---|---|
| Substrate best block | ~90,940 (≈6 s blocks) |
| EVM block | ~90,937 |
| Peers | 2 |
| Total issuance | 20,043,388 POT (`Balances.TotalIssuance`, raw `2004338842628218665106`) |
| Transactions in the 40 blocks before the snapshot | **0** — the chain has processed no user traffic |
| Substrate RPC archival? | **Yes** — see below. This row previously said "No"; that was wrong and is corrected with evidence. |
| EVM RPC archival? | **No** — `eth_call` / `eth_getBlockByNumber` at a historical block fail with `UnknownBlock: State already discarded` beyond roughly 256 blocks. `eth_getLogs` does span the full range. |

## State availability — the two RPCs are not the same node

This is the most expensive thing to get wrong on this chain, so it is stated explicitly with the
commands that prove it.

**The Substrate RPC (`test-node-v3.portaldot.dev`) is a full archive node.** Historical state is
readable at any depth, including genesis:

```
# reads real per-block state, and the values differ per block — that is the proof
polkadot-js  api.at(hash).query.system.account("5DM…Bko9C7")
  block  50000 → free 0
  block  90000 → free 50000000000000000
  block  90990 → free 43329708751943027   (the deploy block)
  block  90995 → free 42175407445037377   (the call block)

Balances.TotalIssuance
  block  50000 → 2002666199190143444525
  block 100000 → 2004666338374903816661

Staking.ActiveEra
  block  50000 → { index: 13 }
  block 100000 → { index: 27 }
```

**The EVM RPC (`test-evm-rpc-v3.portaldot.dev`) is a separate endpoint and is not archival for
state.** `eth_call` at block `head-256` succeeds; at `head-300` it fails:

```
{"code":-32000,"message":"Cannot construct OnlineClientAtBlock: failed to obtain spec version …
  UnknownBlock: State already discarded for 0xfd7a3898… (4003)"}
```

`eth_getLogs` is the exception — it answers across the whole range.

**Consequence for anything built here:** read *history* from the Substrate event stream, read
*current state* from the EVM RPC at `latest`, and never call `eth_call` at an old block number.
This is why TwinKey's verifier and its app both scan Substrate events.

## The EVM log index is incomplete for native-path calls

`eth_getLogs` on the EVM endpoint does not return logs emitted by a native-origin `revive.call`.
Verified against our own contract, which emitted at blocks 90995 and 102680:

```
eth_getLogs {address: 0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725, fromBlock: 0x0, toBlock: latest}
  → []
eth_getLogs {fromBlock: 0x0, toBlock: latest}   # whole chain
  → 23 logs, none of them ours
```

The same logs are present in the Substrate event stream at those blocks. So on this chain an EVM
log written by a native-path call is invisible to every consumer of `eth_getLogs` — including
indexers. TwinKey's provider merges its own submitted receipts into `eth_getLogs` results and
serves the decoded log from there.

## Test funds sent to an EOA are stranded — evidence

FINDINGS.md §1 describes funding a test EOA (`0x7FCC…16f3`, 20 tPOT) and finding the EVM write path
rejects every transaction. Re-checked 2026-10-19:

```
eth_getBalance(0x7FCC2Fc227f16220E3c0FAa63337551234de16f3) → 19.9 tPOT      # still there
native account 5ExGbSUEjj29Mvtt7BK5o3xZExUbbJsn2Xs2oqA8rmiL2ig8
  free  → 2000000000000000 (20.000000 tPOT)
  nonce → 0
revive.originalAccount(0x7FCC…) → (empty)
```

The balance sits in a native account whose key nobody holds (it is derived from the H160), while the
H160 can only spend through the EVM write path, which is broken. `revive.originalAccount` being
empty is the on-chain statement that no mapping lets the native side act for that address. The funds
are not recoverable by either side today. Keep test funds in a native account you hold the key to.

## Two traps that will cost you an hour

**`Python-urllib` as a User-Agent gets a 403 from both endpoints** (Cloudflare WAF rule). It is the
UA string, not the absence of one — every other value passes:

```
Python-urllib/3.14      -> 403
python-requests/2.32.3  -> 200
Go-http-client/2.0      -> 200
node                    -> 200
curl/8.5.0              -> 200
Mozilla/5.0             -> 200
<empty>                 -> 200
```

Scripts using bare `urllib.request` must set a header. `curl` and `python-requests` are unaffected.

**`subxt` (Rust) cannot open the HTTPS endpoint** — `OnlineClient::from_insecure_url("https://…")`
fails with ``` `https` not supported ```. It speaks ws/wss only, so a Rust client either connects
`wss://test-node-v3.portaldot.dev` or does plain `reqwest` JSON-RPC against the HTTPS URL. TwinKey's
verifier does both: subxt over wss for `System.Events`, raw JSON-RPC over HTTPS for the rest.

## Explorer reality

`node-console.portaldot.dev` is a polkadot.js-apps UI, and by default it points at a *different*
network (spec 3001, block ≫ 600k) with its recent-blocks and recent-events panels empty. There is
**no EVM explorer** for `420420777`. This is why TwinKey's Rust verifier exposes a human-readable
`/verify/:tx` view: it is the only readable proof surface for an EVM-side transaction today.

## Funding

There is no public faucet. `faucet.portaldot.dev` and every `*-faucet-*` guess do not resolve;
`potkit`'s `faucet` command signs from the local dev key `dev::alice()`, i.e. it only works against
a chain you run yourself. Testnet tPOT is disbursed by the team to the wallet address given at
registration. In this project's case the registered account
`5DMLUzwxrQsPwc9dsjz4WUVSy4qryn2xWhtvv4RDkjBko9C7` was funded and its mapped EVM address
`0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934` read **499.9 tPOT** (`eth_getBalance`) on
2026-10-18T23:30Z.

Note for anyone reproducing this: a **native** (`SS58`) address is what receives the disbursement.
Sending native tPOT straight to an `H160` is not the same operation; read the funds through the
mapping, and move them with a signed call.

## Local development chain, and its limits

`github.com/portaldotVolunteer/Portaldot-node` publishes tarballs. The `portaldot_dev` binary in
`portaldot-testnet-ubuntu.tar.gz` (29.6 MB) reports **version 2.0.0 / native runtime
`portaldot-1002`** — the V2 generation, i.e. **no `pallet-revive`, no EVM**. It is useful for ink!
work and for exercising `pallet-contracts`, but it **cannot** be used to develop or test the V3
EVM path. No V3 node binary or V3 runtime source is published.

Consequence for this project: the V3 EVM path is developed against the live testnet
(read paths, estimation, runtime API) and proved with real transactions there, not against a local
chain. That is a constraint the whole field shares — and the reason the on-chain evidence produced
here is worth something.
