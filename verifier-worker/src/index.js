/**
 * TwinKey verifier — Cloudflare Worker edition.
 *
 * The Rust service this replaces held a websocket to the node; this one does not
 * need a socket at all: every fact it reports is available over HTTPS JSON-RPC,
 * including the archive methods. That removes the whole failure mode the old
 * service kept hitting (idle sockets dying, 240 s rebuilds, cold-start handshakes).
 *
 * What it answers, and what it does NOT claim:
 *   GET /health          upstream probes with latency, in the old service's shape
 *   GET /ready           ok + substrate head + EVM head (the keepalive polls this)
 *   GET /verify/block/:n block n on both runtimes: substrate hash/extrinsics/events
 *                        size next to the EVM block at the same height
 *   GET /parity/:n       verdict for height n: does each runtime have a block there,
 *                        and do the two agree on the height itself
 *   GET /verify/tx/:h    NOT implemented here — 501 with a machine-readable reason,
 *                        because a wrong receipt verdict is worse than none
 *
 * Honesty rule: a check that could not be performed is reported as
 * `{ok: false, error}`. Nothing is inferred, and no number is invented.
 */

const SUBSTRATE = "https://test-node-v3.portaldot.dev";
const EVM = "https://test-evm-rpc-v3.portaldot.dev";
const SERVICE = "twinkey-verifier-worker";
const VERSION = "worker-0.1.0";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 1), { status, headers: CORS });

async function rpc(url, method, params = [], timeoutMs = 9000) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const body = await res.json();
    const ms = Date.now() - started;
    if (body.error) return { ok: false, ms, error: body.error.message || JSON.stringify(body.error) };
    return { ok: true, ms, result: body.result };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(url) {
  const isEvm = url === EVM;
  const r = isEvm ? await rpc(url, "eth_blockNumber") : await rpc(url, "chain_getHeader");
  if (!r.ok) return { ok: false, ms: r.ms, error: r.error };
  // The substrate side answers with {number:"0x…"}; the EVM side with "0x…".
  const hex = isEvm ? r.result : r.result.number;
  return { ok: true, ms: r.ms, head: parseInt(hex, 16) };
}

async function handler(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (path === "/" || path === "/health" || path === "/diagnostics") {
    const [sub, evm] = await Promise.all([probe(SUBSTRATE), probe(EVM)]);
    const checks = { substrate: sub.ok, evm: evm.ok };
    const degraded = Object.keys(checks).filter((k) => !checks[k]);
    const body = {
      ok: degraded.length === 0,
      service: SERVICE,
      version: VERSION,
      degraded,
      checks: {
        substrate: sub.ok ? { ok: true, ms: sub.ms, head: sub.head } : sub,
        evm: evm.ok ? { ok: true, ms: evm.ms, head: evm.head } : evm,
      },
      substrate: sub.ok ? { chain: "PortaldotV3 Test", head: sub.head } : null,
      evm_block: evm.ok ? "0x" + evm.head.toString(16) : null,
      // Kept so anything reading the Rust service's field keeps working.
      client: { backend: "http-v1", age_s: 0, rebuilds: 0 },
      note: "stateless: one HTTPS JSON-RPC round trip per check, no websocket",
    };
    if (path === "/diagnostics") {
      body.rpc = ["chain_getHeader", "chain_getBlock", "state_getStorage", "archive_v1_hashByHeight"];
    }
    return json(body, body.ok ? 200 : 503);
  }

  if (path === "/ready") {
    const [sub, evm] = await Promise.all([probe(SUBSTRATE), probe(EVM)]);
    const ok = sub.ok && evm.ok;
    return json(
      {
        ok,
        head: sub.ok ? sub.head : null,
        // Flattened aliases: the Rust service reported these names and the deploy
        // script still reads them.
        head_block: sub.ok ? sub.head : null,
        evm_head_block: evm.ok ? evm.head : null,
        client_age_s: 0,
        client_rebuilds: 0,
        evm: evm.ok ? evm.head : null,
        service: SERVICE,
        version: VERSION,
        client: { backend: "http-v1", age_s: 0, rebuilds: 0 },
        ...(ok ? {} : { errors: { substrate: sub.error || null, evm: evm.error || null } }),
      },
      ok ? 200 : 503,
    );
  }

  const blockMatch = path.match(/^\/verify\/block\/(\d+)$/);
  const parityMatch = path.match(/^\/parity\/(\d+)$/);
  const txMatch = path.match(/^\/verify\/tx\/(0x[0-9a-fA-F]{64})$/);

  if (txMatch) {
    return json(
      {
        ok: false,
        error: "per-extrinsic lookup is not implemented in the worker edition",
        detail:
          "The Rust service scanned substrate blocks for the extrinsic. The worker reports block-level facts only until that scan is ported; use /verify/block/<n>.",
        hash: txMatch[1],
      },
      501,
    );
  }

  if (blockMatch || parityMatch) {
    const height = parseInt((blockMatch || parityMatch)[1], 10);

    const hashRes = await rpc(SUBSTRATE, "archive_v1_hashByHeight", [height]);
    // This node returns a one-element array; unwrap instead of trusting either shape.
    const rawHash = hashRes.ok ? hashRes.result : null;
    const substrateHash = Array.isArray(rawHash) ? rawHash[0] : rawHash;

    const evmBlockRes = await rpc(EVM, "eth_getBlockByNumber", ["0x" + height.toString(16), false]);

    let substrateSide = null;
    if (substrateHash) {
      const [block, events] = await Promise.all([
        rpc(SUBSTRATE, "chain_getBlock", [substrateHash]),
        rpc(SUBSTRATE, "state_getStorage", [
          "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7", // System::Events
          substrateHash,
        ]),
      ]);
      substrateSide = {
        hash: substrateHash,
        number: block.ok ? parseInt(block.result.block.header.number, 16) : null,
        extrinsics: block.ok ? block.result.block.extrinsics.length : null,
        events_bytes: events.ok && events.result ? (events.result.length - 2) / 2 : 0,
        errors: [
          ...(block.ok ? [] : [{ call: "chain_getBlock", error: block.error }]),
          ...(events.ok ? [] : [{ call: "state_getStorage(Events)", error: events.error }]),
        ],
      };
    }

    const evmSide = evmBlockRes.ok
      ? evmBlockRes.result
        ? {
            number: parseInt(evmBlockRes.result.number, 16),
            hash: evmBlockRes.result.hash,
            transactions: (evmBlockRes.result.transactions || []).length,
          }
        : null
      : { error: evmBlockRes.error };

    const checks = {
      substrate_block_at_height: Boolean(substrateHash),
      substrate_block_read: Boolean(substrateSide && substrateSide.extrinsics !== null),
      evm_block_at_height: Boolean(evmSide && evmSide.number !== undefined),
      heights_agree:
        Boolean(substrateSide && substrateSide.number !== null && evmSide && evmSide.number === substrateSide.number),
    };
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    const ok = failed.length === 0;

    const body = {
      ok,
      service: SERVICE,
      version: VERSION,
      block: height,
      substrate: substrateSide,
      evm: evmSide,
      checks,
      parity: checks.heights_agree,
      verdict: ok
        ? { ok: true, summary: `height ${height} present on both runtimes; substrate ${substrateSide.extrinsics} extrinsics, evm ${evmSide ? evmSide.transactions : "?"} transactions` }
        : { ok: false, error: `checks failed: ${failed.join(", ")}`, checks },
      ...(blockMatch ? {} : { mode: "parity" }),
    };
    return json(body, ok ? 200 : 502);
  }

  return json(
    {
      ok: false,
      service: SERVICE,
      version: VERSION,
      error: "not found",
      routes: ["/health", "/ready", "/diagnostics", "/verify/block/<n>", "/parity/<n>", "/verify/tx/<hash>"],
    },
    404,
  );
}

export default {
  async fetch(request) {
    try {
      return await handler(request);
    } catch (e) {
      return json({ ok: false, service: SERVICE, version: VERSION, error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
