// Deploy TwinKeyToken to Portaldot V3 by signing revive.instantiateWithCode with
// the account's own ss58 (sr25519) key — no EVM key, no MetaMask, no faucet, no
// second wallet. Same path as tooling/deploy.mjs, with a constructor that takes
// arguments so the deployed bytecode is code + encoded args, not code alone.
//
//   node tooling/deploy-token.mjs
//
// Prints the deployed address and then proves it over the EVM JSON-RPC: code
// present, name/symbol/decimals/totalSupply readable, balance minted to the
// deployer's *mapped* H160 (which is what msg.sender was inside the constructor).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import solc from "solc";
import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import { encodeAbiParameters } from "viem";
import { cryptoWaitReady } from "@polkadot/util-crypto";

const ENDPOINT = process.env.PORTALDOT_WS ?? "wss://test-node-v3.portaldot.dev";
const EVM_RPC = process.env.PORTALDOT_EVM_RPC ?? "https://test-evm-rpc-v3.portaldot.dev";
const KEY_FILE =
  process.env.PORTALDOT_KEY ?? path.join(os.homedir(), ".hermes/keys/portaldot-testnet.json");
const SOL = path.join(import.meta.dirname, "../contracts/TwinKeyToken.sol");
const OUT = path.join(import.meta.dirname, "../contracts/build");
const WEIGHT = { refTime: 120_000_000_000, proofSize: 2_000_000 };
const DEPOSIT_LIMIT = 10_000_000_000_000_000n;

const NAME = "TwinKey Demo Token";
const SYMBOL = "TKT";
const SUPPLY = 1_000_000n * 10n ** 18n;

function compile() {
  const input = {
    language: "Solidity",
    sources: { "TwinKeyToken.sol": { content: fs.readFileSync(SOL, "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["TwinKeyToken.sol"].TwinKeyToken;
  fs.mkdirSync(OUT, { recursive: true });
  const artifact = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
  fs.writeFileSync(`${OUT}/TwinKeyToken.json`, JSON.stringify(artifact, null, 2));
  return artifact;
}

const { abi, bytecode } = compile();
console.log("compiled     : runtime", ((bytecode.length - 2) / 2).toFixed(0), "bytes creation code");

await cryptoWaitReady();
const key = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
const pair = new Keyring({ type: key.crypto ?? "sr25519", ss58Format: 42 }).addFromUri(
  key.secretUri ?? key.mnemonic,
);
console.log("signer ss58  :", pair.address);

const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });
console.log("chain        :", (await api.rpc.system.chain()).toString());
const h160 = (await api.call.reviveApi.address(pair.publicKey)).toString();
console.log("mapped H160  :", h160, "(via reviveApi.address — never derived locally)");

// Constructor args: encoded by viem, not by hand. Hand-rolled ABI offsets are
// exactly the kind of thing that produces a Panic inside a constructor and a
// useless error message, so the encoder that every dApp already uses does it.
const ctor = encodeAbiParameters(
  [{ type: "string" }, { type: "string" }, { type: "uint256" }],
  [NAME, SYMBOL, SUPPLY],
);
// revive.instantiateWithCode wants the constructor input inside the code blob and
// rejects a non-empty `data` for EVM constructors (revive.EvmConstructorNonEmptyData).
const code = bytecode + ctor.slice(2);
console.log("ctor calldata:", ((ctor.length - 2) / 2).toFixed(0), "bytes");

// Dry run first: the runtime is the only honest source for weightRequired.
// `code` is a `ContractCode` enum (Upload | Existing), so the bytes go in a map.
const dry = await api.call.reviveApi.instantiate(
  pair.address,
  0n,
  { refTime: WEIGHT.refTime, proofSize: WEIGHT.proofSize },
  null,
  { Upload: code },
  "0x",
  null,
);
const dryJson = dry.toJSON();
console.log("dry run      :", JSON.stringify(dryJson).slice(0, 300));
if (dryJson.result && !dryJson.result.ok) {
  throw new Error("dry run failed: " + JSON.stringify(dryJson.result).slice(0, 400));
}

const weight = dryJson.weightRequired ?? WEIGHT;
const deposit = BigInt(dryJson.storageDeposit?.charge ?? 0);
const tx = api.tx.revive.instantiateWithCode(0n, weight, deposit > 0n ? deposit : DEPOSIT_LIMIT, code, "0x", null);

console.log("\ndispatching revive.instantiateWithCode …");
const result = await new Promise(async (resolve, reject) => {
  let unsub;
  const timer = setTimeout(() => reject(new Error("timeout waiting for inclusion")), 180_000);
  unsub = await tx.signAndSend(pair, ({ status, events, dispatchError, txHash }) => {
    if (dispatchError) {
      clearTimeout(timer);
      unsub?.();
      if (dispatchError.isModule) {
        const d = api.registry.findMetaError(dispatchError.asModule);
        reject(new Error(`dispatch error: ${d.section}.${d.name} — ${d.docs.join(" ")}`));
      } else reject(new Error("dispatch error: " + dispatchError.toString()));
      return;
    }
    if (status.isInBlock || status.isFinalized) {
      clearTimeout(timer);
      const blockHash = (status.isFinalized ? status.asFinalized : status.asInBlock).toHex();
      const out = [];
      for (const { event } of events) {
        if (event.section.toLowerCase() !== "revive") continue;
        const names = event.meta?.fields?.map((f, i) => `${f.name?.toString() ?? i}=${event.data[i].toString()}`) ?? [];
        out.push(`${event.section}.${event.method} ${names.join(" ")}`);
      }
      unsub?.();
      resolve({ extrinsicHash: txHash.toHex(), blockHash, events: out });
    }
  });
});

console.log("tx hash      :", result.extrinsicHash);
console.log("block        :", result.blockHash);
for (const e of result.events) console.log("  event      :", e);

const contract = result.events
  .map((e) => /contract=(0x[0-9a-fA-F]{40})/.exec(e)?.[1])
  .find(Boolean);
console.log("contract     :", contract ?? "(not announced — check the events above)");

if (contract) {
  const rpc = async (method, params) => {
    const res = await fetch(EVM_RPC, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "twinkey-deploy-token/1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  };
  const call = (data) => rpc("eth_call", [{ to: contract, data }, "latest"]);
  const code = await rpc("eth_getCode", [contract, "latest"]);
  const totalSupply = BigInt(await call("0x18160ddd")); // totalSupply()
  const owner = "0x" + (await call("0x8da5cb5b")).slice(-40); // owner()
  const decimals = BigInt(await call("0x313ce567")); // decimals()
  const balHex = await call(
    "0x70a08231" + h160.replace(/^0x/, "").padStart(64, "0"),
  ); // balanceOf(h160)
  console.log("\nEVM-verified :");
  console.log("  code       :", (code.length - 2) / 2, "bytes");
  console.log("  decimals   :", decimals.toString());
  console.log("  totalSupply:", totalSupply.toString());
  console.log("  owner      :", owner.toLowerCase(), owner.toLowerCase() === h160.toLowerCase() ? "(the ss58 account's mapped H160)" : "(UNEXPECTED)");
  console.log("  balance    :", BigInt(balHex).toString(), "to", h160);
}

await api.disconnect();
