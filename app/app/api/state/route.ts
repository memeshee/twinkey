import { NextResponse } from "next/server";
import { evmRpc, getApi, nativeFree, resolveH160 } from "@/lib/twinkey/chain";
import { PORTALDOT } from "@/lib/twinkey/config";
import { TWINKEY_PROBE_ADDRESS } from "@/lib/twinkey/abi";

export const dynamic = "force-dynamic";

const READ_SELECTOR = "0x57de26a4"; // read()

/** GET /api/state?ss58=… — one round trip for everything the UI needs to render the top of the page. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const ss58 = url.searchParams.get("ss58") ?? process.env.PORTALDOT_DEMO_SS58 ?? null;

  try {
    const api = await getApi();
    const [chainName, head, runtime] = await Promise.all([
      api.rpc.system.chain(),
      api.rpc.chain.getHeader(),
      api.rpc.state.getRuntimeVersion(),
    ]);

    const headNumber = head.number.toNumber();

    let identity = null;
    if (ss58) {
      try {
        const h160 = await resolveH160(api, ss58);
        const free = await nativeFree(api, ss58);
        identity = {
          ss58,
          h160,
          nativeFreeRaw: free.toString(),
          nativeFreeFormatted: (Number(free) / 1e14).toFixed(4),
          evmBalanceWei: "0x" + (free * PORTALDOT.nativeToEthRatio).toString(16),
        };
      } catch (e: any) {
        identity = { ss58, error: String(e?.message ?? e) };
      }
    }

    // Current contract state, read the way any EVM tool would read it.
    const [readResult, code] = await Promise.all([
      evmRpc<string>("eth_call", [{ to: TWINKEY_PROBE_ADDRESS, data: READ_SELECTOR }, "latest"]).catch(() => null),
      evmRpc<string>("eth_getCode", [TWINKEY_PROBE_ADDRESS, "latest"]).catch(() => null),
    ]);

    let contractState = null;
    if (readResult && readResult !== "0x") {
      const hex = readResult.slice(2).padStart(192, "0");
      contractState = {
        value: BigInt("0x" + hex.slice(0, 64)).toString(),
        lastCaller: "0x" + hex.slice(64 + 24, 128),
        callCount: BigInt("0x" + hex.slice(128, 192)).toString(),
      };
    }

    return NextResponse.json({
      chain: {
        name: chainName.toString(),
        spec: runtime.specName.toString(),
        specVersion: runtime.specVersion.toNumber(),
        head: headNumber,
        headHash: head.hash.toHex(),
        evmChainId: PORTALDOT.evmChainId,
        token: PORTALDOT.tokenSymbol,
        nativeDecimals: PORTALDOT.nativeDecimals,
        evmDecimals: PORTALDOT.evmDecimals,
      },
      identity,
      contract: {
        address: TWINKEY_PROBE_ADDRESS,
        codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
        state: contractState,
      },
      demoSigning: Boolean(process.env.PORTALDOT_KEY || process.env.PORTALDOT_SECRET_URI),
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 503 });
  }
}
