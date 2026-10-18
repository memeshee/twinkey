
import fs from 'node:fs';
import { createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const EVM_RPC = 'https://test-evm-rpc-v3.portaldot.dev';
const pk = JSON.parse(fs.readFileSync(process.env.HOME + '/.hermes/keys/twinkey-evm.json','utf8')).privateKey;
const account = privateKeyToAccount(pk);
const chain = defineChain({ id: 420420777, name: 'PortaldotV3', nativeCurrency: {name:'tPOT',symbol:'tPOT',decimals:18}, rpcUrls: { default: { http: [EVM_RPC] } } });
const wallet = createWalletClient({ account, chain, transport: http(EVM_RPC) });

async function send(label, tx) {
  try {
    const raw = await wallet.signTransaction(tx);
    const r = await fetch(EVM_RPC, { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:[raw]}) });
    const j = await r.json();
    console.log(label, '->', JSON.stringify(j).slice(0, 300));
  } catch (e) { console.log(label, 'sign error:', String(e).slice(0,200)); }
}
const to = '0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934';
await send('legacy 21k gas, 1e7 wei value', { to, value: 10000000000000n, gas: 21000n, gasPrice: 50000n, type: 'legacy', nonce: 0 });
await send('legacy 1e8 gas', { to, value: 10000000000000n, gas: 100000000n, gasPrice: 50000n, type: 'legacy', nonce: 0 });
await send('legacy 5e7 gas, nonce 0', { to, value: 0n, gas: 50000000n, gasPrice: 50000n, type: 'legacy', nonce: 0 });
