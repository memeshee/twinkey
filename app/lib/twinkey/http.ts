/**
 * The HTTP-shaped half of the chain helpers, with NO `@polkadot/api` in the module graph.
 *
 * Why this file exists: importing `@polkadot/api` measures ~2.3 s of CPU on a cold Node process
 * (it pulls the WASM crypto and the type registry in at module-eval time). That is fine for a route
 * that genuinely needs a socket, and ruinous for `/api/health`, which only ever needed a timeout
 * wrapper, an error classifier, a memo and a `fetch` to the EVM endpoint — but used to import
 * `./chain`, and therefore paid the whole 2.3 s on every cold invocation while every open tab polls
 * it twice a minute. Vercel bills cold-start CPU as Active CPU, so the cheapest endpoint on the
 * site was the most expensive one.
 *
 * Rule: a route that does not open a websocket must not import `./chain`.
 */

/** Reject instead of hanging: a serverless function must fail inside its budget. */
export async function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Anything that means "the socket, not the request, is the problem". */
export function isConnectionError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e ?? "");
  return /websocket is not connected|failed ws request|connection (closed|lost)|restart required|disconnected|ECONNRESET|ECONNREFUSED|socket hang up|not connected/i.test(
    msg,
  );
}

/** When the shared socket in `./chain` was built, for the health strip. Lives here so the age can
 *  be read without importing the socket (and the 2.3 s of WASM that comes with it). */
let apiBuiltAt = 0;
export const markApiBuilt = (): void => {
  apiBuiltAt = Date.now();
};
export const apiAgeMs = (): number => (apiBuiltAt ? Date.now() - apiBuiltAt : -1);

/** Tiny in-process TTL cache: judges refresh, lambdas do not need to re-scan. */
export function memo<T>(fn: () => Promise<T>, ttlMs: number) {
  const values = ((globalThis as any).__twinkeyMemoV ??= new Map<string, { at: number; value: T }>());
  const inflight = ((globalThis as any).__twinkeyMemoP ??= new Map<string, Promise<T>>());

  return async (k = "default"): Promise<{ value: T; cached: boolean }> => {
    const hit = values.get(k);
    if (hit && Date.now() - hit.at < ttlMs) return { value: hit.value, cached: true };

    // One computation per key, and every caller gets its result. The previous version stored the
    // entry BEFORE the work finished, with `value: undefined`, so a second request that arrived
    // during the first one's flight was told "cached" and handed `undefined` — the route then spread
    // that into its JSON (`{...undefined, cached: true}`), the page received a body with no fields,
    // and rendering it threw `Cannot read properties of undefined (reading 'toLocaleString')`.
    // A caller must never receive a value this function did not compute or read.
    const pending = inflight.get(k);
    if (pending) return { value: await pending, cached: false };

    const p = fn()
      .then((value) => {
        values.set(k, { at: Date.now(), value });
        return value;
      })
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
    return { value: await p, cached: false };
  };
}

import { PORTALDOT } from "./config";

/** Raw JSON-RPC against the EVM endpoint. It is CORS-open (access-control-allow-origin: *). */
export async function evmRpc<T = any>(method: string, params: any[] = []): Promise<T> {
  const res = await fetch(PORTALDOT.evmRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`EVM RPC ${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`EVM RPC ${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result as T;
}
