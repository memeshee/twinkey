import { ApiPromise, WsProvider } from "@polkadot/api";
const api = await ApiPromise.create({ provider: new WsProvider("wss://test-node-v3.portaldot.dev"), noInitWarn: true });
const head = (await api.rpc.chain.getHeader()).number.toNumber();
console.log("head:", head);
for (const n of [head-100, head-5000, head-20000, 50000, 10000, 1000, 100, 1, 0]) {
  if (n < 0) continue;
  const hash = await api.rpc.chain.getBlockHash(n);
  try {
    const apiAt = await api.at(hash);
    const evs = await apiAt.query.system.events();
    const meta = apiAt.registry.metadata;
    console.log(`  block ${String(n).padStart(6)}: OK — ${evs.length} events, metadata ${meta.version} types=${apiAt.registry.lookup.types.length}`);
  } catch (e) {
    console.log(`  block ${String(n).padStart(6)}: FAILED — ${String(e.message).slice(0,120)}`);
  }
}
await api.disconnect();
