import { NextResponse } from "next/server";

import { demoContext, demoEnabled, evmCall } from "@/lib/twinkey/demo";
import { dryRunCall, evmRpc } from "@/lib/twinkey/chain";

export const dynamic = "force-dynamic";
export const maxDuration = 40;

/**
 * POST /api/estimate  { to, data, ss58?, value? }
 *
 * The two ways to ask "what will this call cost" on Portaldot V3, answered side
 * by side:
 *
 *  - `eth_estimateGas` from the EVM endpoint. On this build it returns values in
 *    the 10^11–10^15 range for trivial calls while the block advertises
 *    gasLimit = u64::MAX, which is why every MetaMask/Remix transaction built
 *    from it is rejected for exceeding any plausible balance.
 *  - `ReviveApi_call`, the runtime's own dry run, whose `weightRequired` and
 *    `storageDeposit` are exactly what `revive.call` needs and are refunded when
 *    unused.
 *
 * The ratio between them is the clearest single number in the project: a gas
 * number that is off by four orders of magnitude is not a rounding error.
 */
export async function POST(req: Request) {
  let body: { to?: string; data?: string; ss58?: string; value?: string } = {};
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

  // Who the dry run is executed as matters (msg.sender, balance, mapping), so the
  // caller may name an ss58; otherwise the demo account stands in for them.
  let origin = body.ss58?.trim() || null;
  if (!origin && demoEnabled()) {
    try {
      origin = (await demoContext()).ss58;
    } catch {
      origin = null;
    }
  }

  const [evm, runtime] = await Promise.all([
    (async () => {
      try {
        const hex = await evmRpc<string>("eth_estimateGas", [{ from: undefined, to, data }]);
        return { ok: true, gas: BigInt(hex).toString(), raw: hex };
      } catch (e: any) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    })(),
    (async () => {
      if (!origin) return { ok: false, error: "no origin: pass ?ss58= or enable the demo signer" };
      try {
        const { withApi } = await import("@/lib/twinkey/chain");
        const dry = await withApi(async (api) =>
          dryRunCall(api, origin!, to, BigInt(body.value ?? "0"), data),
        );
        return { ...dry, ok: dry.ok, origin };
      } catch (e: any) {
        return { ok: false, origin, error: String(e?.message ?? e) };
      }
    })(),
  ]);

  const evmGas = evm.ok ? BigInt((evm as any).gas) : null;
  const realGas = runtime.ok && (runtime as any).gasConsumed ? BigInt((runtime as any).gasConsumed) : null;
  const ratio =
    evmGas !== null && realGas !== null && realGas > 0n
      ? Number(evmGas / realGas)
      : null;

  // A read of the same calldata, so the caller sees what the call would return.
  const simulated = await evmCall(to, data).catch((e) => `error: ${e?.message ?? e}`);

  return NextResponse.json({
    ok: evm.ok || runtime.ok,
    to,
    data,
    evm_estimate: evm,
    runtime_dry_run: runtime,
    ratio_evm_over_runtime: ratio,
    ratio_note:
      ratio !== null && ratio > 100
        ? `eth_estimateGas is ${ratio}× the cost the chain actually charges — the number every EVM tool auto-fills from is wrong on this build`
        : undefined,
    eth_call_result: simulated,
    verdict:
      evmGas === null
        ? "EVM endpoint did not answer"
        : realGas === null
          ? "runtime dry run unavailable (no origin)"
          : ratio !== null && ratio > 100
            ? "do not trust eth_estimateGas on this chain; use the runtime dry run"
            : "the two agree",
  });
}
