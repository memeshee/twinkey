// Deploy TwinKeyProbe to Portaldot V3 testnet by signing revive.instantiateWithCode
// with the account's own ss58 (sr25519) key — no EVM key, no MetaMask.
// Usage: node deploy.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import solc from 'solc';
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';

const ENDPOINT = process.env.PORTALDOT_WS ?? 'wss://test-node-v3.portaldot.dev';
const KEY_FILE = process.env.PORTALDOT_KEY ?? path.join(os.homedir(), '.hermes/keys/portaldot-testnet.json');
const SOL = path.join(import.meta.dirname, '../contracts/TwinKeyProbe.sol');
const OUT = path.join(import.meta.dirname, '../contracts/build');
const WEIGHT = { refTime: 40_000_000_000, proofSize: 1_000_000 };
const DEPOSIT_LIMIT = 10_000_000_000_000_000n; // 10 tPOT cap on storage deposits

function compile() {
  const input = {
    language: 'Solidity',
    sources: { 'TwinKeyProbe.sol': { content: fs.readFileSync(SOL, 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts['TwinKeyProbe.sol'].TwinKeyProbe;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(`${OUT}/TwinKeyProbe.json`, JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2));
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

const { abi, bytecode } = compile();
console.log('compiled     : bytecode', (bytecode.length - 2) / 2, 'bytes');

await cryptoWaitReady();
const key = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
const pair = new Keyring({ type: key.crypto ?? 'sr25519', ss58Format: 42 }).addFromUri(key.secretUri ?? key.mnemonic);
console.log('signer       :', pair.address, `(${key.crypto})`);

const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });
console.log('chain        :', (await api.rpc.system.chain()).toString());

// The chain is the only authority on the address mapping — never derive it locally.
const mapped = await api.call.reviveApi.address(pair.publicKey);
const h160 = mapped.toString();
console.log('mapped H160  :', h160, '(via reviveApi.address)');

const { data: free } = await api.query.system.account(pair.address);
console.log('native free  :', free.toString());

const tx = api.tx.revive.instantiateWithCode(0n, WEIGHT, DEPOSIT_LIMIT, bytecode, '0x', null);
console.log('\ndispatching revive.instantiateWithCode …');

const hash = await new Promise(async (resolve, reject) => {
  let unsub;
  const timer = setTimeout(() => reject(new Error('timeout waiting for finalisation')), 180_000);
  unsub = await tx.signAndSend(pair, ({ status, events, dispatchError }) => {
    if (dispatchError) {
      clearTimeout(timer);
      if (dispatchError.isModule) {
        const d = api.registry.findMetaError(dispatchError.asModule);
        reject(new Error(`dispatch error: ${d.section}.${d.name} — ${d.docs.join(' ')}`));
      } else reject(new Error('dispatch error: ' + dispatchError.toString()));
    }
    if (status.isInBlock || status.isFinalized) {
      clearTimeout(timer);
      const h = status.isFinalized ? status.asFinalized : status.asInBlock;
      const info = [];
      for (const { event } of events) {
        const name = `${event.section}.${event.method}`;
        const d = api.events[event.section]?.[event.method];
        info.push({ name, data: event.data.map((x, i) => `${d?.meta?.fields?.[i]?.name ?? i}=${x.toString()}`).join(' ') });
      }
      console.log('\nblock        :', h.toHex(), status.isFinalized ? '(finalized)' : '(in block)');
      for (const e of info) console.log('  event      :', e.name, '|', e.data);
      unsub?.();
      resolve(h.toHex());
    }
  });
});
console.log('\ntx hash      :', hash);
await api.disconnect();
