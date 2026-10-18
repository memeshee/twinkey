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
- The RPC is **not archival**; historical state queries fail. Read at head.
