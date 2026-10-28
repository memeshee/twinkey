"use client";

import { useCallback, useEffect, useState } from "react";

type Check = { ok: boolean; ms: number; detail?: string; connection?: boolean };
type Health = {
  ok: boolean;
  degraded: string[];
  checks: Record<string, Check>;
  substrate?: { chain: string; head: number } | null;
  evm_block?: string | null;
  verifier_info?: any;
  demo_signing?: boolean;
  total_ms?: number;
};

/**
 * Every upstream this page depends on, checked live.
 *
 * A judge who lands during an outage should see "the verifier is down, here is
 * what still works" instead of an empty pane or a raw 503 — and the numbers next
 * to each check (ms) make it obvious that this is a live probe, not a label.
 */
export default function StatusStrip() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const json = await res.json();
      setHealth(json);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, [check]);

  const label: Record<string, string> = {
    substrate: "substrate ws",
    evm: "evm rpc",
    verifier: "verifier",
  };

  return (
    <div className="card" style={{ padding: "12px 16px" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row" style={{ gap: 10 }}>
          <span style={{ color: "var(--muted)", fontSize: 12.5 }}>upstreams</span>
          {health ? (
            Object.entries(health.checks).map(([name, c]) => (
              <span
                key={name}
                className={`badge ${c.ok ? "ok" : "warn"}`}
                title={c.detail ?? `${c.ms} ms`}
              >
                {c.ok ? "●" : "○"} {label[name] ?? name} {c.ms}ms
              </span>
            ))
          ) : (
            <span className="badge">{error ? "unreachable" : "checking…"}</span>
          )}
          {health?.substrate?.head ? (
            <span className="badge">head {health.substrate.head.toLocaleString()}</span>
          ) : null}
        </div>
        <div className="row" style={{ gap: 8 }}>
          {health && !health.ok && (
            <span style={{ color: "var(--warn)", fontSize: 12.5 }}>
              degraded: {health.degraded.join(", ")}
            </span>
          )}
          <button onClick={check} disabled={checking}>
            {checking ? <span className="spin" /> : null}
            {checking ? "checking" : "re-check"}
          </button>
        </div>
      </div>
      {health && !health.ok && (
        <p className="sub" style={{ margin: "8px 0 0" }}>
          Degraded panes still work from cache where they can. If <b>verifier</b> is down, the independent
          verdict section says so instead of inventing a result — and the write path is unaffected, because the
          verifier reads the chain a second time rather than sitting in front of it.
        </p>
      )}
    </div>
  );
}
