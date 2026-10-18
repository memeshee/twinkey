// Dry-run then execute a contract call, following the official Portaldot V3 guide
// (ReviveApi::call → weight_required + storage_deposit → Revive.call), but in JS/TS.
// No hardcoded weights: the chain tells us what the call costs before we sign.
// Usage: node call-dryrun.mjs <contract> <newValue>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { createPublicClient, http, encodeFunctionData } from 'viem';

const ENDPOINT = process.env.PORTALDOT_WS ?? 'wss://test-node-v3.portaldot.dev';
const EVM_RPC = process.env.PORTALDOT_EVM ?? 'https://test-evm-rpc-v3.portaldot.dev';
const KEY_FILE = process.env.PORTALDOT_KEY ?? path.join(os.homedir(), '.hermes/keys/portaldot-testnet.json');
const ABI = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../contracts/build/TwinKeyProbe.json'), 'utf8')).abi;

const contract = process.argv[2];
const newValue = BigInt(process.argv[3] ?? 7);
if (!contract) throw new Error('usage: node call-dryrun.mjs <contractAddress> [value]');

await cryptoWaitReady();
const key = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
const pair = new Keyring({ type: key.crypto ?? 'sr25519', ss58Format: 42 }).addFromUri(key.secretUri ?? key.mnemonic);
const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });
const evm = createPublicClient({ transport: http(EVM_RPC) });

const h160 = (await api.call.reviveApi.address(pair.publicKey)).toString();
const data = encodeFunctionData({ abi: ABI, functionName: 'setValue', args: [newValue] });
console.log('signer  :', pair.address, '→', h160);
console.log('contract:', contract, 'calldata:', data.slice(0, 18) + '…');

// --- 1. dry run through the runtime API (ReviveApi::call) -------------------
// api.call.reviveApi.call(origin, dest, value, gasLimit|null, storageDepositLimit|null, input)
const dry = await api.call.reviveApi.call(pair.address, contract, 0, null, null, data);
const j = dry.toJSON();
console.log('\ndry run :');
console.log('  weight_required :', JSON.stringify(j.weightRequired ?? j.weight_required));
console.log('  storage_deposit :', JSON.stringify(j.storageDeposit ?? j.storage_deposit));
console.log('  gas_consumed    :', (j.gasConsumed ?? j.gas_consumed)?.toString());
const result = j.result ?? {};
if (result.ok === undefined && result.Ok === undefined) {
  console.log('  result          :', JSON.stringify(result).slice(0, 300));
  throw new Error('dry run did not return Ok — aborting before signing');
}
const ret = result.ok ?? result.Ok;
console.log('  returned data   :', typeof ret === 'string' ? ret : JSON.stringify(ret));

const weight = j.weightRequired ?? j.weight_required;
const deposit = j.storageDeposit ?? j.storage_deposit;
const depositLimit = BigInt(deposit?.charge ?? deposit?.Charge ?? 0);

// --- 2. execute with exactly what the chain said it needs ------------------
console.log('\nexecuting revive.call with the estimated limits …');
const tx = api.tx.revive.call(contract, 0n, weight, depositLimit, data);
const blockHash = await new Promise(async (resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout')), 180_000);
  const unsub = await tx.signAndSend(pair, ({ status, events, dispatchError }) => {
    if (dispatchError) {
      clearTimeout(timer);
      let msg = dispatchError.toString();
      if (dispatchError.isModule) {
        const d = api.registry.findMetaError(dispatchError.asModule);
        msg = `${d.section}.${d.name} — ${d.docs.join(' ')}`;
      }
      reject(new Error('dispatch error: ' + msg));
    }
    if (status.isInBlock || status.isFinalized) {
      clearTimeout(timer);
      for (const { event } of events) {
        const fields = api.events[event.section]?.[event.method]?.meta?.fields ?? [];
        if (['revive.ContractEmitted', 'revive.Called', 'system.ExtrinsicFailed'].includes(`${event.section}.${event.method}`)) {
          console.log(`  ${event.section}.${event.method} |`,
            event.data.map((x, i) => `${fields[i]?.name ?? i}=${x.toString()}`).join(' ').slice(0, 220));
        }
      }
      unsub?.();
      resolve((status.isFinalized ? status.asFinalized : status.asInBlock).toHex());
    }
  });
});
console.log('block   :', blockHash);

const after = await evm.readContract({ address: contract, abi: ABI, functionName: 'read' });
console.log('\nread via eth_call → value=%s lastCaller=%s callCount=%s', after[0], after[1], after[2]);
await api.disconnect();
