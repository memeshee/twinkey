import { NextResponse } from "next/server";
import { PORTALDOT } from "@/lib/twinkey/config";
import { apiAgeMs, evmRpc, isConnectionError, withDeadline } from "@/lib/twinkey/chain";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const VERIFIER = process.env.TWINKEY_VERIFIER_URL ?? "https://twinkey-verifier.onrender.com";

type Check = {
  ok: boolean;
  ms: number;
  detail?: string;
  /** set when the failure means "the socket, not the chain" */
  connection?: boolean;
};

async function timed<T>(fn: () => Promise<T>, ms: number, label: string): Promise<{ ok: boolean; ms: number; value?: T; detail?: string; connection?: boolean }> {
  const started = Date.now();
  try {
    const value = await withDeadline(fn(), ms, label);
    return { ok: true, ms: Date.now() - started, value };
  } catch (e: any) {
    return {
      ok: false,
      ms: Date.now() - started,
      detail: String(e?.message ?? e),
      connection: isConnectionError(e),
    };
  }
}

/**
 * GET /api/health — is every upstream this page depends on answering, right now?
 *
 * The page renders this instead of showing a judge a raw 503: a degraded pane
 * with a cause and a retry is a product; an empty div with "error" is not.
 */
export async function GET() {
  const started = Date.now();

  const [substrate, evm, verifier] = await Promise.all([
    timed(async () => {
      // Plain JSON-RPC over HTTP, deliberately: health must not pay for a websocket
      // handshake plus a runtime-metadata download. A cold lambda made that take
      // >14 s and reported a perfectly healthy chain as degraded — the first hit
      // after every deploy. The shared socket has its own number (api_age_ms).
      const res = await fetch(PORTALDOT.substrateHttp, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "twinkey-app/1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "chain_getHeader", params: [] }),
        signal: AbortSignal.timeout(9_000),
      });
      const json: any = await res.json();
      if (json.error) throw new Error(`chain_getHeader: ${json.error.message ?? JSON.stringify(json.error)}`);
      const head = Number(BigInt(json.result?.number ?? "0x0"));
      let chain = "PortaldotV3 Test";
      try {
        const res2 = await fetch(PORTALDOT.substrateHttp, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "twinkey-app/1.0" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "system_chain", params: [] }),
          signal: AbortSignal.timeout(6_000),
        });
        const j2: any = await res2.json();
        if (typeof j2.result === "string") chain = j2.result;
      } catch {
        /* the chain name is decoration; the header is the check */
      }
      return { chain, head };
    }, 16_000, "substrate http"),
    timed(async () => {
      // The EVM endpoint occasionally takes >10 s from a cold lambda and then
      // answers in 800 ms. One retry distinguishes "slow" from "down"; reporting a
      // healthy chain as degraded is its own kind of lie.
      try {
        return await evmRpc<string>("eth_blockNumber", []);
      } catch {
        return await evmRpc<string>("eth_blockNumber", []);
      }
    }, 18_000, "evm rpc"),
    timed(async () => {
      const res = await fetch(`${VERIFIER}/health`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }, 9_000, "verifier"),
  ]);

  const checks: Record<string, Check> = {
    substrate: { ok: substrate.ok, ms: substrate.ms, detail: substrate.detail, connection: substrate.connection },
    evm: { ok: evm.ok, ms: evm.ms, detail: evm.detail, connection: evm.connection },
    verifier: { ok: verifier.ok, ms: verifier.ms, detail: verifier.detail },
  };

  const degraded = Object.entries(checks)
    .filter(([, c]) => !c.ok)
    .map(([k]) => k);

  return NextResponse.json(
    {
      ok: degraded.length === 0,
      degraded,
      checks,
      substrate: substrate.value ?? null,
      evm_block: evm.value ?? null,
      verifier_info: verifier.value ?? null,
      // Which build is answering. Vercel sets these on every deployment, so a
      // "did my push actually ship?" question has a factual answer instead of an
      // assumption about build queues.
      git_sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      git_sha_short: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null,
      git_ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      deployment_url: process.env.VERCEL_URL ?? null,
      api_age_ms: apiAgeMs(),
      demo_signing: Boolean(process.env.PORTALDOT_KEY || process.env.PORTALDOT_SECRET_URI),
      config: {
        substrate_rpc: PORTALDOT.substrateHttp,
        evm_rpc: PORTALDOT.evmRpc,
        verifier: VERIFIER,
        evm_chain_id: PORTALDOT.evmChainId,
      },
      total_ms: Date.now() - started,
    },
    { status: degraded.length === 0 ? 200 : 207 },
  );
}
