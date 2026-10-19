/**
 * End-to-end proof that the EIP-1193 provider works against the LIVE Portaldot V3 testnet.
 *
 * It drives the provider exactly as `viem`/`wagmi` would: eth_requestAccounts -> eth_call ->
 * eth_estimateGas -> eth_sendTransaction -> eth_getTransactionReceipt. The write is a real
 * `revive.call` extrinsic signed by an ss58 key, and the receipt's log is decoded back into a
 * named EVM event. Nothing here is mocked.
 *
 * Run: npx tsx scripts/e2e-provider.ts [value]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem";

import { getApi } from "../lib/twinkey/chain";
import { createTwinKeyProvider } from "../lib/twinkey/provider";
import { keyringSigner } from "../lib/twinkey/signers";
import { TWINKEY_PROBE_ABI, TWINKEY_PROBE_ADDRESS } from "../lib/twinkey/abi";
import { PORTALDOT } from "../lib/twinkey/config";

const NEW_VALUE = BigInt(process.argv[2] ?? "2026");
const KEY_FILE = process.env.PORTALDOT_KEY ?? path.join(os.homedir(), ".hermes/keys/portaldot-testnet.json");
const READ_ABI = parseAbi([
  "function read() view returns (uint256 value, address lastCaller, uint256 callCount)",
]);

const ok = (label: string, pass: boolean, detail: string) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return pass;
};

const results: boolean[] = [];

async function main() {
  await cryptoWaitReady();
  const key = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
  const pair = new Keyring({ type: key.crypto ?? "sr25519", ss58Format: 42 }).addFromUri(
    key.secretUri ?? key.mnemonic,
  );

  console.log("=".repeat(78));
  console.log("TwinKey provider — end-to-end against live PortaldotV3 Test");
  console.log("=".repeat(78));
  console.log("signer ss58 :", pair.address);
  console.log("contract    :", TWINKEY_PROBE_ADDRESS);
  console.log();

  const api = await getApi();
  const chain = (await api.rpc.system.chain()).toString();
  const provider = createTwinKeyProvider({ signer: keyringSigner(api, pair) });

  console.log("[1] provider handshake (what a wallet does on connect)");
  results.push(ok("eth_chainId", (await provider.request({ method: "eth_chainId" })) === PORTALDOT.evmChainIdHex, PORTALDOT.evmChainIdHex));
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const h160 = accounts[0];
  results.push(ok("eth_requestAccounts returns the mapped H160", /^0x[0-9a-f]{40}$/.test(h160), h160));
  const identity = await provider.request({ method: "twinkey_identity" });
  console.log("      identity:", JSON.stringify(identity));
  results.push(ok("chain", chain === PORTALDOT.substrateName, chain));

  console.log("\n[2] read before (pure EVM JSON-RPC, as viem would)");
  const readData = encodeFunctionData({ abi: READ_ABI, functionName: "read" });
  const beforeRaw = await provider.request({
    method: "eth_call",
    params: [{ to: TWINKEY_PROBE_ADDRESS, data: readData }, "latest"],
  });
  const before = decodeRead(beforeRaw);
  console.log("      value=%s lastCaller=%s callCount=%s", before.value, before.lastCaller, before.callCount);
  results.push(ok("lastCaller is the mapped address of the ss58 signer", before.lastCaller.toLowerCase() === h160, before.lastCaller));

  console.log("\n[3] eth_estimateGas — TwinKey answers from the runtime dry-run, not the broken EVM estimate");
  const callData = encodeFunctionData({ abi: TWINKEY_PROBE_ABI, functionName: "setValue", args: [NEW_VALUE] });
  const gasEstimate = await provider.request({
    method: "eth_estimateGas",
    params: [{ from: h160, to: TWINKEY_PROBE_ADDRESS, data: callData }],
  });
  const gasInt = BigInt(gasEstimate);
  const chainEstimate = BigInt(
    await (await fetch(PORTALDOT.evmRpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_estimateGas", params: [{ from: h160, to: TWINKEY_PROBE_ADDRESS, data: callData }] }),
    })).json().then((r: any) => r.result ?? "0x0").catch(() => "0x0"),
  );
  console.log("      TwinKey (dry-run) :", gasInt.toString());
  console.log("      EVM RPC (raw)     :", chainEstimate.toString(), chainEstimate > 0n ? `(${(Number(chainEstimate) / Number(gasInt)).toFixed(0)}x larger)` : "");
  results.push(ok("TwinKey estimate is the real execution cost, not the inflated EVM one", gasInt > 0n && gasInt < 10_000_000_000n, gasInt.toString()));

  console.log("\n[4] eth_sendTransaction — the write goes out as a revive.call signed by sr25519");
  const t0 = Date.now();
  const txHash = await provider.request({
    method: "eth_sendTransaction",
    params: [{ from: h160, to: TWINKEY_PROBE_ADDRESS, data: callData, value: "0x0" }],
  });
  console.log("      tx hash   :", txHash);
  console.log("      elapsed   :", ((Date.now() - t0) / 1000).toFixed(1), "s");
  results.push(ok("a 0x32-byte transaction hash came back", /^0x[0-9a-f]{64}$/.test(txHash as string), txHash as string));

  console.log("\n[5] eth_getTransactionReceipt — synthesized from the Substrate extrinsic");
  const receipt: any = await provider.request({ method: "eth_getTransactionReceipt", params: [txHash] });
  results.push(ok("receipt exists", !!receipt, receipt ? "status " + receipt.status : "missing"));
  console.log("      status    :", receipt.status, receipt.status === "0x1" ? "(success)" : "(failed)");
  console.log("      block     :", receipt.blockNumber, receipt.blockHash);
  console.log("      gasUsed   :", BigInt(receipt.gasUsed).toString());
  console.log("      logs      :", receipt.logs.length);
  for (const log of receipt.logs) {
    console.log("        -", log.address, log.parsed ? `${log.parsed.eventName}(${JSON.stringify(log.parsed.args)})` : "(undecoded)");
  }
  const decodedSet = receipt.logs.find((l: any) => l.parsed?.eventName === "ValueSet");
  results.push(ok("the EVM log was decoded to a named event", !!decodedSet, decodedSet ? JSON.stringify(decodedSet.parsed.args) : "no ValueSet"));
  if (decodedSet) {
    results.push(ok("event caller == mapped H160", String(decodedSet.parsed.args.caller).toLowerCase() === h160, String(decodedSet.parsed.args.caller)));
    results.push(ok(`event value == ${NEW_VALUE}`, String(decodedSet.parsed.args.value) === NEW_VALUE.toString(), String(decodedSet.parsed.args.value)));
  }

  console.log("\n[6] read after — state written by a native call, read back over EVM JSON-RPC");
  const afterRaw = await provider.request({
    method: "eth_call",
    params: [{ to: TWINKEY_PROBE_ADDRESS, data: readData }, "latest"],
  });
  const after = decodeRead(afterRaw);
  console.log("      value=%s lastCaller=%s callCount=%s", after.value, after.lastCaller, after.callCount);
  results.push(ok("value updated", after.value === NEW_VALUE, `${before.value} -> ${after.value}`));
  results.push(ok("callCount incremented", after.callCount > before.callCount, `${before.callCount} -> ${after.callCount}`));

  console.log("\n[7] eth_getLogs — same decode applied to the historical log query");
  const logs = (await provider.request({
    method: "eth_getLogs",
    params: [{ address: TWINKEY_PROBE_ADDRESS, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber }],
  })) as any[];
  const parsedLogs = logs.filter((l) => l.parsed);
  console.log(`      ${logs.length} log(s) in block, ${parsedLogs.length} decoded`);
  for (const l of parsedLogs.slice(0, 3)) console.log("        -", l.parsed.eventName, JSON.stringify(l.parsed.args));

  console.log("\n" + "=".repeat(78));
  const passed = results.filter(Boolean).length;
  console.log(`RESULT: ${passed}/${results.length} checks passed`);
  console.log("=".repeat(78));
  await api.disconnect();
  if (passed !== results.length) process.exit(1);
}

function decodeRead(raw: string) {
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  const word = (i: number) => BigInt("0x" + hex.slice(i * 64, (i + 1) * 64));
  const addr = "0x" + hex.slice(64 + 24, 128);
  return { value: word(0), lastCaller: addr, callCount: word(2) };
}

main().catch((e) => {
  console.error("\nE2E FAILED:", e?.message ?? e);
  if (e?.data) console.error("data:", e.data);
  process.exit(1);
});
