import { ApiPromise, WsProvider } from "@polkadot/api";
const WS = "wss://test-node-v3.portaldot.dev";
const api = await ApiPromise.create({ provider: new WsProvider(WS), noInitWarn: true });
console.log("connected:", (await api.rpc.system.chain()).toString());

for (const n of [90995, 90990, 91528, 92322]) {
  const hash = await api.rpc.chain.getBlockHash(n);
  try {
    const apiAt = await api.at(hash);
    const evs = await apiAt.query.system.events();
    const ours = evs.filter(({event}) => event.section === "revive");
    console.log(`block ${n}: ${evs.length} events, ${ours.length} revive events`);
    for (const {event} of ours) {
      const f = event.meta.fields;
      const rendered = event.data.map((x,i)=>`${f[i]?.name.isSome?f[i].name.unwrap():i}=${x.toString().slice(0,80)}`).join(" | ");
      console.log("   ", event.section+"."+event.method, "::", rendered);
    }
  } catch (e) {
    console.log(`block ${n}: FAILED — ${String(e.message).slice(0,160)}`);
  }
}
await api.disconnect();
