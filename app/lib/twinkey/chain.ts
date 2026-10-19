import { ApiPromise, WsProvider } from "@polkadot/api";
import { decodeAddress } from "@polkadot/util-crypto";
import { PORTALDOT } from "./config";

/**
 * One shared connection per tab. WsProvider reconnects on its own; we only memoise the
 * promise so parallel callers do not open competing sockets.
 */
let apiPromise: Promise<ApiPromise> | null = null;

export function getApi(ws: string = PORTALDOT.substrateWs): Promise<ApiPromise> {
  if (!apiPromise) {
    apiPromise = ApiPromise.create({
      provider: new WsProvider(ws),
      noInitWarn: true,
      throwOnConnect: true,
    }).catch((e) => {
      apiPromise = null;
      throw e;
    });
  }
  return apiPromise;
}

export function resetApi(): void {
  apiPromise = null;
}

/** Raw JSON-RPC against the EVM endpoint. It is CORS-open (access-control-allow-origin: *). */
export async function evmRpc<T = any>(method: string, params: any[] = []): Promise<T> {
  const res = await fetch(PORTALDOT.evmRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`EVM RPC ${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`EVM RPC ${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result as T;
}

/**
 * Resolve the H160 that the runtime maps an ss58 account to.
 *
 * This MUST come from the chain. The mapping is not a truncation or a hash of the public key —
 * see docs/VERIFIED-FACTS.md. A client that derives it locally produces the wrong address, and
 * the wrong address on this chain is how funds get lost.
 */
export async function resolveH160(api: ApiPromise, account: string | Uint8Array): Promise<string> {
  // Accept either ss58 text or raw 32-byte public key. Decode to bytes first: the runtime API
  // wants an AccountId32, and passing bytes avoids any guess about how a string gets typed.
  const bytes = typeof account === "string" ? decodeAddress(account) : account;
  const h160 = await (api.call as any).reviveApi.address(bytes);
  return String(h160).toLowerCase();
}

/** Reverse direction: the native AccountId32 the runtime associates with an H160. */
export async function resolveAccountId(api: ApiPromise, h160: string): Promise<string> {
  const acct = await (api.call as any).reviveApi.accountId(h160);
  return String(acct);
}

export type DryRunResult = {
  ok: boolean;
  /** What the chain says the call costs. Unused weight is refunded, so this is a cap, not a fee. */
  weightRequired: { refTime: string; proofSize: string } | null;
  storageDepositCharge: string;
  gasConsumed: string | null;
  output: string | null;
  error: string | null;
};

/**
 * Dry-run a contract call through the runtime API (`ReviveApi_call`), which is the ONLY
 * trustworthy cost source on this build. `eth_estimateGas` on the EVM endpoint returns values
 * in the 10^11..10^15 range for trivial calls and the block advertises gasLimit = u64::MAX, so
 * anything that auto-fills gas from it builds a transaction no balance can pay for.
 */
export async function dryRunCall(
  api: ApiPromise,
  origin: string,
  dest: string,
  valueNative: bigint,
  data: string,
): Promise<DryRunResult> {
  const dry = await (api.call as any).reviveApi.call(origin, dest, valueNative, null, null, data);
  const j = dry.toJSON() as any;
  const weight = j.weightRequired ?? j.weight_required ?? null;
  const storage = j.storageDeposit ?? j.storage_deposit ?? {};
  const result = j.result ?? {};
  const okFlag = result.ok ?? result.Ok;
  const isOk = okFlag !== undefined && okFlag !== null;
  return {
    ok: isOk,
    weightRequired: weight
      ? { refTime: String(weight.refTime ?? weight.ref_time), proofSize: String(weight.proofSize ?? weight.proof_size) }
      : null,
    storageDepositCharge: String(storage.charge ?? storage.Charge ?? 0),
    gasConsumed: j.gasConsumed ?? j.gas_consumed ?? null,
    output: isOk && typeof okFlag === "string" ? okFlag : null,
    error: isOk ? null : JSON.stringify(result).slice(0, 400),
  };
}

/** Native free balance of an account, in 14-decimal base units. */
export async function nativeFree(api: ApiPromise, account: string): Promise<bigint> {
  const info = (await api.query.system.account(account)) as any;
  return BigInt(info.data.free.toString());
}
