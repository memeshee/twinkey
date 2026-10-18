// Call the deployed probe contract through the NATIVE path (revive.call) with an ss58 key,
// then read the same state back through the EVM JSON-RPC (eth_call). Two runtimes, one account.
// Usage: node call.mjs [contractAddress] [value]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult } from 'viem';

const ENDPOINT = process.env.PORTALDOT_WS ?? 'wss://test-node-v3.portaldot.dev';
const EVM_RPC = process.env.PORTALDOT_EVM ?? 'https://test-evm-rpc-v3.portaldot.dev';
const KEY_FILE = process.env.PORTALDOT_KEY ?? path.join(os.homedir(), '.hermes/keys/portaldot-testnet.json');
const ABI = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../contracts/build/TwinKeyProbe.json'), 'utf8')).abi;
const WEIGHT = { refTime: 40_000_000_000, proofSize: 1_000_000 };
const DEPOSIT_LIMIT = 10_000_000_000_000_000n;

const contract = process.argv[2] ?? process.env.CONTRACT;
const newValue = BigInt(process.argv[3] ?? 42);
if (!contract) throw new Error('usage: node call.mjs <contractAddress> [value]');

const evm = createPublicClient({ transport: http(EVM_RPC) });

await cryptoWaitReady();
const key = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
const pair = new Keyring({ type: key.crypto ?? 'sr25519', ss58Format: 42 }).addFromUri(key.secretUri ?? key.mnemonic);

const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });
const h160 = (await api.call.reviveApi.address(pair.publicKey)).toString();
console.log('signer ss58  :', pair.address);
console.log('mapped H160  :', h160);
console.log('contract     :', contract);

const data = encodeFunctionData({ abi: ABI, functionName: 'setValue', args: [newValue] });
console.log('calldata     :', data, `(setValue(${newValue}))`);

const before = await evm.readContract({ address: contract, abi: ABI, functionName: 'read' });
console.log('state before : value=%s lastCaller=%s callCount=%s', before[0], before[1], before[2]);

console.log('\ndispatching revive.call (native origin) …');
const tx = api.tx.revive.call(contract, 0n, WEIGHT, DEPOSIT_LIMIT, data);
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
        const rendered = event.data.map((x, i) => `${fields[i]?.name ?? i}=${x.toString()}`).join(' ');
        if (!['system.ExtrinsicSuccess', 'transactionPayment.TransactionFeePaid'].includes(`${event.section}.${event.method}`)) {
          console.log(`  ${event.section}.${event.method} | ${rendered}`);
        }
      }
      unsub?.();
      resolve((status.isFinalized ? status.asFinalized : status.asInBlock).toHex());
    }
  });
});
console.log('tx block     :', blockHash);

const after = await evm.readContract({ address: contract, abi: ABI, functionName: 'read' });
console.log('\nstate after  : value=%s lastCaller=%s callCount=%s', after[0], after[1], after[2]);
console.log('caller match :', after[1].toLowerCase() === h160.toLowerCase() ? 'YES — the EVM side sees the mapped address' : 'MISMATCH');
await api.disconnect();
