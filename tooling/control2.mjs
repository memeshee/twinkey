import { ApiPromise, WsProvider } from "@polkadot/api";
const api = await ApiPromise.create({ provider: new WsProvider("wss://test-node-v3.portaldot.dev"), noInitWarn: true });
// Independent control #2: TotalIssuance changes every era (staking rewards). If historical
// state is real, these MUST differ. A pruned node returns the same (current) value or errors.
console.log("Balances.TotalIssuance by block (changes with staking rewards):");
for (const n of [50000, 90000, 95000, 100000, 101500]) {
  const hash = await api.rpc.chain.getBlockHash(n);
  const apiAt = await api.at(hash);
  const ti = await apiAt.query.balances.totalIssuance();
  console.log(`  block ${String(n).padStart(6)}: ${ti.toString()}`);
}
const cur = await api.query.balances.totalIssuance();
console.log(`  latest      : ${cur.toString()}`);
console.log("\nStaking.ActiveEra by block:");
for (const n of [50000, 90000, 100000]) {
  const hash = await api.rpc.chain.getBlockHash(n);
  const apiAt = await api.at(hash);
  try { const e = await apiAt.query.staking.activeEra(); console.log(`  block ${n}: ${JSON.stringify(e.toJSON())}`); }
  catch(e){ console.log(`  block ${n}: ${String(e.message).slice(0,60)}`); }
}
await api.disconnect();
