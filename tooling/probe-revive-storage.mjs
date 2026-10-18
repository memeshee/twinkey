
import { ApiPromise, WsProvider } from '@polkadot/api';
const api = await ApiPromise.create({ provider: new WsProvider('wss://test-node-v3.portaldot.dev'), noInitWarn: true });
const EOA = '0x7FCC2Fc227f16220E3c0FAa63337551234de16f3';
const NATIVE = '0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934';
for (const [label, addr] of [['EOA', EOA], ['NATIVE(mapped)', NATIVE]]) {
  const info = await api.query.revive.accountInfoOf(addr);
  const orig = await api.query.revive.originalAccount(addr);
  console.log(label, addr);
  console.log('  accountInfoOf :', info.isSome ? JSON.stringify(info.toJSON()) : 'NONE');
  console.log('  originalAccount:', orig.isSome ? orig.toJSON() : 'NONE');
}
// reverse: what does the EOA map to, and does that account exist in revive?
const acct = await api.call.reviveApi.accountId(EOA);
console.log('\nreviveApi.accountId(EOA) =', acct.toHuman());
const info2 = await api.query.revive.accountInfoOf(acct);
console.log('accountInfoOf(accountId) :', info2.isSome ? JSON.stringify(info2.toJSON()) : 'NONE');
const code = await api.call.reviveApi.code(EOA).catch(e => 'ERR ' + e.message);
console.log('code(EOA).length:', JSON.stringify(code?.toJSON?.() ?? code)?.slice(0,120));
console.log('blockGasLimit:', JSON.stringify(await api.call.reviveApi.blockGasLimit().then(r=>r.toJSON()).catch(e=>'ERR')));
console.log('gasPrice:', JSON.stringify(await api.call.reviveApi.gasPrice().then(r=>r.toJSON()).catch(e=>'ERR')));
console.log('nativeToEthRatio? query storage keys:', Object.keys(api.query.revive).length);
await api.disconnect();
