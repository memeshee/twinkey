import { NextResponse } from "next/server";
import { PORTALDOT } from "@/lib/twinkey/config";
import { apiAgeMs, evmRpc, getApi, isConnectionError, withDeadline } from "@/lib/twinkey/chain";

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
      const api = await getApi();
      const [name, header] = await Promise.all([api.rpc.system.chain(), api.rpc.chain.getHeader()]);
      return { chain: name.toString(), head: header.number.toNumber() };
      // A cold lambda pays for a websocket handshake plus a runtime-metadata
      // download before the first RPC answers; 6 s was enough to make a healthy
      // chain look degraded on the first request after idle.
    }, 14_000, "substrate ws"),
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
