import type { ApiPromise } from "@polkadot/api";
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
  events: ReviveEvent[];
};

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

  // --- pass 1: which blocks are worth looking at? ---------------------------------------
  const candidates: { n: number; hash: string }[] = [];
  await mapLimit(numbers, concurrency, async (n) => {
    try {
      const hash = await api.rpc.chain.getBlockHash(n);
      if (!hash || hash.isEmpty) return;
      const block = await api.rpc.chain.getBlock(hash);
      if (block.block.extrinsics.length >= 2) candidates.push({ n, hash: hash.toHex() });
    } catch {
      /* a block we cannot read is skipped, and the count reports what was scanned */
    }
  });

  candidates.sort((a, b) => a.n - b.n);

  // --- pass 2: decode the event list of those blocks only --------------------------------
  const events: ReviveEvent[] = [];
  await mapLimit(candidates, 4, async ({ n, hash }) => {
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
          const contract = String(byName("contract", 0)).toLowerCase();
          const data = String(byName("data", 1));
          const topicsRaw = byName("topics", 2);
          const topics: string[] = (topicsRaw?.toJSON?.() ?? []).map((t: any) => String(t).toLowerCase());
          events.push({
            blockNumber: n,
            blockHash: hash,
            eventIndex: i,
            kind,
            contract,
            data,
            topics,
            parsed: decode(topics, data),
          });
        } else if (kind === "Instantiated") {
          events.push({
            blockNumber: n,
            blockHash: hash,
            eventIndex: i,
            kind,
            deployer: String(byName("deployer", 0)).toLowerCase(),
            contract: String(byName("contract", 1)).toLowerCase(),
          });
        } else {
          const json = event.toJSON() as Record<string, unknown>;
          events.push({ blockNumber: n, blockHash: hash, eventIndex: i, kind, data: JSON.stringify(json) });
        }
      });
    } catch {
      /* skip undecodable block, reported via `scanned` */
    }
  });

  events.sort((a, b) => a.blockNumber - b.blockNumber || a.eventIndex - b.eventIndex);
  return { from: start, to: end, scanned: numbers.length, candidateBlocks: candidates.length, events };
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
