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
| RPC archival? | **No** — block-0 EVM state queries fail; do not build history-dependent logic on it |

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
