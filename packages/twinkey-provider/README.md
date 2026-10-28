# twinkey-provider

An **EIP-1193 provider** that lets an ordinary Substrate `ss58` key drive contracts on
[Portaldot](https://portaldot.dev) from `viem`, `wagmi` or `ethers`.

Reads are served by the EVM JSON-RPC, so wallets and libraries see the state a normal EVM node
would report. Writes are the interesting part: on this chain an external EOA **cannot** send a
transaction — every type returns `{"code":1010,"message":"Invalid Transaction"}` — so each write
is translated into a `revive.call` extrinsic signed by an `sr25519` key. That is the only write
path that works, and this provider is the difference between knowing that and living with it.

```bash
npm i twinkey-provider
```

## Browser: whatever Substrate wallet is installed

```ts
import { createTwinKeyProvider, fromExtension } from "twinkey-provider";
import { createWalletClient, createPublicClient, http, erc20Abi } from "viem";

const { signer } = await fromExtension();          // polkadot.js / Talisman / SubWallet
const provider = createTwinKeyProvider({ signer }); // EIP-1193

const wallet = createWalletClient({ transport: custom(provider) });
const pub    = createPublicClient({ transport: custom(provider) });

const [from] = await wallet.getAddresses();        // the account's mapped H160
const hash = await wallet.writeContract({
  address: TKT, abi: erc20Abi, functionName: "transfer", args: [to, 10n ** 18n], account: from,
});
const receipt = await pub.waitForTransactionReceipt({ hash });   // works: see below
```

## Node: a keyring pair

```ts
import { Keyring } from "@polkadot/keyring";
import { createTwinKeyProvider, keyringSigner, getApi } from "twinkey-provider";

const api    = await getApi();
const pair   = new Keyring({ type: "sr25519" }).addFromUri(process.env.SEED!);
const signer = keyringSigner(api, pair);
const provider = createTwinKeyProvider({ signer });
```

## three options, and what each costs

```ts
createTwinKeyProvider({
  signer,                  // required: { ss58, submit(tx) } — anything that signs an extrinsic
  abi,                     // optional: decodes ContractEmitted into receipt logs (default: probe)
  rpc,                     // optional: JSON-RPC passthrough override (tests, custom endpoints)
  api,                     // optional: ApiPromise getter override (tests)
});
```

## What it handles so you don't have to

- **Writes as extrinsics.** `eth_sendTransaction` / `eth_sendRawTransaction` become
  `revive.call`, signed by your key. `eth_sendRawTransaction` accepts raw signed EVM bytes and
  says plainly that it cannot execute them, rather than pretending.
- **Receipts that survive.** The transaction hash you get back is an **extrinsic** hash, which
  the EVM node has never seen. The provider keeps the mapping in memory and emits an EVM-shaped
  receipt with `status`, `blockNumber`, `logs` and `logsBloom` filled in. If the write was served
  by another process (a second lambda, a restarted server), resolve it statelessly with an
  archive scan — see `twinkey/app/api/receipt` in the main repo.
- **Logs, decoded twice.** `eth_getLogs` on this chain omits logs produced by native-path calls.
  The provider merges what it recorded with what the node returns and decodes both against your
  ABI into `parsed` events.
- **`eth_estimateGas` you can distrust.** It is inflated by roughly 10⁴ on this build. The
  provider answers `eth_estimateGas` from the runtime dry run instead, and exposes
  `twinkey_estimate` when you want the side-by-side.
- **Decimals.** Native balances are 14 dp, EVM balances 18 dp. Conversions are in
  `nativeToWei` / `weiToNative`; the provider reports wei, like an EVM node.
- **`twinkey_identity`** returns `{ ss58, h160, chain, block }` — the mapping in one call.

## Methods

| Method | Behaviour |
| --- | --- |
| `eth_accounts`, `eth_requestAccounts` | the signer's mapped `H160` |
| `eth_chainId`, `net_version` | the EVM chain id this network reports |
| `eth_sendTransaction`, `eth_sendRawTransaction` | `revive.call` extrinsic, returns the extrinsic hash |
| `eth_getTransactionReceipt` | EVM-shaped receipt, resolved from the write or the archive |
| `eth_estimateGas` | the runtime dry run, not the node's inflated number |
| `eth_getLogs`, `eth_getTransactionByHash` | node result merged with this provider's own records |
| `eth_blockNumber`, `eth_call`, `eth_getCode`, `eth_getBalance`, `eth_getStorageAt`, `eth_gasPrice`, `eth_feeHistory`, `eth_getBlockBy*`, … | forwarded verbatim |
| `twinkey_identity`, `twinkey_estimate`, `twinkey_logs` | the chain-specific extras |

Events: `connect`, `accountsChanged`, `chainChanged`, `disconnect` — standard EIP-1193.

## Honest limits

- **No `autoMap` for you.** A fresh `ss58` account is not automatically reachable at an `H160`;
  the first contract call maps it. `resolveH160` / `twinkey_identity` tell you the address the
  chain will use, but the mapping only exists after that first touch.
- **One signer per provider.** Multi-account selection is the wallet's job (`fromExtension`
  takes an `address`).
- **The provider is a client, not a node.** Long-running servers should pin their own
  `ApiPromise` and pass it via `api` — `getApi()` keeps a shared socket alive for 4 minutes and
  rebuilds it, which is right for a browser tab and wrong for a process that must never block.

MIT. Built for Portaldot Hacker House 2026; the underlying findings are in
[`docs/FINDINGS.md`](https://github.com/memeshee/twinkey/blob/main/docs/FINDINGS.md) and the
reproducible traps in [`/traps.json`](https://twinkey.vercel.app/traps.json).
