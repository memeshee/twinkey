import { ApiPromise, WsProvider } from "@polkadot/api";
const api = await ApiPromise.create({ provider: new WsProvider("wss://test-node-v3.portaldot.dev"), noInitWarn: true });
const head = (await api.rpc.chain.getHeader()).number.toNumber();
const ACCT = "5DMLUzwxrQsPwc9dsjz4WUVSy4qryn2xWhtvv4RDkjBko9C7";
console.log("head:", head, "| account:", ACCT);
// Control: Balances.Account changes over time. If the node serves real historical state,
// this value must DIFFER between the pre-funding era and now.
for (const n of [50000, 90000, 90990, 90995, 95000, 100000, head-10]) {
  const hash = await api.rpc.chain.getBlockHash(n);
  try {
    const apiAt = await api.at(hash);
    const acct = await apiAt.query.system.account(ACCT);
    const evs = await apiAt.query.system.events();
    const nonce = await apiAt.query.system.account(ACCT);
    console.log(`  block ${String(n).padStart(6)}: free=${acct.data.free.toString().padStart(22)} nonce=${nonce.nonce.toString().padStart(3)} events=${evs.length}`);
  } catch (e) {
    console.log(`  block ${String(n).padStart(6)}: FAILED ${String(e.message).slice(0,100)}`);
  }
}
await api.disconnect();
