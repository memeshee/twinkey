import { NextResponse } from "next/server";

import { receiptFromResolution, resolveExtrinsic } from "@/lib/twinkey/demo";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/receipt?hash=0x…[&to=0x…]
 *
 * Resolve a `revive.call` extrinsic hash to an EVM-shaped receipt, statelessly.
 * The hash a TwinKey write returns is the *extrinsic* hash, which the EVM node
 * has never seen — so the only way to answer is to find the block that contains
 * it on the Substrate side. That is what this does, and it is why the receipt
 * survives a cold start, a different lambda instance, or a browser reload.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const hash = (url.searchParams.get("hash") ?? "").trim().toLowerCase();
  const to = url.searchParams.get("to") ?? undefined;

  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    return NextResponse.json(
      { error: "hash must be 0x + 64 hex characters (an extrinsic hash, not an EVM tx hash)" },
      { status: 400 },
    );
  }

  const started = Date.now();
  try {
    const resolved = await resolveExtrinsic(hash);
    if (!resolved) {
      return NextResponse.json(
        {
          error: "not found in the scan window",
          hint: "extrinsic hashes are resolved by scanning recent blocks; older writes need ?block= on /tx/:hash",
          hash,
        },
        { status: 404 },
      );
    }
    return NextResponse.json({
      ok: true,
      receipt: receiptFromResolution(hash, resolved, to),
      resolved,
      elapsedMs: Date.now() - started,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e), hash }, { status: 503 });
  }
}
