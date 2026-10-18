# Findings on the PortaldotV3 Testnet

Reproduction notes for the two things that decide how anything gets built here. Both were produced
against the live testnet on 2026-10-18/19 (UTC) and are reproducible with the commands shown.

Checks performed against the official guide (`ItsCogumellum/portaldot-v3-testnet-guide`, the English
translation published by the Portaldot team) and its `demo/04_solidity_demo.py`.

---

## Finding 1 — an external EOA cannot send transactions over the EVM JSON-RPC

**What the guide says:** §3.1.2 add the network to MetaMask; §3.4.2 deploy an H160 account, resolve
its mapped SS58 with `reviveApi.accountId`, fund that SS58 address; §3.4.3 deploy from Remix through
MetaMask.

**What we did:** followed it exactly, with a locally generated secp256k1 key instead of MetaMask so
the flow could be scripted.

1. Generated EOA `0x7FCC2Fc227f16220E3c0FAa63337551234de16f3`.
2. Resolved its mapped account with the runtime API:
   `reviveApi.accountId(0x7FCC…)` → `5ExGbSUEjj29Mvtt7BK5o3xZExUbbJsn2Xs2oqA8rmiL2ig8`.
3. Funded that account natively with `balances.transferKeepAlive` (20 tPOT) from an account that
   already held testnet funds.
4. Balance shows up on the EVM side, exactly as the guide describes:
   `eth_getBalance(0x7FCC…)` → `19.9 tPOT`, `eth_getTransactionCount` → `0`.
5. Sent the transaction. **Every variant is rejected:**

| Transaction | Result |
|---|---|
| EIP-1559, `gas 1e9`, tip 1 gwei, maxFee 2 gwei | `{"code":1010,"message":"Invalid Transaction"}` |
| EIP-1559, tip = maxFee = block base fee (39,805), `gas 1e8` | `Invalid Transaction` |
| Legacy, `gasPrice 1 gwei`, `gas 1e8` | `Invalid Transaction` |
| Legacy, `gasPrice 39,805`, `gas 1e11` | `Invalid Transaction` |
| Contract deployment (Remix/equivalent), explicit gas 1e9 | `Invalid Transaction` |

6. Reads on the same endpoint work: `eth_call`, `eth_estimateGas`, `eth_getCode`, `eth_getBalance`,
   `eth_getLogs`, `eth_feeHistory` all answer normally.
7. `revive.originalAccount(0x7FCC…)` → **none**: the H160 has no registered mapping in the revive
   pallet, even though the runtime API can compute the address it maps to and the balance is
   displayed. The mapping the guide relies on is one-directional today: it lets the native account
   fund/see the EVM address, not the other way round.

**Corroborating evidence:** the chain has processed **zero** EVM transactions in its entire history —
`gasUsedRatio: 0.0` across `eth_feeHistory`, `eth_getLogs` over the full range → `[]`, and 0
transactions in every block we sampled.

**Also note:** `eth_estimateGas` returns values in the 10^11–10^15 range (a plain transfer estimates
as `0x4c1cd3ec16` ≈ 3.3×10^11), and the block advertises `gasLimit = u64::MAX`. Any tool that
auto-fills gas from `eth_estimateGas` therefore builds a transaction whose maximum cost exceeds any
plausible balance, which is a second, independent reason the default MetaMask/Remix path cannot land
a transaction.

**Consequence:** at the time of writing, the only working way to execute a Solidity contract on this
testnet is the **native path** — sign `Revive.call` / `Revive.instantiate_with_code` with an ss58
account. That path is documented (§3.3.2, §3.4.4) but only as a four-step manual click-and-copy
sequence in the node console (generate calldata → dry-run through `reviveApi.call` → copy
`weight_limit` and `storage_deposit_limit` → submit `Revive.call` from Extrinsics).

**Caution for other builders:** test funds sent to an EOA's mapped account are currently not
recoverable from the EVM side. Keep test funds in the native account and drive contracts from there.

---

## Finding 2 — the native path works, and it is a single account across both runtimes

Proved on chain with [`tooling/deploy.mjs`](../tooling/deploy.mjs),
[`tooling/call.mjs`](../tooling/call.mjs) and [`tooling/call-dryrun.mjs`](../tooling/call-dryrun.mjs).
Details and hashes: [`DEPLOYMENT.md`](DEPLOYMENT.md).

- `Revive.instantiate_with_code` signed by ss58 `5DMLUzwxrQsPwc9dsjz4WUVSy4qryn2xWhtvv4RDkjBko9C7`
  deployed `0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725`; `eth_getCode` returns the 687-byte runtime.
- `Revive.call` from the same key executed `setValue(42)`; the contract emitted
  `revive.ContractEmitted` with `msg.sender = 0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934`, the
  account's mapped address.
- `eth_call` on the same contract then returned `value=42, lastCaller=0xe70f…d934, callCount=1` —
  the EVM layer reads state written by a native call.
- The dry-run flow from the guide works, implemented in JS: `reviveApi.call(origin, dest, value,
  gasLimit|null, storageDepositLimit|null, data)` returns
  `{weightConsumed, weightRequired, gasConsumed, storageDeposit, result}`, and passing
  `weightRequired` / `storageDeposit.charge` straight into `Revive.call` executes the transaction.
  Second call: `weightRequired {refTime 506,041,677, proofSize 31,937}`, `storage_deposit 0`,
  `gas_consumed 50,604,168`, executed in block
  `0x53f6d82f1db37c4faa4ba2f2e196ab026f141795fb5c5e52d0f4971f51e3f485`.

## What this means for the product

The official FAQ already says the unified account experience is *"awaiting confirmation and
end-to-end testing"* and that wallet UX for the modules is unspecified. Finding 1 turns that from a
documentation gap into a hard technical wall: the EVM write path that MetaMask/Remix users are told
to use does not accept transactions today.

So TwinKey does not merely wrap an existing flow. Its signer must:

1. drive contracts through the **native** path (the only one that works), computing
   `weight_limit` and `storage_deposit_limit` from the runtime API's dry-run instead of
   `eth_estimateGas`;
2. surface the same capability to EVM-shaped tooling through a provider shim, translating a
   `writeContract` into a `Revive.call` signed by the user's ss58 key;
3. treat the EVM JSON-RPC as a **read and simulation** channel, which is what it is on this build.

That is a narrower claim than "run Hardhat against the testnet unchanged", and it is the claim the
evidence supports.
