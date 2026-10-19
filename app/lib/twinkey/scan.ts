import { getApi } from "./chain";

/**
 * Find every EVM-side thing that happened in a block range.
 *
 * Why not `eth_getLogs`? Because the EVM endpoint's log index is incomplete for this chain: it
 * omits logs emitted by native-origin `revive.call` — verified against our own contract, which
 * emitted at blocks 90995 and 102680 and appears in a full-range query exactly zero times.
 * The Substrate event stream has no such hole, so this reads that instead.
 *
 * The first pass is cheap: a block with no user activity carries a single extrinsic (the
 * timestamp set). Only blocks with two or more extrinsics are worth decoding, which keeps the
 * metadata round-trips down to a handful per range.
 */
export type ReviveEvent = {
  blockNumber: number;
  blockHash: string;
  eventIndex: number;
  kind: "Instantiated" | "ContractEmitted" | "EthExtrinsicRevert" | string;
  contract?: string;
  deployer?: string;
  data?: string;
  topics?: string[];
  /** decoded against the caller's ABI when the topics match */
  parsed?: { eventName: string; args: Record<string, unknown> } | null;
};

export type ScanResult = {
  from: number;
  to: number;
  scanned: number;
  candidateBlocks: number;
  cacheHits: number;
  events: ReviveEvent[];
};

type CachedBlock = { hash: string | null; events: ReviveEvent[] };

/**
 * Blocks are immutable, so a block examined once never needs examining again. On a serverless host
 * the same instance serves several requests, and a rescan of the last 300 blocks drops to zero round
 * trips for the part that was already seen.
 */
const blockCache = new Map<number, CachedBlock>();
const CACHE_LIMIT = 20_000;

function remember(n: number, value: CachedBlock) {
  if (blockCache.size >= CACHE_LIMIT) {
    // Drop the oldest quarter rather than letting the map grow without bound.
    const drop = Math.floor(CACHE_LIMIT / 4);
    let i = 0;
    for (const key of blockCache.keys()) {
      blockCache.delete(key);
      if (++i >= drop) break;
    }
  }
  blockCache.set(n, value);
}

export async function scanRange(
  from: number,
  to: number,
  decode: (topics: string[], data: string) => { eventName: string; args: Record<string, unknown> } | null,
  concurrency = 24,
): Promise<ScanResult> {
  const api = await getApi();
  const head = (await api.rpc.chain.getHeader()).number.toNumber();
  const start = Math.max(0, Math.min(from, head));
  const end = Math.max(start, Math.min(to, head));

  const numbers: number[] = [];
  for (let n = start; n <= end; n++) numbers.push(n);

  const events: ReviveEvent[] = [];
  const pending: { n: number; hash: string }[] = [];
  let candidateBlocks = 0;
  let cacheHits = 0;

  // --- pass 1: reuse what we already know, and shortlist new candidate blocks -----------
  await mapLimit(numbers, concurrency, async (n) => {
    const hit = blockCache.get(n);
    if (hit) {
      cacheHits++;
      if (hit.events.length) {
        candidateBlocks++;
        events.push(...hit.events);
      }
      return;
    }
    try {
      const hash = await api.rpc.chain.getBlockHash(n);
      if (!hash || hash.isEmpty) {
        remember(n, { hash: null, events: [] });
        return;
      }
      const block = await api.rpc.chain.getBlock(hash);
      if (block.block.extrinsics.length >= 2) {
        pending.push({ n, hash: hash.toHex() });
      } else {
        remember(n, { hash: null, events: [] });
      }
    } catch {
      /* a block we cannot read is skipped; `scanned` still reports the range covered */
    }
  });

  // --- pass 2: decode only the shortlisted blocks --------------------------------------
  pending.sort((a, b) => a.n - b.n);
  candidateBlocks += pending.length;

  await mapLimit(pending, 4, async ({ n, hash }) => {
    const decoded: ReviveEvent[] = [];
    try {
      const apiAt = await api.at(hash);
      const records = (await apiAt.query.system.events()) as any;
      records.forEach((record: any, i: number) => {
        const { event } = record;
        if (event.section !== "revive") return;
        const fields = event.meta?.fields ?? [];
        const byName = (name: string, idx: number) => {
          const j = fields.findIndex((f: any) => f.name?.isSome && f.name.unwrap().toString() === name);
          return event.data[j >= 0 ? j : idx];
        };
        const kind = event.method as ReviveEvent["kind"];
        if (kind === "ContractEmitted") {
          const topics: string[] = (byName("topics", 2)?.toJSON?.() ?? []).map((t: any) => String(t).toLowerCase());
          const data = String(byName("data", 1));
          decoded.push({
            blockNumber: n,
            blockHash: hash,
            eventIndex: i,
            kind,
            contract: String(byName("contract", 0)).toLowerCase(),
            data,
            topics,
            parsed: decode(topics, data),
          });
        } else if (kind === "Instantiated") {
          decoded.push({
            blockNumber: n,
            blockHash: hash,
            eventIndex: i,
            kind,
            deployer: String(byName("deployer", 0)).toLowerCase(),
            contract: String(byName("contract", 1)).toLowerCase(),
          });
        } else {
          decoded.push({
            blockNumber: n,
            blockHash: hash,
            eventIndex: i,
            kind,
            data: JSON.stringify(event.toJSON()),
          });
        }
      });
      remember(n, { hash, events: decoded });
      events.push(...decoded);
    } catch {
      /* leave the block uncached so a later request retries it */
    }
  });

  events.sort((a, b) => a.blockNumber - b.blockNumber || a.eventIndex - b.eventIndex);
  return { from: start, to: end, scanned: numbers.length, candidateBlocks, cacheHits, events };
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}
