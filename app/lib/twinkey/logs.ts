import { decodeEventLog, type Abi } from "viem";

/**
 * `revive.ContractEmitted` is how an EVM log leaves the contract and reaches the outside world
 * on pallet-revive. It carries the contract address, the raw log data and the topics — but
 * nothing on this chain decodes them. Every indexer in the field stores `topics[]`/`data` as
 * opaque hex. That is the gap TwinKey fills here.
 */
export type RawContractEmitted = {
  contract: string;
  data: string;
  topics: string[];
};

/** An EVM-shaped log object, JSON-RPC compatible. */
export type EvmLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string | null;
  blockHash: string | null;
  transactionHash: string | null;
  transactionIndex: string;
  logIndex: string;
  removed: boolean;
  /** Non-standard: the decoded event, when a supplied ABI matches topic0. */
  parsed?: { eventName: string; args: Record<string, unknown> } | null;
};

export function toHex(n: number | bigint): string {
  return "0x" + BigInt(n).toString(16);
}

/**
 * Turn the events of one extrinsic into EVM logs. Indexes are assigned per transaction, which is
 * what `logIndex` means — they restart at 0 for each call.
 */
export function emittedToLogs(
  emitted: RawContractEmitted[],
  ctx: { blockHash?: string | null; blockNumber?: number | bigint | null; transactionHash?: string | null },
): EvmLog[] {
  return emitted.map((e, i) => ({
    address: e.contract.toLowerCase(),
    topics: e.topics,
    data: e.data,
    blockNumber: ctx.blockNumber === null || ctx.blockNumber === undefined ? null : toHex(ctx.blockNumber),
    blockHash: ctx.blockHash ?? null,
    transactionHash: ctx.transactionHash ?? null,
    transactionIndex: "0x0",
    logIndex: toHex(i),
    removed: false,
  }));
}

/**
 * Decode a log against an ABI. Returns null instead of throwing: a provider must never break a
 * caller because it does not have the right ABI for someone else's contract.
 */
export function decodeLog(
  log: Pick<EvmLog, "topics" | "data">,
  abi: Abi | readonly any[],
): { eventName: string; args: Record<string, unknown> } | null {
  try {
    const decoded = decodeEventLog({
      abi: abi as Abi,
      data: log.data as `0x${string}`,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      strict: false,
    }) as unknown as { eventName: string; args: Record<string, unknown> };
    return { eventName: decoded.eventName, args: normaliseArgs(decoded.args) };
  } catch {
    return null;
  }
}

/** bigint does not survive JSON.stringify — stringify for transport, keep precision. */
function normaliseArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    out[k] = typeof v === "bigint" ? v.toString() : v;
  }
  return out;
}
