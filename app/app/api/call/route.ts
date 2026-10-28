import { NextResponse } from "next/server";

import { clientIp, demoEnabled, rateLimited, submitDemoCall } from "@/lib/twinkey/demo";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/call  { to, data, value? }
 *
 * The generic write path: any contract, any calldata, signed as a `revive.call`
 * extrinsic by the demo signer. This is what makes the app a tool rather than a
 * demo of one function — the browser uses the same provider with the user's own
 * wallet, and this route is the same code path with a key the judge does not have
 * to install.
 *
 * `data` is pre-encoded calldata on purpose: it keeps the trust boundary honest
 * (the client encodes, the server signs and submits what it was given) and it
 * means the route works for any ABI, including ones the server has never seen.
 */
export async function POST(req: Request) {
  if (!demoEnabled()) {
    return NextResponse.json(
      {
        error: "demo signing disabled on this deployment",
        hint: "connect a Substrate wallet in the browser instead — the write path is identical",
      },
      { status: 503 },
    );
  }

  if (rateLimited(`call:${clientIp(req)}`)) {
    return NextResponse.json(
      { error: "rate limited: 3 demo writes per minute per IP", hint: "wait a minute, or connect your own wallet" },
      { status: 429 },
    );
  }

  let body: { to?: string; data?: string; value?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON: { to, data, value }" }, { status: 400 });
  }

  const to = String(body.to ?? "").trim().toLowerCase();
  const data = String(body.data ?? "").trim();
  if (!/^0x[0-9a-f]{40}$/.test(to)) {
    return NextResponse.json({ error: `to must be a 20-byte address, got '${body.to ?? ""}'` }, { status: 400 });
  }
  if (!/^0x([0-9a-f]{2})*$/.test(data)) {
    return NextResponse.json({ error: "data must be 0x-prefixed hex calldata" }, { status: 400 });
  }

  // Refuse early when there is no code: revive.call to an empty account fails
  // deep inside the runtime and the message there is useless to a human.
  try {
    const { evmRpc } = await import("@/lib/twinkey/chain");
    const at = await evmRpc<string>("eth_getCode", [to, "latest"]);
    if (!at || at === "0x") {
      return NextResponse.json(
        {
          error: `no contract code at ${to} on this chain`,
          hint: "reads from an EOA return 0x; writes need a deployed contract. Deploy one with revive.instantiate_with_code, or use the probe contract.",
        },
        { status: 400 },
      );
    }
  } catch {
    /* the code check is a courtesy: a read failure must not block the write */
  }

  try {
    const result = await submitDemoCall({ to, data, valueWei: body.value ?? "0x0" });
    return NextResponse.json(
      {
        ok: true,
        path: "revive.call (native origin, sr25519 signature)",
        to,
        data,
        value: body.value ?? "0x0",
        ...result,
      },
      { status: result.pending ? 202 : 200 },
    );
  } catch (e: any) {
    return NextResponse.json(
      {
        error: String(e?.message ?? e),
        data: e?.data ?? null,
        to,
        hint: "a revert here is the contract's own error; a dispatch error is the runtime's — both are shown verbatim rather than guessed at",
      },
      { status: 500 },
    );
  }
}
