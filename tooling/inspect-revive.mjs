// Inspect what the Portaldot V3 runtime actually exposes for pallet-revive.
// Usage: node inspect-revive.mjs
import { ApiPromise, WsProvider } from '@polkadot/api';
import { cryptoWaitReady } from '@polkadot/util-crypto';

const ENDPOINT = process.env.PORTALDOT_WS ?? 'wss://test-node-v3.portaldot.dev';

const api = await ApiPromise.create({
  provider: new WsProvider(ENDPOINT),
  noInitWarn: true,
});

console.log('chain        :', (await api.rpc.system.chain()).toString());
console.log('runtime      :', api.runtimeVersion.specName.toString(), 'v' + api.runtimeVersion.specVersion.toString());
console.log('genesis      :', api.genesisHash.toHex());
console.log('decimals     :', api.registry.chainDecimals, 'symbol:', api.registry.chainTokens);

const pallet = 'revive';
console.log(`\n=== api.tx.${pallet} ===`);
const tx = api.tx[pallet];
if (!tx) {
  console.log('NO revive pallet in api.tx');
} else {
  for (const key of Object.keys(tx)) {
    const m = tx[key];
    const args = (m.meta?.args ?? []).map((a) => `${a.name}: ${a.type}`).join(', ');
    const doc = (m.meta?.docs ?? []).map((d) => d.toString()).join(' ').slice(0, 160);
    console.log(`- ${key}(${args})`);
    if (doc) console.log(`    ${doc}`);
  }
}

console.log(`\n=== api.query.${pallet} ===`);
const q = api.query[pallet];
if (!q) console.log('none');
else for (const key of Object.keys(q)) console.log('-', key);

console.log('\n=== runtime API namespaces (api.call) ===');
for (const ns of Object.keys(api.call ?? {})) {
  const keys = Object.keys(api.call[ns] ?? {});
  if (keys.length) console.log(`- ${ns}: ${keys.join(', ')}`);
}

await api.disconnect();
await cryptoWaitReady();
