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
export function memo<T>(fn: () => Promise<T>, ttlMs: number, key = "default") {
  const store = ((globalThis as any).__twinkeyMemo ??= new Map<string, { at: number; value: T; inflight?: Promise<T> }>());
  return async (k: string = key): Promise<{ value: T; cached: boolean }> => {
    const entry = store.get(k);
    const now = Date.now();
    if (entry && now - entry.at < ttlMs) return { value: entry.value, cached: true };
    if (entry?.inflight) return { value: await entry.inflight, cached: false };
    const inflight = fn();
    store.set(k, { at: now, value: entry?.value as T, inflight });
    try {
      const value = await inflight;
      store.set(k, { at: Date.now(), value });
      return { value, cached: false };
    } catch (e) {
      store.delete(k);
      throw e;
    }
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
