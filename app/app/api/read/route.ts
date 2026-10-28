import { NextResponse } from "next/server";

import { evmCall } from "@/lib/twinkey/demo";
import { evmRpc } from "@/lib/twinkey/chain";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/read  { to, data, block? }
 *
 * A pure `eth_call` passthrough on the EVM endpoint — no socket, no signer, no
 * Substrate involvement. That asymmetry is the point of the product: reads are
 * ordinary EVM reads, and only writes need the native key.
 */
export async function POST(req: Request) {
  let body: { to?: string; data?: string; block?: string | number } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON: { to, data }" }, { status: 400 });
  }

  const to = String(body.to ?? "").trim().toLowerCase();
  const data = String(body.data ?? "0x").trim();
  if (!/^0x[0-9a-f]{40}$/.test(to)) {
    return NextResponse.json({ error: `to must be a 20-byte address, got '${body.to ?? ""}'` }, { status: 400 });
  }
  if (!/^0x([0-9a-f]{2})*$/.test(data)) {
    return NextResponse.json({ error: "data must be 0x-prefixed hex" }, { status: 400 });
  }

  try {
    const [result, code] = await Promise.all([
      evmCall(to, data, body.block ?? "latest"),
      evmRpc<string>("eth_getCode", [to, "latest"]).catch(() => null),
    ]);
    return NextResponse.json({
      ok: true,
      to,
      data,
      result,
      codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
      note:
        result === "0x" && (!code || code === "0x")
          ? "no code at this address: the EVM answers reads from an empty account with 0x"
          : undefined,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e), to, data }, { status: 502 });
  }
}
