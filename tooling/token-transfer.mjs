// Move TKT around with the ss58 key, through revive.call — the same call the app
// makes, from a script, so the token demo does not depend on a browser.
//
//   node tooling/token-transfer.mjs <to-h160> <amount-whole-tokens>
//   node tooling/token-transfer.mjs --mint <to-h160> <amount-whole-tokens>
//
// Reads the deployed address from contracts/build/TwinKeyToken.deployed.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { encodeFunctionData, erc20Abi, parseUnits } from "viem";

const ENDPOINT = process.env.PORTALDOT_WS ?? "wss://test-node-v3.portaldot.dev";
const EVM_RPC = process.env.PORTALDOT_EVM_RPC ?? "https://test-evm-rpc-v3.portaldot.dev";
const KEY_FILE =
  process.env.PORTALDOT_KEY ?? path.join(os.homedir(), ".hermes/keys/portaldot-testnet.json");
const DEPLOYED = path.join(import.meta.dirname, "../contracts/build/TwinKeyToken.deployed.json");

const [, , ...args] = process.argv;
const mint = args[0] === "--mint";
const [to, amountArg] = mint ? args.slice(1) : args;
if (!/^0x[0-9a-fA-F]{40}$/.test(to ?? "") || !amountArg) {
  console.error("usage: node tooling/token-transfer.mjs [--mint] <h160> <whole-tokens>");
  process.exit(1);
}
const amount = parseUnits(amountArg, 18);

const address = JSON.parse(fs.readFileSync(DEPLOYED, "utf8")).address;
const data = encodeFunctionData({
  abi: erc20Abi,
  functionName: mint ? "mint" : "transfer",
  args: [to, amount],
});

await cryptoWaitReady();
const key = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
const pair = new Keyring({ type: key.crypto ?? "sr25519", ss58Format: 42 }).addFromUri(
  key.secretUri ?? key.mnemonic,
);
const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });
console.log("token        :", address);
console.log("signer ss58  :", pair.address);

const dry = (await api.call.reviveApi.call(pair.address, address, 0n, null, null, data)).toJSON();
if (!dry.result?.ok) {
  console.error("dry run refused:", JSON.stringify(dry.result).slice(0, 400));
  process.exit(1);
}
const weight = dry.weightRequired;
const deposit = BigInt(dry.storageDeposit?.charge ?? 0);
console.log("dry run      : refTime", weight.refTime, "proofSize", weight.proofSize, "→ refunded if unused");

const tx = api.tx.revive.call(address, 0n, weight, deposit, data);
const out = await new Promise(async (resolve, reject) => {
  let unsub;
  const timer = setTimeout(() => reject(new Error("timeout")), 180_000);
  unsub = await tx.signAndSend(pair, ({ status, events, dispatchError, txHash }) => {
    if (dispatchError) {
      clearTimeout(timer);
      unsub?.();
      if (dispatchError.isModule) {
        const d = api.registry.findMetaError(dispatchError.asModule);
        reject(new Error(`${d.section}.${d.name} — ${d.docs.join(" ")}`));
      } else reject(new Error(dispatchError.toString()));
      return;
    }
    if (status.isInBlock || status.isFinalized) {
      clearTimeout(timer);
      const emitted = [];
      for (const { event } of events) {
        if (event.section.toLowerCase() !== "revive" || event.method !== "ContractEmitted") continue;
        const fields = event.meta?.fields ?? [];
        const pick = (name, idx) => {
          const i = fields.findIndex((f) => f.name?.isSome && f.name.unwrap().toString() === name);
          return event.data[i >= 0 ? i : idx];
        };
        emitted.push({ topics: pick("topics", 2)?.toJSON?.() ?? [], data: String(pick("data", 1)) });
      }
      unsub?.();
      resolve({
        txHash: txHash.toHex(),
        blockHash: (status.isFinalized ? status.asFinalized : status.asInBlock).toHex(),
        emitted,
      });
    }
  });
});

console.log("tx hash      :", out.txHash);
console.log("block        :", out.blockHash);
for (const e of out.emitted) {
  // Transfer(address indexed from, address indexed to, uint256 value)
  if (e.topics?.[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") {
    const from = "0x" + e.topics[1].slice(-40);
    const dest = "0x" + e.topics[2].slice(-40);
    console.log(`  Transfer     ${from} -> ${dest}  ${BigInt(e.data).toString()}`);
  }
}

const rpc = async (method, params) => {
  const res = await fetch(EVM_RPC, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "twinkey-token-transfer/1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
};
const bal = BigInt(
  await rpc("eth_call", [
    { to: address, data: "0x70a08231" + to.replace(/^0x/, "").padStart(64, "0") },
    "latest",
  ]),
);
console.log("balance now  :", bal.toString(), "for", to, "(read over the EVM RPC)");
await api.disconnect();
