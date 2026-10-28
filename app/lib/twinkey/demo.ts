import fs from "node:fs";

import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";

import { evmRpc, getApi, withDeadline } from "./chain";
import { createTwinKeyProvider, type TwinKeyProvider } from "./provider";
import { keyringSigner } from "./signers";

/**
 * The demo signer: a throwaway sr25519 account whose secret lives in the
 * deployment environment, used only so a judge without a Substrate extension can
 * watch a real `revive.call` land. It is never the project key, it is funded with
 * a few testnet tPOT, and every route that touches it is rate limited.
 */
export type DemoContext = {
  ss58: string;
  h160: string;
  provider: TwinKeyProvider;
};

export const demoEnabled = (): boolean =>
  Boolean(process.env.PORTALDOT_KEY || process.env.PORTALDOT_SECRET_URI);

export async function demoContext(): Promise<DemoContext> {
  const keyPath = process.env.PORTALDOT_KEY;
  const secretUri = process.env.PORTALDOT_SECRET_URI;
  if (!keyPath && !secretUri) {
    throw new Error(
      "demo signing disabled: set PORTALDOT_KEY (key file path) or PORTALDOT_SECRET_URI to enable a server-side write",
    );
  }

  await cryptoWaitReady();
  let uri = secretUri;
  let crypto = "sr25519";
  if (!uri && keyPath) {
    const key = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    uri = key.secretUri ?? key.mnemonic;
    crypto = key.crypto ?? "sr25519";
  }
  const pair = new Keyring({ type: crypto as any, ss58Format: 42 }).addFromUri(uri!);

  const api = await getApi();
  const provider = createTwinKeyProvider({ signer: keyringSigner(api, pair) });
  const [h160] = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  return { ss58: pair.address, h160, provider };
}

/** `eth_call` straight off the EVM endpoint: works even when the socket is down. */
export async function evmCall(to: string, data: string, block: string | number = "latest"): Promise<string> {
  const tag = typeof block === "number" ? "0x" + block.toString(16) : block;
  return evmRpc<string>("eth_call", [{ to, data }, tag]);
}

export type SubmitResult = {
  txHash: string;
  receipt: any | null;
  pending: boolean;
  elapsedMs: number;
  stateAfter?: string | null;
  note?: string;
};

/**
 * One contract call through the demo signer, with the two failure modes a
 * serverless host creates handled explicitly:
 *
 *  - the write takes longer than the request budget → return the hash, marked
 *    `pending`, instead of a 500 for a transaction that is already in a block;
 *  - the socket dies mid-flight → surfaced as a labelled error by `withDeadline`.
 */
export async function submitDemoCall(opts: {
  to: string;
  data: string;
  valueWei?: string;
  submitBudgetMs?: number;
  receiptBudgetMs?: number;
}): Promise<SubmitResult> {
  const { to, data, valueWei = "0x0", submitBudgetMs = 40_000, receiptBudgetMs = 12_000 } = opts;
  const { h160, provider } = await demoContext();
  const started = Date.now();

  const txHash = (await withDeadline(
    provider.request({
      method: "eth_sendTransaction",
      params: [{ from: h160, to, data, value: valueWei }],
    }),
    submitBudgetMs,
    "revive.call submit",
  )) as string;

  try {
    const receipt = await withDeadline(
      provider.request({ method: "eth_getTransactionReceipt", params: [txHash] }),
      receiptBudgetMs,
      "receipt",
    );
    return { txHash, receipt, pending: false, elapsedMs: Date.now() - started };
  } catch {
    return {
      txHash,
      receipt: null,
      pending: true,
      elapsedMs: Date.now() - started,
      note: "submitted — the receipt did not arrive inside this request. The transaction is on chain; reload the event feed for the proof.",
    };
  }
}

/** Per-IP fixed window. Lives on `globalThis` so a warm lambda keeps the window. */
export function rateLimited(ip: string, max = 3, windowMs = 60_000): boolean {
  const store: Map<string, number[]> = ((globalThis as any).__twinkeyHits ??= new Map());
  const now = Date.now();
  const recent = (store.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    store.set(ip, recent);
    return true;
  }
  recent.push(now);
  store.set(ip, recent);
  return false;
}

export const clientIp = (req: Request): string =>
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

/**
 * Resolve an extrinsic hash to the block that contains it.
 *
 * A `revive.call` write returns the hash of the *extrinsic*, which the EVM node
 * has never heard of — so any client that polls `eth_getTransactionReceipt` after
 * a write needs somebody to do this lookup. On one lambda instance the receipt is
 * in memory; across instances (or after a cold start) it is not, and a hash scan
 * is the only honest answer. Blocks with fewer than two extrinsics cannot contain
 * our call (they hold only the timestamp set), so they are skipped without a
 * second round trip.
 */
export async function resolveExtrinsic(
  hash: string,
  lookback = 120,
): Promise<{ blockNumber: number; blockHash: string; index: number; events: any[] } | null> {
  const { withApi } = await import("./chain");
  const { blake2AsHex } = await import("@polkadot/util-crypto");
  const want = hash.toLowerCase();

  return withApi(async (api) => {
    const head = (await api.rpc.chain.getHeader()).number.toNumber();
    for (let n = head; n > Math.max(0, head - lookback); n--) {
      const blockHash = await api.rpc.chain.getBlockHash(n);
      const block = await api.rpc.chain.getBlock(blockHash);
      const exts = block.block.extrinsics;
      if (exts.length < 2) continue;
      for (let i = 0; i < exts.length; i++) {
        if (blake2AsHex(exts[i].toU8a()).toLowerCase() !== want) continue;
        const events = await api.query.system.events.at(blockHash);
        const picked: any[] = [];
        let eventIndex = 0;
        for (const record of events as any) {
          const ev = record.event;
          if (ev.section.toLowerCase() === "revive" && ev.method === "ContractEmitted") {
            const fields = ev.meta?.fields ?? [];
            const get = (name: string, idx: number) => {
              const k = fields.findIndex((f: any) => f.name?.isSome && f.name.unwrap().toString() === name);
              return ev.data[k >= 0 ? k : idx];
            };
            picked.push({
              contract: String(get("contract", 0)),
              data: String(get("data", 1)),
              topics: (get("topics", 2)?.toJSON?.() ?? []).map((t: any) => String(t)),
              eventIndex,
            });
          }
          eventIndex++;
        }
        return { blockNumber: n, blockHash: blockHash.toHex(), index: i, events: picked };
      }
    }
    return null;
  });
}

/**
 * A receipt shaped like the EVM one, built from Substrate-side evidence.
 *
 * viem's `waitForTransactionReceipt` is picky: it wants `status`, `logs` with
 * topics and data, and matching block fields. The log entries come from
 * `revive.ContractEmitted`, the event that carries the EVM log \u2014 the EVM
 * endpoint's own log index does not include native-origin calls at all.
 */
export function receiptFromResolution(
  hash: string,
  resolved: { blockNumber: number; blockHash: string; index: number; events: any[] },
  to?: string,
) {
  const hexBlock = "0x" + resolved.blockNumber.toString(16);
  return {
    transactionHash: hash.toLowerCase(),
    transactionIndex: "0x" + resolved.index.toString(16),
    blockHash: resolved.blockHash,
    blockNumber: hexBlock,
    to,
    cumulativeGasUsed: "0x0",
    gasUsed: "0x0",
    effectiveGasPrice: "0x0",
    contractAddress: null,
    status: "0x1",
    type: "0x0",
    logs: resolved.events.map((e: any, i: number) => ({
      address: e.contract,
      topics: e.topics,
      data: e.data,
      blockNumber: hexBlock,
      blockHash: resolved.blockHash,
      transactionHash: hash.toLowerCase(),
      transactionIndex: "0x" + resolved.index.toString(16),
      logIndex: "0x" + i.toString(16),
      removed: false,
    })),
    /** not part of an EVM receipt: where this answer came from */
    twinKey: {
      source: "substrate archive (extrinsic hash resolved by scanning blocks)",
      blockNumber: resolved.blockNumber,
      extrinsicIndex: resolved.index,
      nativePath: true,
    },
  };
}
