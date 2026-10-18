// Validate the EVM (MetaMask-equivalent) path from the official guide, end to end,
// with a locally generated EOA — no browser extension involved:
//   1. generate a secp256k1 key
//   2. resolve its mapped Substrate account with reviveApi.accountId
//   3. fund that mapped account from our ss58 account
//   4. deploy + call the contract over the EVM JSON-RPC with viem
// Usage: node evm-path.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { cryptoWaitReady, encodeAddress } from '@polkadot/util-crypto';
import {
  createPublicClient, createWalletClient, http, defineChain,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const ENDPOINT = process.env.PORTALDOT_WS ?? 'wss://test-node-v3.portaldot.dev';
const EVM_RPC = process.env.PORTALDOT_EVM ?? 'https://test-evm-rpc-v3.portaldot.dev';
const SUB_KEY = process.env.PORTALDOT_KEY ?? path.join(os.homedir(), '.hermes/keys/portaldot-testnet.json');
const EVM_KEY = path.join(os.homedir(), '.hermes/keys/twinkey-evm.json');
const ART = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../contracts/build/TwinKeyProbe.json'), 'utf8'));
const FUND = 20n * 10n ** 14n; // 20 tPOT, native 14-decimal base units

const chain = defineChain({
  id: 420420777,
  name: 'PortaldotV3 Testnet',
  nativeCurrency: { name: 'tPOT', symbol: 'tPOT', decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC] } },
});

await cryptoWaitReady();

// 1. EOA
let pk;
if (fs.existsSync(EVM_KEY)) {
  pk = JSON.parse(fs.readFileSync(EVM_KEY, 'utf8')).privateKey;
  console.log('reusing EOA key from', EVM_KEY);
} else {
  pk = generatePrivateKey();
  fs.writeFileSync(EVM_KEY, JSON.stringify({ createdAt: new Date().toISOString(), privateKey: pk }, null, 2), { mode: 0o600 });
  console.log('generated EOA key at', EVM_KEY);
}
const account = privateKeyToAccount(pk);
console.log('EOA (H160)   :', account.address);

const pub = createPublicClient({ chain, transport: http(EVM_RPC) });
const wallet = createWalletClient({ account, chain, transport: http(EVM_RPC) });

// 2. mapped substrate account
const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });
const mapped = await api.call.reviveApi.accountId(account.address);
const mappedSs58 = encodeAddress(mapped, 42);
console.log('mapped ss58  :', mappedSs58, '(via reviveApi.accountId)');

let bal = await pub.getBalance({ address: account.address });
console.log('EOA balance  :', Number(bal) / 1e18, 'tPOT');

// 3. fund the mapped account if needed
if (bal < FUND / 10n) {
  await cryptoWaitReady();
  const key = JSON.parse(fs.readFileSync(SUB_KEY, 'utf8'));
  const pair = new Keyring({ type: key.crypto ?? 'sr25519', ss58Format: 42 }).addFromUri(key.secretUri ?? key.mnemonic);
  console.log(`\nfunding ${mappedSs58} with 20 tPOT from ${pair.address} …`);
  const hash = await new Promise(async (resolve, reject) => {
    const unsub = await api.tx.balances.transferKeepAlive(mappedSs58, FUND).signAndSend(pair, ({ status, dispatchError }) => {
      if (dispatchError) reject(new Error(dispatchError.toString()));
      if (status.isInBlock || status.isFinalized) { unsub?.(); resolve((status.isInBlock ? status.asInBlock : status.asFinalized).toHex()); }
    });
  });
  console.log('funded in block:', hash);
  bal = await pub.getBalance({ address: account.address });
  console.log('EOA balance  :', Number(bal) / 1e18, 'tPOT  ← the mapping works as the guide describes');
}

// 4. deploy with plain viem (what Remix/MetaMask does under the hood)
const ABI = ART.abi;
// NOTE: eth_estimateGas on this chain is inflated by ~10^7 and the block gas limit is
// u64::MAX, so letting viem/MetaMask auto-fill gas produces an "Invalid Transaction"
// (the max cost exceeds any balance). We set the limit explicitly. See docs/FINDINGS.md.
const GAS = BigInt(process.env.PORTALDOT_GAS ?? 1_000_000_000n);
const deployHash = await wallet.deployContract({ abi: ABI, bytecode: ART.bytecode, args: [], gas: GAS });
console.log('\ndeploy tx    :', deployHash);
const receipt = await pub.waitForTransactionReceipt({ hash: deployHash });
console.log('contract     :', receipt.contractAddress, 'status:', receipt.status);

const read1 = await pub.readContract({ address: receipt.contractAddress, abi: ABI, functionName: 'read' });
console.log('read before  :', read1[0].toString(), read1[1], read1[2].toString());

const callHash = await wallet.writeContract({
  address: receipt.contractAddress, abi: ABI, functionName: 'setValue', args: [123n], gas: GAS,
});
const r2 = await pub.waitForTransactionReceipt({ hash: callHash });
console.log('call tx      :', callHash, 'status:', r2.status, 'logs:', r2.logs.length);

const read2 = await pub.readContract({ address: receipt.contractAddress, abi: ABI, functionName: 'read' });
console.log('read after   :', read2[0].toString(), read2[1], read2[2].toString());
console.log('caller match :', read2[1].toLowerCase() === account.address.toLowerCase() ? 'YES' : 'no');

await api.disconnect();
