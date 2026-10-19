import { NextResponse } from "next/server";
import { decodeLog } from "@/lib/twinkey/logs";
import { scanRange } from "@/lib/twinkey/scan";
import { TWINKEY_PROBE_ABI } from "@/lib/twinkey/abi";
import { getApi } from "@/lib/twinkey/chain";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/events?lookback=300  — scan the last N blocks for revive events
 * GET /api/events?from=90990&to=90995 — scan an explicit range
 *
 * Reads the Substrate event stream, not the EVM log index, because the EVM log index drops
 * logs emitted by native-origin calls (see lib/twinkey/scan.ts).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  try {
    const api = await getApi();
    const head = (await api.rpc.chain.getHeader()).number.toNumber();

    const lookback = Number(url.searchParams.get("lookback") ?? "240");
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");

    const from = fromParam ? Number(fromParam) : Math.max(0, head - lookback);
    const to = toParam ? Number(toParam) : head;

    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) {
      return NextResponse.json({ error: "invalid range" }, { status: 400 });
    }
    if (to - from > 1200) {
      return NextResponse.json({ error: "range too wide: max 1200 blocks per query" }, { status: 400 });
    }

    const decode = (topics: string[], data: string) =>
      decodeLog({ topics: topics as any, data: data as `0x${string}` }, TWINKEY_PROBE_ABI);

    const result = await scanRange(from, to, decode);
    return NextResponse.json({ head, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 503 });
  }
}
