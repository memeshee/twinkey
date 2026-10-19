import { ApiPromise, WsProvider } from "@polkadot/api";
const api = await ApiPromise.create({ provider: new WsProvider("wss://test-node-v3.portaldot.dev"), noInitWarn: true });
const NATIVE = "5ExGbSUEjj29Mvtt7BK5o3xZExUbbJsn2Xs2oqA8rmiL2ig8";
const acct = await api.query.system.account(NATIVE);
console.log("native account:", NATIVE);
console.log("  free :", acct.data.free.toString(), "=", (Number(acct.data.free.toString())/1e14).toFixed(6), "tPOT (14 dec)");
console.log("  nonce:", acct.nonce.toString());
// does the H160 have a registered original account in the revive pallet?
const orig = await api.query.revive.originalAccount("0x7FCC2Fc227f16220E3c0FAa63337551234de16f3");
console.log("  revive.originalAccount:", orig.toString());
const mapped = await api.call.reviveApi.accountId("0x7FCC2Fc227f16220E3c0FAa63337551234de16f3");
console.log("  reviveApi.accountId(H160) ->", mapped.toString());
console.log("  round-trip address ->", (await api.call.reviveApi.address(mapped)).toString());
await api.disconnect();
