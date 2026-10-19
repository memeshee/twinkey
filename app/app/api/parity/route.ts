import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VERIFIER = process.env.TWINKEY_VERIFIER_URL ?? "http://127.0.0.1:8088";

/**
 * GET /api/parity?block=90995   -> the Rust verifier's parity verdict for that block
 * GET /api/parity?tx=0x…        -> the Rust verifier's report for a block hash or extrinsic hash
 *
 * The verifier is a separate process with its own RPC readers, so its answer does not share a code
 * path with the browser or with the Next server. If it is not running the route says so instead of
 * pretending — the app degrades to "no independent verdict available", never to a made-up one.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const block = url.searchParams.get("block");
  const tx = url.searchParams.get("tx");
  const mode = url.searchParams.get("mode");

  const target = block
    ? `${VERIFIER}/${mode === "report" ? "verify/block" : "parity"}/${encodeURIComponent(block)}`
    : tx
      ? `${VERIFIER}/verify/tx/${encodeURIComponent(tx)}`
      : null;

  if (!target) return NextResponse.json({ error: "pass ?block= or ?tx=" }, { status: 400 });

  try {
    const res = await fetch(target, { cache: "no-store", signal: AbortSignal.timeout(55_000) });
    const body = await res.json().catch(() => ({ raw: "unparseable response" }));
    return NextResponse.json(
      { available: true, verifier: VERIFIER, status: res.status, ...body },
      { status: res.ok ? 200 : res.status },
    );
  } catch (e: any) {
    return NextResponse.json(
      {
        available: false,
        verifier: VERIFIER,
        error: "the independent verifier is not reachable",
        hint: "start it with `cd agent && cargo run --release` (port 8088) or set TWINKKEY_VERIFIER_URL",
        detail: String(e?.message ?? e),
      },
      { status: 503 },
    );
  }
}
