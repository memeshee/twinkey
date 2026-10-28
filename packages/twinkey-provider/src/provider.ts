import type { ApiPromise } from "@polkadot/api";
import { PORTALDOT, nativeToWei, weiToNative } from "./config";
import { dryRunCall, evmRpc, getApi, nativeFree, resolveAccountId, resolveH160 } from "./chain";
import { decodeLog, emittedToLogs, toHex, type EvmLog, type RawContractEmitted } from "./logs";
import { TWINKEY_PROBE_ABI } from "./abi";

/**
 * The outcome of one signed native-path contract call. Kept deliberately close to what the
 * chain actually returns: an extrinsic hash and a block, not an EVM transaction.
 */
export type SubmitOutcome = {
  extrinsicHash: string;
  blockHash: string;
  blockNumber: number | null;
  ok: boolean;
  error?: string;
  /** Every `revive.ContractEmitted` produced by this extrinsic, across all contracts. */
  emitted: RawContractEmitted[];
};

/**
 * The only thing TwinKey needs from a wallet. Anything that can sign a Substrate extrinsic
 * works: the polkadot.js extension, Talisman/SubWallet, or a Keyring pair in a script.
 */
export interface TwinKeySigner {
  readonly ss58: string;
  submit(tx: any): Promise<SubmitOutcome>;
}

type Listener = (...args: any[]) => void;

export interface TwinKeyProvider {
  readonly isTwinKey: true;
  readonly chainId: string;
  readonly connected: boolean;
  request(args: { method: string; params?: any }): Promise<any>;
  on(event: string, fn: Listener): this;
  removeListener(event: string, fn: Listener): this;
}

export type ProviderOptions = {
  signer: TwinKeySigner;
  /** Optional ABI used to decode logs into `parsed` events. Defaults to TwinKeyProbe. */
  abi?: any;
  /** Override the JSON-RPC passthrough (used by tests). */
  rpc?: <T = any>(method: string, params?: any[]) => Promise<T>;
  /** Override the API getter (used by tests). */
  api?: () => Promise<ApiPromise>;
};

const rpcError = (code: number, message: string, data?: unknown) => {
  const e = new Error(message) as Error & { code: number; data?: unknown };
  e.code = code;
  if (data !== undefined) e.data = data;
  return e;
};

/** Methods forwarded verbatim to the EVM JSON-RPC: reads and simulation only. */
const PASSTHROUGH = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_estimateGas_chain",
  "web3_clientVersion",
  "web3_sha3",
  "net_listening",
  "net_peerCount",
  "eth_syncing",
  "eth_mining",
  "eth_hashrate",
  "eth_protocolVersion",
]);

/**
 * An EIP-1193 provider backed by a Substrate signer.
 *
 * Reads are served by the EVM JSON-RPC so that `viem`/`wagmi`/`ethers` see the same state a
 * normal EVM node would report. Writes cannot use that endpoint — on this build an external
 * EOA cannot send a transaction at all ("Invalid Transaction" for every type; see
 * docs/FINDINGS.md) — so a write is translated into a `revive.call` extrinsic signed by the
 * user's ss58 key, which is the only write path that works.
 */
export function createTwinKeyProvider(opts: ProviderOptions): TwinKeyProvider {
  const { signer } = opts;
  const abi = opts.abi ?? TWINKEY_PROBE_ABI;
  const rpc = opts.rpc ?? evmRpc;
  const getChain = opts.api ?? getApi;

  const listeners = new Map<string, Set<Listener>>();
  /** tx hash (extrinsic hash, aliased by block hash) -> receipt record */
  const receipts = new Map<string, any>();
  /**
   * Per-transaction log/height metadata kept OUT of the receipt object itself: receipts travel
   * over JSON-RPC, and a bigint field would make JSON.stringify throw.
   */
  const receiptMeta = new Map<string, { blockNumberBig: bigint; logs: EvmLog[] }>();
  let cachedH160: string | null = null;
  let cachedApi: ApiPromise | null = null;

  const emit = (event: string, payload: unknown) => {
    for (const fn of listeners.get(event) ?? []) {
      try {
        fn(payload);
      } catch {
        /* a bad listener must not break the provider */
      }
    }
  };

  async function api(): Promise<ApiPromise> {
    if (!cachedApi) cachedApi = await getChain();
    return cachedApi;
  }

  async function h160(): Promise<string> {
    if (!cachedH160) {
      cachedH160 = await resolveH160(await api(), signer.ss58);
      emit("accountsChanged", [cachedH160]);
    }
    return cachedH160;
  }

  function buildReceipt(rec: {
    txHash: string;
    blockHash: string;
    blockNumber: number;
    from: string;
    to: string;
    ok: boolean;
    emitted: RawContractEmitted[];
    gasUsed: bigint;
  }) {
    const logs: EvmLog[] = emittedToLogs(rec.emitted, {
      blockHash: rec.blockHash,
      blockNumber: rec.blockNumber,
      transactionHash: rec.txHash,
    }).map((l) => ({ ...l, parsed: decodeLog(l, abi) }));

    receiptMeta.set(rec.txHash, { blockNumberBig: BigInt(rec.blockNumber), logs });

    return {
      transactionHash: rec.txHash,
      transactionIndex: "0x0",
      blockHash: rec.blockHash,
      blockNumber: toHex(rec.blockNumber),
      from: rec.from,
      to: rec.to,
      cumulativeGasUsed: toHex(rec.gasUsed),
      gasUsed: toHex(rec.gasUsed),
      effectiveGasPrice: "0x0",
      contractAddress: null,
      status: rec.ok ? "0x1" : "0x0",
      type: "0x0",
      // The native path emits no bloom filter; zeros are the honest value rather than a fake.
      logsBloom: "0x" + "0".repeat(512),
      logs,
      // Extra, non-standard: this chain has no EVM explorer, so the receipt carries its own
      // provenance. `signedBy` is the ss58 key that actually signed, and `path` says how.
      twinKey: { path: rec.ok ? "revive.call" : "revive.call (reverted)", signedBy: signer.ss58, logsDecoded: logs.filter((l) => l.parsed).length },
    };
  }

  async function estimateGas(txArgs: any): Promise<string> {
    const me = await h160();
    const from = String(txArgs.from ?? me).toLowerCase();
    if (from !== me) throw rpcError(-32602, `TwinKey can only estimate for ${me}`);
    const valueWei = txArgs.value ? BigInt(txArgs.value) : 0n;
    const data = (txArgs.data ?? txArgs.input ?? "0x") as string;
    const chain = await api();

    // Plain value transfer to a non-contract: the cost is a native transfer, not a contract call.
    if (!txArgs.to || data === "0x") {
      const dest = txArgs.to ? await resolveAccountId(chain, txArgs.to) : null;
      const dry = await chain.tx.balances.transferKeepAlive(dest ?? signer.ss58, weiToNative(valueWei)).paymentInfo(signer.ss58);
      return toHex(dry.weight.refTime.toBigInt());
    }

    const dry = await dryRunCall(chain, signer.ss58, txArgs.to, weiToNative(valueWei), data);
    if (!dry.ok) throw rpcError(3, `execution reverted: ${dry.error ?? ""}`, dry.output);
    const gas = dry.gasConsumed ?? dry.weightRequired?.refTime ?? "0";
    return toHex(BigInt(gas));
  }

  async function sendTransaction(txArgs: any): Promise<string> {
    const chain = await api();
    const me = await h160();
    const from = String(txArgs.from ?? me).toLowerCase();
    if (from !== me) {
      throw rpcError(-32602, `TwinKey signs only for ${me} (your mapped address for ${signer.ss58}); got from=${from}`);
    }
    const to = txArgs.to as string | undefined;
    const data = (txArgs.data ?? txArgs.input ?? "0x") as string;
    const valueWei = txArgs.value ? BigInt(txArgs.value) : 0n;
    const nativeValue = weiToNative(valueWei);

    // --- case 1: native value transfer to a plain address -------------------------------
    // `eth_sendTransaction` to an address with no code is a transfer. Doing it through
    // revive.call would fail, so route it to balances.transferKeepAlive on the mapped account.
    if (!to || data === "0x") {
      if (!to) throw rpcError(-32602, "eth_sendTransaction without `to`: contract creation must go through revive.instantiateWithCode");
      const code = await rpc<string>("eth_getCode", [to, "latest"]);
      if (!code || code === "0x") {
        const destAccount = await resolveAccountId(chain, to);
        const tx = chain.tx.balances.transferKeepAlive(destAccount, nativeValue);
        const out = await signer.submit(tx);
        if (!out.ok) throw rpcError(-32000, out.error ?? "native transfer failed");
        const blockNumber = out.blockNumber ?? (await headerNumber(chain, out.blockHash));
        receipts.set(out.extrinsicHash, buildReceipt({ txHash: out.extrinsicHash, blockHash: out.blockHash, blockNumber, from: me, to, ok: true, emitted: [], gasUsed: 0n }));
        return out.extrinsicHash;
      }
    }

    // --- case 2: contract call through the native path -----------------------------------
    // Dry-run first: weight_limit and storage_deposit_limit are required by revive.call and the
    // chain is the only honest source for them.
    const dry = await dryRunCall(chain, signer.ss58, to!, nativeValue, data);
    if (!dry.ok) throw rpcError(3, `execution reverted: ${dry.error ?? ""}`, dry.output);
    const weight = dry.weightRequired ?? { refTime: "40000000000", proofSize: "1000000" };
    const depositLimit = BigInt(dry.storageDepositCharge || "0");

    const tx = chain.tx.revive.call(to!, nativeValue, weight, depositLimit, data);
    const out = await signer.submit(tx);
    const blockNumber = out.blockNumber ?? (await headerNumber(chain, out.blockHash));
    const gasUsed = BigInt(dry.gasConsumed ?? weight.refTime ?? "0");
    const receipt = buildReceipt({
      txHash: out.extrinsicHash,
      blockHash: out.blockHash,
      blockNumber,
      from: me,
      to: to!,
      ok: out.ok,
      emitted: out.emitted,
      gasUsed,
    });
    // The native path's id is an extrinsic hash; alias the block hash too so that anyone who
    // only ever sees `0x…` (which is what our own logs report) still gets a receipt.
    receipts.set(out.extrinsicHash, receipt);
    receipts.set(out.blockHash, receipt);
    if (!out.ok) throw rpcError(-32000, out.error ?? "revive.call failed");
    return out.extrinsicHash;
  }

  /**
   * `eth_getLogs` with local completeness.
   *
   * The EVM endpoint's log index is NOT a complete view of this chain: logs emitted by a
   * native-origin `revive.call` frequently never appear there. Verified on our own contract —
   * it emitted at blocks 90995 and 102680, and a full-range `eth_getLogs` for its address
   * returned `[]` both times, while `eth_getTransactionByHash` returns null even for
   * native-origin calls whose logs the index *does* contain.
   *
   * So we merge the endpoint's answer with the logs of every transaction this provider itself
   * submitted, and decode all of them. That makes TwinKey the only way to see a fresh log from
   * a native-path call.
   */
  async function enrichedLogs(filter: any): Promise<EvmLog[]> {
    const wantAddress = filter?.address ? String(filter.address).toLowerCase() : null;
    const from = blockBound(filter?.fromBlock);
    const to = blockBound(filter?.toBlock);

    let remote: EvmLog[] = [];
    try {
      remote = (await rpc<EvmLog[]>("eth_getLogs", [filter])) ?? [];
    } catch (e) {
      // The EVM endpoint rejects filters it cannot serve ("Failed to filter logs"). Our own
      // records are still authoritative for what this provider submitted, so keep going.
      remote = [];
    }

    const seen = new Set<string>();
    const merged: EvmLog[] = [];
    const push = (log: EvmLog) => {
      const key = `${log.transactionHash ?? "?"}:${log.logIndex}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(log);
    };

    for (const log of remote) {
      if (wantAddress && log.address?.toLowerCase() !== wantAddress) continue;
      push(log);
    }

    const scanned = new Set<string>();
    for (const [txHash, meta] of receiptMeta) {
      if (scanned.has(txHash)) continue;
      scanned.add(txHash);
      const bn = meta.blockNumberBig;
      if (from !== null && bn < from) continue;
      if (to !== null && bn > to) continue;
      for (const log of meta.logs) {
        if (wantAddress && log.address?.toLowerCase() !== wantAddress) continue;
        push(log);
      }
    }

    return merged
      .map((l) => ({ ...l, parsed: decodeLog(l, abi) }))
      .sort((a, b) => {
        const ab = BigInt(a.blockNumber ?? "0x0");
        const bb = BigInt(b.blockNumber ?? "0x0");
        if (ab !== bb) return ab < bb ? -1 : 1;
        return Number(BigInt(a.logIndex)) - Number(BigInt(b.logIndex));
      });
  }

  const provider: TwinKeyProvider = {
    isTwinKey: true,
    chainId: PORTALDOT.evmChainIdHex,
    get connected() {
      return true;
    },

    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return this;
    },

    removeListener(event, fn) {
      listeners.get(event)?.delete(fn);
      return this;
    },

    async request({ method, params }: { method: string; params?: any }) {
      // read-only passthrough ------------------------------------------------
      if (PASSTHROUGH.has(method)) return rpc(method, params ?? []);

      switch (method) {
        case "eth_chainId":
          return PORTALDOT.evmChainIdHex;

        case "net_version":
          return String(PORTALDOT.evmChainId);

        case "eth_accounts":
        case "eth_requestAccounts": {
          const addr = await h160();
          emit("connect", { chainId: PORTALDOT.evmChainIdHex });
          return [addr];
        }

        case "eth_getLogs":
          return enrichedLogs((params ?? [])[0] ?? {});

        case "eth_estimateGas":
          return estimateGas((params ?? [])[0] ?? {});

        case "eth_sendTransaction":
          return sendTransaction((params ?? [])[0] ?? {});

        case "eth_getTransactionReceipt": {
          const hash = String((params ?? [])[0] ?? "").toLowerCase();
          const own = receipts.get(hash);
          if (own) return own;
          return rpc("eth_getTransactionReceipt", [hash]);
        }

        case "eth_getTransactionByHash": {
          const hash = String((params ?? [])[0] ?? "").toLowerCase();
          const own = receipts.get(hash);
          if (!own) return rpc("eth_getTransactionByHash", [hash]);
          return {
            hash,
            blockHash: own.blockHash,
            blockNumber: own.blockNumber,
            from: own.from,
            to: own.to,
            value: "0x0",
            // The native path is not an EVM transaction; report the input it carried where we can.
            input: "0x",
            nonce: "0x0",
            transactionIndex: "0x0",
            gas: own.gasUsed,
            gasPrice: "0x0",
            type: "0x0",
            twinKey: own.twinKey,
          };
        }

        case "eth_sendRawTransaction":
          throw rpcError(-32601, "TwinKey signs Substrate extrinsics, not raw EVM transactions. Signing a raw secp256k1 tx requires the EVM write path, which this testnet build rejects (see docs/FINDINGS.md).");

        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;

        case "wallet_requestPermissions":
          return [{ parentCapability: "eth_accounts" }];

        // --- TwinKey extras (non-standard, prefixed so they cannot collide) ---------------
        case "twinkey_identity": {
          const chain = await api();
          const addr = await h160();
          const free = await nativeFree(chain, signer.ss58);
          return {
            ss58: signer.ss58,
            h160: addr,
            nativeFree: free.toString(),
            nativeFreeFormatted: (Number(free) / 1e14).toFixed(4),
            evmBalanceWei: nativeToWei(free).toString(),
            chainId: PORTALDOT.evmChainId,
            mappingSource: "reviveApi.address (chain runtime API)",
          };
        }

        case "twinkey_dryRun": {
          const [to, data, valueWei] = params as [string, string, string?];
          const chain = await api();
          const dry = await dryRunCall(chain, signer.ss58, to, weiToNative(BigInt(valueWei ?? "0")), data);
          return dry;
        }

        default:
          throw rpcError(-32601, `TwinKey does not implement ${method}`);
      }
    },
  };

  return provider;
}

async function headerNumber(api: ApiPromise, blockHash: string): Promise<number> {
  const header = await api.rpc.chain.getHeader(blockHash);
  return header.number.toNumber();
}

/** Parse a block tag from a log filter. `null` means unbounded. */
function blockBound(tag: unknown): bigint | null {
  if (tag === undefined || tag === null || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") {
    return null;
  }
  if (tag === "earliest") return 0n;
  try {
    return BigInt(tag as string);
  } catch {
    return null;
  }
}
