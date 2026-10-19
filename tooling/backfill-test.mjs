import { ApiPromise, WsProvider } from "@polkadot/api";
const api = await ApiPromise.create({ provider: new WsProvider("wss://test-node-v3.portaldot.dev"), noInitWarn: true });
// Can a fresh indexer backfill from block 0 RIGHT NOW? This is exactly what portalIndex claims is impossible.
const totals = {};
let blocks = 0, reviveEvents = 0, evmEmitted = 0;
for (const n of [1, 1000, 10000, 25000, 50000, 75000, 90990, 90995, 92322]) {
  const hash = await api.rpc.chain.getBlockHash(n);
  const apiAt = await api.at(hash);
  const evs = await apiAt.query.system.events();
  blocks++;
  for (const {event} of evs) {
    totals[event.section] = (totals[event.section]||0)+1;
    if (event.section === "revive") { reviveEvents++; if (event.method==="ContractEmitted") evmEmitted++; }
  }
  console.log(`block ${String(n).padStart(6)}: ${evs.length} events  (revive: ${evs.filter(e=>e.event.section==="revive").length})`);
}
console.log("\nbackfillable right now from deep history:", blocks, "sampled blocks,", reviveEvents, "revive events,", evmEmitted, "EVM logs");
console.log("pallets seen:", Object.keys(totals).sort().join(", "));
await api.disconnect();
