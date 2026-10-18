
import fs from 'node:fs';
import { createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const EVM_RPC = 'https://test-evm-rpc-v3.portaldot.dev';
const pk = JSON.parse(fs.readFileSync(process.env.HOME + '/.hermes/keys/twinkey-evm.json','utf8')).privateKey;
const account = privateKeyToAccount(pk);
const chain = defineChain({ id: 420420777, name: 'P', nativeCurrency:{name:'tPOT',symbol:'tPOT',decimals:18}, rpcUrls:{default:{http:[EVM_RPC]}} });
const wallet = createWalletClient({ account, chain, transport: http(EVM_RPC) });
const to = '0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934';
async function send(label, tx) {
  const raw = await wallet.signTransaction(tx);
  const r = await fetch(EVM_RPC, { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:[raw]}) });
  console.log(label, '->', JSON.stringify(await r.json()).slice(0,200));
}
// vary the tip / fee massively in case validation is unit-sensitive
await send('1559 tip=1gwei maxFee=2gwei gas=1e9', { to, value:0n, gas:1000000000n, maxFeePerGas:2000000000n, maxPriorityFeePerGas:1000000000n, nonce:0, chain });
await send('1559 tip=39805 maxFee=39805 gas=1e8', { to, value:0n, gas:100000000n, maxFeePerGas:39805n, maxPriorityFeePerGas:39805n, nonce:0, chain });
await send('legacy gasPrice=1gwei gas=1e8', { to, value:0n, gas:100000000n, gasPrice:1000000000n, nonce:0, type:'legacy' });
await send('legacy gasPrice=39805 gas=1e11', { to, value:0n, gas:100000000000n, gasPrice:39805n, nonce:0, type:'legacy' });
