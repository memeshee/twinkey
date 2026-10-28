import { NextResponse } from "next/server";
import fs from "node:fs";
import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { encodeFunctionData } from "viem";

import { evmRpc, getApi, withDeadline } from "@/lib/twinkey/chain";
import { createTwinKeyProvider } from "@/lib/twinkey/provider";
import { keyringSigner } from "@/lib/twinkey/signers";
import { TWINKEY_PROBE_ABI, TWINKEY_PROBE_ADDRESS } from "@/lib/twinkey/abi";

const READ_SELECTOR = "0x57de26a4";

/**
 * Ground truth for "did this write land", independent of the websocket and of the
 * response we managed to send. `callCount` increments on every successful call.
 */
async function chainState(): Promise<{ value: string; lastCaller: string; callCount: string } | null> {
  try {
    const raw = await evmRpc<string>("eth_call", [{ to: TWINKEY_PROBE_ADDRESS, data: READ_SELECTOR }, "latest"]);
    if (!raw || raw === "0x") return null;
    const hex = raw.slice(2).padStart(192, "0");
    return {
      value: BigInt("0x" + hex.slice(0, 64)).toString(),
      lastCaller: "0x" + hex.slice(64 + 24, 128),
      callCount: BigInt("0x" + hex.slice(128, 192)).toString(),
    };
  } catch {
    return null;
  }
}

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

    const before = await chainState();
    const api = await getApi();
    const provider = createTwinKeyProvider({ signer: keyringSigner(api, pair) });
    const [h160] = (await provider.request({ method: "eth_requestAccounts" })) as string[];

    const data = encodeFunctionData({
      abi: TWINKEY_PROBE_ABI,
      functionName: action,
      args: [value],
    });

    const started = Date.now();
    // Submit inside its own budget: if the socket dies mid-flight the request
    // fails as a labelled error instead of parking until the platform kills it.
    const txHash = (await withDeadline(
      provider.request({
        method: "eth_sendTransaction",
        params: [{ from: h160, to: TWINKEY_PROBE_ADDRESS, data, value: "0x0" }],
      }),
      40_000,
      "revive.call submit",
    )) as string;

    let receipt: any = null;
    try {
      receipt = await withDeadline(
        provider.request({ method: "eth_getTransactionReceipt", params: [txHash] }),
        12_000,
        "receipt",
      );
    } catch {
      // The extrinsic is in: only the receipt was slow. Say that, with the hash.
      const now = await chainState();
      return NextResponse.json(
        {
          ok: true,
          pending: true,
          signedBy: pair.address,
          mappedH160: h160,
          txHash,
          stateAfter: now,
          elapsedMs: Date.now() - started,
          path: "revive.call (native origin, sr25519 signature)",
          note: "submitted — the receipt did not arrive inside this request. Reload: the event feed and callCount are the proof.",
        },
        { status: 202 },
      );
    }

    const after = await provider.request({
      method: "eth_call",
      params: [{ to: TWINKEY_PROBE_ADDRESS, data: READ_SELECTOR }, "latest"],
    });

    return NextResponse.json({
      ok: true,
      signedBy: pair.address,
      mappedH160: h160,
      txHash,
      receipt,
      stateBefore: before,
      stateAfter: after,
      elapsedMs: Date.now() - started,
      path: "revive.call (native origin, sr25519 signature)",
    });
  } catch (e: any) {
    // A lost response is not a lost transaction. Before reporting failure, ask the
    // chain: if callCount moved, the write landed and we say so.
    const after = await chainState();
    return NextResponse.json(
      {
        error: String(e?.message ?? e),
        data: e?.data ?? null,
        stateAfter: after,
        note: "if callCount on /api/state moved past the value you saw, the extrinsic did land — the response was lost, not the transaction",
      },
      { status: 500 },
    );
  }
}
