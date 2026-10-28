import { NextResponse } from "next/server";
import { decodeLog } from "@/lib/twinkey/logs";
import { scanRange } from "@/lib/twinkey/scan";
import { TWINKEY_PROBE_ABI } from "@/lib/twinkey/abi";
import { memo, withDeadline } from "@/lib/twinkey/chain";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/events?lookback=300  — scan the last N blocks for revive events
 * GET /api/events?from=90990&to=90995 — scan an explicit range
 *
 * Reads the Substrate event stream, not the EVM log index, because the EVM log index drops
 * logs emitted by native-origin calls (see lib/twinkey/scan.ts).
 *
 * A 300-block scan is ~7 s of upstream round trips, which is too close to a
 * serverless timeout to spend twice: ranges are cached for 20 s, and the work has
 * a hard deadline so the caller gets a labelled error rather than a dead request.
 */
async function run(fromParam: number | null, lookback: number, toParam: number | null) {
  return withDeadline(
    (async () => {
      const { getApi } = await import("@/lib/twinkey/chain");
      const api = await getApi();
      const head = (await api.rpc.chain.getHeader()).number.toNumber();

      const from = fromParam === null ? Math.max(0, head - lookback) : fromParam;
      const to = toParam === null ? head : toParam;

      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) {
        throw new Error("invalid range");
      }
      if (to - from > 1200) {
        throw new Error("range too wide: max 1200 blocks per query");
      }

      const decode = (topics: string[], data: string) =>
        decodeLog({ topics: topics as any, data: data as `0x${string}` }, TWINKEY_PROBE_ABI);

      const result = await scanRange(from, to, decode);
      return { head, ...result };
    })(),
    40_000,
    "event scan",
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lookback = Number(url.searchParams.get("lookback") ?? "300");
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  const from = fromParam !== null ? Number(fromParam) : null;
  const to = toParam !== null ? Number(toParam) : null;

  if ((from !== null && !Number.isFinite(from)) || (to !== null && !Number.isFinite(to))) {
    return NextResponse.json({ error: "invalid range" }, { status: 400 });
  }
  if (from !== null && to !== null && to - from > 1200) {
    return NextResponse.json({ error: "range too wide: max 1200 blocks per query" }, { status: 400 });
  }

  const cached = memo(() => run(from, lookback, to), 20_000);
  try {
    const { value, cached: hit } = await cached(`events:${from ?? "L" + lookback}:${to ?? "head"}`);
    return NextResponse.json({ ...value, cached: hit });
  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message ?? e), hint: "narrow the range (?lookback=120) and retry" },
      { status: 503 },
    );
  }
}
