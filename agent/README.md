# TwinKey verifier

Independent HTTP verifier for TwinKey receipts on **Portaldot V3**.

It answers one question a judge can check with `curl`: *did this Solidity contract really run on
Portaldot, and does the state the EVM shows today agree with what the chain recorded?*

```
Substrate archive RPC  ──►  System.Events at block N  ──►  SCALE decode  ──►  what happened
EVM JSON-RPC @ latest  ──►  eth_getCode / eth_call    ──►  what is true now
                                                             │
                                                       verdict + summary
```

## Why two RPCs (this is the whole design)

| Read | Endpoint | Why |
|---|---|---|
| History (`System.Events`, block hashes, `state_call`) | `https://test-node-v3.portaldot.dev` | full **archive** node: `state_getStorage` works at any depth, including block 0 |
| Current state (`eth_getCode`, `eth_call`) | `https://test-evm-rpc-v3.portaldot.dev` | **not** archival: `eth_call` at a historical block fails with `UnknownBlock: State already discarded` after ~256 blocks |

So the service never calls the EVM endpoint with a block tag other than `"latest"`. This is
commented in `src/evm.rs` and `src/main.rs`.

Both endpoints return **HTTP 403 when the `User-Agent` is the literal `Python-urllib/*` string** (a
Cloudflare WAF rule). It is that specific value, not a missing header — `curl`, `node`, Go, empty and
`python-requests` all pass. The shared `reqwest::Client` sets a UA, so the service is unaffected.

## Build

```bash
cd /home/kiter/hackathon/twinkey/agent
cargo build --release
```

Binary: `target/release/twinkey-verifier` (and `target/release/probe`, a small decoder used while
developing — not needed to run the service).

## Run

```bash
./target/release/twinkey-verifier
# twinkey-verifier listening on http://0.0.0.0:8088
```

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8088` | listen port |
| `SUBSTRATE_RPC` | `https://test-node-v3.portaldot.dev` | archive node (HTTP; `wss://` is derived for subxt) |
| `EVM_RPC` | `https://test-evm-rpc-v3.portaldot.dev` | EVM JSON-RPC, always queried at `latest` |
| `TWINKEY_SS58` | `5DMLUzwxrQsPwc9dsjz4WUVSy4qryn2xWhtvv4RDkjBko9C7` | signing account; its H160 comes from `ReviveApi_address` |
| `TX_SCAN_BLOCKS` | `16` | how far back `/verify/tx/:hash` scans for an *extrinsic* hash |

## Endpoints (GET only)

### `GET /health` — liveness, no I/O

```json
{
  "ok": true,
  "service": "twinkey-verifier",
  "version": "0.1.0",
  "uptime_s": 412,
  "subxt_backend": "legacy/WS",
  "substrate_methods": { "count": 135, "has_archive_v1": true, "has_chain_head_v1": true, "has_chain_get_block_hash": true },
  "deep_check": "GET /ready — checks both upstream RPCs (may take 1–2 s)"
}
```

Answered from process memory in microseconds. Render probes this path and kills the instance when it
does not answer within **5 seconds** — an earlier version made five upstream RPC calls here, so a
slow upstream (or just a slow TLS handshake) looked like a dead process and got the service
restarted, with an alert email each time. Liveness must not depend on a third party's latency.

### `GET /ready` — deep readiness

The check that actually matters, for monitoring and for keeping a free instance awake: both
upstream RPCs are queried **concurrently** with a 6 s ceiling, so a hung endpoint returns a labeled
503 quickly instead of parking the connection.

```json
{
  "ok": true,
  "chain": "PortaldotV3 Test",
  "spec_name": "portaldot-v3",
  "spec_version": 3002,
  "head_block": 129384,
  "evm_block": 129384,
  "signer_ss58": "5DMLUzwxrQsPwc9dsjz4WUVSy4qryn2xWhtvv4RDkjBko9C7",
  "subxt_backend": "legacy/WS",
  "read_policy": "history: Substrate archive at block hash; current state: EVM eth_call/eth_getCode at 'latest' only"
}
```

### `GET /diagnostics` — why it works, on this host

The methods the node advertises to *this instance*, `chain_getBlockHash` for a probe block, and
`archive_v1_hashByHeight` in both param shapes (this node accepts a JSON number and rejects the
spec's string form). This exists because the verifier once worked from a laptop and failed on
Render for a reason that was invisible from the outside; see
[`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).

### `GET /verify/block/:number`

Reads `System.Events` **at that block hash** from the archive node, decodes it with the runtime
metadata, keeps every `Revive` event, and then asks the EVM RPC at `latest` about each distinct
contract it saw:

```json
{
  "block_number": 90995,
  "block_hash": "0xfd7a3898…8211",
  "revive_event_count": 1,
  "revive_events": [
    {
      "index": 3,
      "phase": "ApplyExtrinsic(1)",
      "pallet": "Revive",
      "variant": "ContractEmitted",
      "contract": "0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725",
      "data": "0x0000…0001",
      "topics": [
        "0xc0e9036d619701c94569e1462d8120ef4a6d2b15a70d27cc942fd29ae2cc0e59",
        "0x000000000000000000000000e70fd7e24a9eee0d3a7302866e0e1e9597f4d934",
        "0x000000000000000000000000000000000000000000000000000000000000002a"
      ],
      "fields": { "contract": "0x19d5…7725", "data": "0x…01", "topics": ["0xc0e9…0e59", "0x…d934", "0x…002a"] }
    }
  ],
  "current_state": {
    "0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725": {
      "code_len_bytes": 686,
      "has_code": true,
      "read": {
        "ok": true,
        "value": "31337",
        "last_caller": "0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934",
        "call_count": "5",
        "decoded": "(uint256 31337, address 0xe70f…d934, uint256 5)"
      },
      "read_at": "latest"
    }
  },
  "summary": ["…plain English…"]
}
```

`Instantiated` events expose `deployer` and `contract`; `EthExtrinsicRevert` and any future
`Revive` variant are returned with their variant name and raw field bytes.

### `GET /verify/tx/:hash`

Accepts a 32-byte `0x` hash.

* If it is a **block hash** → the full `/verify/block` response plus
  `"resolved": {"kind": "block", "block_number": N}`.
* If it is an **extrinsic hash** → scans the last `TX_SCAN_BLOCKS` blocks (the RPC has no tx index),
  then returns the block that contains it, with `"resolved": {"kind":"extrinsic", …}` and a
  `[extrinsic i]` marker in the summary.
* Otherwise → `404` with a JSON explanation of what was scanned.

Every response, including errors, carries a `summary` array in plain English.

### `GET /parity/:number`

The product verdict. For every `Revive.ContractEmitted` at that block it decodes the topics against
the `TwinKeyProbe` ABI:

| event | topic0 | layout |
|---|---|---|
| `ValueSet(address indexed caller, uint256 indexed value, uint256 callCount)` | `0xc0e9036d…0e59` | topics `[sig, caller, value]`, data = `callCount` |
| `ValueAdded(address indexed caller, uint256 amount, uint256 newValue)` | `0x804c807c…27e1` | topics `[sig, caller]`, data = `[amount, newValue]` |

and asserts:

1. **`contract_has_code`** — the emitting address still has runtime code at `latest`.
2. **`caller_is_mapped_signer`** — the event's caller equals `ReviveApi_address(TWINKEY_SS58)`,
   read from the chain's own runtime API (the mapping is *not* a truncation/hash of the key).
3. **`state_consistent_with_event`** — `read()` at `latest` agrees with the event: `callCount` may
   only grow, and while it is unchanged `value` must equal the emitted value. If a later call
   advanced `callCount`, the response says so in `notes` instead of pretending the value is frozen.

```json
{
  "verdict": true,
  "block_number": 90995,
  "signer": {
    "ss58": "5DMLUzwxrQsPwc9dsjz4WUVSy4qryn2xWhtvv4RDkjBko9C7",
    "h160": "0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934",
    "source": "ReviveApi_address via state_call at latest (the runtime's own mapping)"
  },
  "checks": [
    { "name": "contract_has_code[0x19d5aa10…7725]", "ok": true, "detail": "…" },
    { "name": "caller_is_mapped_signer[0x19d5aa10…7725]", "ok": true, "detail": "…" },
    { "name": "state_consistent_with_event[0x19d5aa10…7725]", "ok": true, "detail": "…" }
  ],
  "events": [ { "event": "ValueSet", "caller": "0xe70f…d934", "value": "42", "call_count": "1" } ],
  "notes": ["state changed after block 90995: callCount 1 -> 5, value 42 -> 31337"]
}
```

## Errors

Every failure is JSON, never a panic:

* `400 bad_request` — malformed block number or hash.
* `404 block_not_found` / `tx_not_found` — the height/hash is not on this chain.
* `503 upstream_rpc_error` — any Substrate or EVM call failed (transport, HTTP status, JSON-RPC
  error, or malformed SCALE), with the endpoint and reason in `detail`.

## Layout

```
src/main.rs    routes, block view, parity checks, summary generation
src/chain.rs   Substrate RPC + subxt event decoding (System.Events at a block hash)
src/evm.rs     EVM JSON-RPC, 'latest' only; eth_getCode, eth_call read()
src/abi.rs     TwinKeyProbe ABI: topic decode, uint256 -> decimal
src/ss58.rs    SS58 decode + blake2b checksum (prefix 42)
src/error.rs   one JSON error type, 503 for upstream failures
src/bin/probe.rs  standalone event dumper used during development
```

Tests: `cargo test` (SS58 checksum, uint256 decimal, ValueSet decode).

## Verified fixtures

```bash
curl -s localhost:8088/verify/block/90990 | jq   # Instantiated by 0xe70f…d934 of 0x19d5…7725
curl -s localhost:8088/verify/block/90995 | jq   # ContractEmitted, topic0 0xc0e9…0e59 (ValueSet)
curl -s localhost:8088/parity/90995      | jq   # verdict + checks
```
