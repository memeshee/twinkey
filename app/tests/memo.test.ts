/**
 * The crash this exists for:
 *
 *   Uncaught TypeError: Cannot read properties of undefined (reading 'toLocaleString')
 *     at h (page-….js)
 *
 * The page rendered `scanMeta.from.toLocaleString()` from an `/api/events` answer that was a 200
 * with `{cached: true}` and nothing else. The cause was in `memo()`: it wrote its cache entry
 * *before* the work finished, with `value: undefined`, so any request that arrived during the first
 * one's flight was told "cached" and handed `undefined`. The route spread that into its JSON, the
 * client stored the hole, and the render threw.
 *
 * A cache must never hand out a value it did not compute. Run with: npx tsx tests/memo.test.ts
 */
import assert from "node:assert/strict";

import { memo } from "../lib/twinkey/http";

let failures = 0;
const check = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e: any) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split("\n")[0]}`);
  }
};

// A key that no other test in this process has touched, so the globalThis-backed store is cold.
const uniq = () => `test:${Date.now()}:${Math.random().toString(36).slice(2)}`;

async function main() {
  await check("three concurrent callers all receive a computed value", async () => {
    const key = uniq();
    let calls = 0;
    const cached = memo(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 50));
      return { from: 100, to: 120, scanned: 21 };
    }, 60_000);

    const results = await Promise.all([cached(key), cached(key), cached(key)]);
    for (const [i, r] of results.entries()) {
      assert.ok(r.value, `caller ${i} was handed ${String(r.value)}`);
      assert.equal(typeof r.value.from, "number", `caller ${i} has no from`);
      assert.equal(r.value.to, 120);
    }
    // One computation shared by all three, not three scans of the same range.
    assert.equal(calls, 1, `expected 1 upstream computation, saw ${calls}`);
  });

  await check("a caller during the flight is not told 'cached'", async () => {
    const key = uniq();
    const cached = memo(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return { chain: { head: 450_326 } };
    }, 60_000);

    const [first, second] = await Promise.all([cached(key), cached(key)]);
    assert.equal(first.cached, false);
    assert.equal(second.cached, false, "an in-flight join must not claim to be a cache hit");
    assert.equal(second.value.chain.head, 450_326);
  });

  await check("a real cache hit is still served from memory", async () => {
    const key = uniq();
    let calls = 0;
    const cached = memo(async () => {
      calls += 1;
      return { ok: true, at: Date.now() };
    }, 60_000);

    const a = await cached(key);
    const b = await cached(key);
    assert.equal(calls, 1, "second call must not re-run the work");
    assert.equal(a.cached, false);
    assert.equal(b.cached, true);
    assert.equal(b.value.at, a.value.at, "a hit must return the same object, not a fresh one");
  });

  await check("a failed computation is not cached", async () => {
    const key = uniq();
    let calls = 0;
    const cached = memo(async () => {
      calls += 1;
      if (calls === 1) throw new Error("upstream blew up");
      return { recovered: true };
    }, 60_000);

    await assert.rejects(() => cached(key), /upstream blew up/);
    const second = await cached(key);
    assert.equal(second.value.recovered, true, "the retry must actually recompute");
    assert.equal(calls, 2);
  });

  await check("expiry re-runs the work", async () => {
    const key = uniq();
    let calls = 0;
    const cached = memo(async () => {
      calls += 1;
      return { n: calls };
    }, 20);

    await cached(key);
    await new Promise((r) => setTimeout(r, 35));
    const after = await cached(key);
    assert.equal(after.value.n, 2, "an expired entry must recompute");
    assert.equal(after.cached, false);
  });

  console.log(failures === 0 ? "\nmemo: all checks passed" : `\nmemo: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
