import { NextResponse } from "next/server";
import fs from "node:fs";
import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { encodeFunctionData } from "viem";

import { getApi } from "@/lib/twinkey/chain";
import { createTwinKeyProvider } from "@/lib/twinkey/provider";
import { keyringSigner } from "@/lib/twinkey/signers";
import { TWINKEY_PROBE_ABI, TWINKEY_PROBE_ADDRESS } from "@/lib/twinkey/abi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/demo-write { value: number }
 *
 * Runs exactly the same provider the browser uses, but with a local key instead of a wallet
 * extension, so a judge can watch a real `revive.call` land without installing anything.
 *
 * Disabled unless PORTALDOT_KEY points at a key file (or PORTALDOT_SECRET_URI is set): the demo
 * signer only exists on the testnet, and it is rate limited because anyone can call this route.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 3;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "rate limited: 3 demo writes per minute" }, { status: 429 });
  }

  let body: { value?: number; action?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine, defaults below */
  }
  const value = BigInt(Math.max(0, Math.min(Number(body.value ?? 1), 1_000_000)));
  const action = body.action === "add" ? "addValue" : "setValue";

  const keyPath = process.env.PORTALDOT_KEY;
  const secretUri = process.env.PORTALDOT_SECRET_URI;
  if (!keyPath && !secretUri) {
    return NextResponse.json(
      {
        error: "demo signing disabled",
        hint: "set PORTALDOT_KEY to a key file path (or PORTALDOT_SECRET_URI) to enable a real write from the server",
      },
      { status: 503 },
    );
  }

  try {
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

    const data = encodeFunctionData({
      abi: TWINKEY_PROBE_ABI,
      functionName: action,
      args: [value],
    });

    const started = Date.now();
    const txHash = (await provider.request({
      method: "eth_sendTransaction",
      params: [{ from: h160, to: TWINKEY_PROBE_ADDRESS, data, value: "0x0" }],
    })) as string;
    const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [txHash] });
    const after = await provider.request({
      method: "eth_call",
      params: [{ to: TWINKEY_PROBE_ADDRESS, data: "0x57de26a4" }, "latest"],
    });

    return NextResponse.json({
      ok: true,
      signedBy: pair.address,
      mappedH160: h160,
      txHash,
      receipt,
      stateAfter: after,
      elapsedMs: Date.now() - started,
      path: "revive.call (native origin, sr25519 signature)",
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e), data: e?.data ?? null }, { status: 500 });
  }
}
