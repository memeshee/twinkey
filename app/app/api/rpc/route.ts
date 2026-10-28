import { NextResponse } from "next/server";

import { clientIp, demoContext, demoEnabled, rateLimited, receiptFromResolution, resolveExtrinsic } from "@/lib/twinkey/demo";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/rpc — a JSON-RPC endpoint whose writes are signed by an sr25519 key.
 *
 * This is the shortest possible demonstration of the whole idea: a standard EVM
 * client (`viem`, `ethers`, anything that speaks JSON-RPC over HTTP) points at a
 * URL, and a write becomes a native `revive.call` extrinsic. No wallet extension,
 * no injected provider, no rewrite — one transport URL.
 *
 * It is also honest about what it is: the key that signs here is the demo account,
 * not the caller's. `/` and `/viem` say so, and the read methods are forwarded to
 * the real EVM endpoint so nothing about the answers is simulated.
 */

/** Methods a read-only client depends on; forwarded verbatim to the EVM node. */
const FORWARD = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_getCode",
  "eth_getBalance",
  "eth_getStorageAt",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionCount",
  "eth_getLogs",
  "eth_gasPrice",
  "eth_feeHistory",
  "web3_clientVersion",
]);

export async function POST(req: Request) {
  let body: { jsonrpc?: string; id?: any; method?: string; params?: any } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }

  const id = body.id ?? null;
  const method = String(body.method ?? "");
  const params = body.params ?? [];

  if (!method) {
    return NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } });
  }

  const reply = (result: any) => NextResponse.json({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string, data?: unknown) =>
    NextResponse.json({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });

  if (FORWARD.has(method)) {
    try {
      const { evmRpc } = await import("@/lib/twinkey/chain");
      return reply(await evmRpc(method, params));
    } catch (e: any) {
      return fail(-32000, String(e?.message ?? e));
    }
  }

  const WRITES = new Set(["eth_sendTransaction", "eth_sendRawTransaction"]);
  if (WRITES.has(method)) {
    if (!demoEnabled()) {
      return fail(-32603, "demo signing is disabled on this deployment; connect a wallet in the browser instead");
    }
    if (rateLimited(`rpc:${clientIp(req)}`, 3, 60_000)) {
      return fail(-32005, "rate limited: 3 writes per minute per IP (demo signer)");
    }
  }

  // Everything else goes through the same provider the browser uses, with a
  // server-side signer instead of an injected one.
  try {
    const { provider, ss58, h160 } = await demoContext();
    if (method === "eth_accounts" || method === "eth_requestAccounts") return reply([h160]);
    if (method === "twinkey_identity") return reply({ ss58, h160 });

    // Receipts need care: the write may have been handled by a different lambda.
    // 1. the same instance's memory, 2. a stateless hash scan of the archive node.
    if (method === "eth_getTransactionReceipt") {
      const hash = String(params?.[0] ?? "").toLowerCase();
      try {
        const own = await provider.request({ method, params });
        if (own) return reply(own);
      } catch {
        /* fall through to the scan */
      }
      const resolved = await resolveExtrinsic(hash).catch(() => null);
      if (resolved) return reply(receiptFromResolution(hash, resolved, params?.[1]));
      return reply(null);
    }

    const result = await provider.request({ method, params });
    return reply(result);
  } catch (e: any) {
    return fail(e?.code ?? -32000, String(e?.message ?? e), e?.data);
  }
}

/** GET /api/rpc — what this endpoint is, so a curl is self-explanatory. */
export async function GET() {
  return NextResponse.json({
    endpoint: "POST a JSON-RPC 2.0 request here",
    what:
      "reads are forwarded to the EVM node at https://test-evm-rpc-v3.portaldot.dev; writes are signed by a demo sr25519 key and submitted as revive.call extrinsics",
    caveat:
      "the signing key is the demo account, not yours. Point viem at this URL to prove standard tooling works; connect your own wallet in the app to sign as yourself.",
    methods: {
      forwarded: [...FORWARD].sort(),
      signed: ["eth_sendTransaction (3/min per IP)"],
      provider: [
        "eth_accounts",
        "eth_requestAccounts",
        "eth_getTransactionReceipt",
        "eth_getTransactionByHash",
        "twinkey_identity",
        "twinkey_dryRun",
      ],
    },
    example:
      'curl -s -X POST https://twinkey.vercel.app/api/rpc -H "content-type: application/json" -d \'{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}\'',
  });
}
