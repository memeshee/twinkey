import Link from "next/link";

export const dynamic = "force-dynamic";

const VERIFIER = process.env.TWINKEY_VERIFIER_URL ?? "https://twinkey-verifier.onrender.com";

/**
 * /tx/:hash — a receipt that proves itself.
 *
 * The hash TwinKey returns is the *extrinsic* hash of the `revive.call`, so the
 * only implementation that can resolve it is the one that scans Substrate blocks
 * for it: the verifier. This page shows the verifier's resolution (block,
 * extrinsic index, decoded revive events, mapped sender) and the raw JSON next to
 * it, so a judge never has to take the UI's word for anything.
 *
 * `?block=` short-circuits the scan when the caller already knows the block —
 * the app links with it, because a hash-scan window is bounded and honest
 * correctness beats a magic lookup.
 */
export default async function TxPage({
  params,
  searchParams,
}: {
  params: Promise<{ hash: string }>;
  searchParams: Promise<{ block?: string }>;
}) {
  const { hash } = await params;
  const { block } = await searchParams;

  const normalised = hash.trim().toLowerCase();
  const valid = /^0x[0-9a-f]{64}$/.test(normalised);

  let verdict: any = null;
  let error: string | null = null;
  if (valid) {
    try {
      const target = block
        ? `${VERIFIER}/verify/block/${encodeURIComponent(block)}`
        : `${VERIFIER}/verify/tx/${normalised}`;
      const res = await fetch(target, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      verdict = await res.json();
    } catch (e: any) {
      error = String(e?.message ?? e);
    }
  }

  const resolved = verdict?.resolved;
  const events: any[] = verdict?.revive_events ?? verdict?.events ?? [];

  return (
    <div className="wrap">
      <div className="top">
        <div className="brand">
          <span className="dot" />
          TwinKey
        </div>
        <div className="meta">
          <span>
            extrinsic <b>{normalised.slice(0, 12)}…</b>
          </span>
          <span>
            verifier <b>{error ? "unreachable" : "answered"}</b>
          </span>
        </div>
      </div>

      <section className="hero">
        <h1>
          Extrinsic <em>receipt</em>
        </h1>
        <p className="lede">
          A TwinKey write is a native <code>revive.call</code> extrinsic, not an EVM transaction — so this hash
          is resolved by scanning Substrate blocks, which is exactly what the independent verifier does.
        </p>
      </section>

      <div className="card">
        <h2>Hash</h2>
        <pre className="out">{normalised}</pre>
        {!valid && (
          <div className="note">
            not a 32-byte hash: expected <code>0x</code> + 64 hex characters.
          </div>
        )}
        <div className="row">
          {block && (
            <Link href={`/block/${block}`}>
              <button>open block {block}</button>
            </Link>
          )}
          <a href={`${VERIFIER}/verify/tx/${normalised}`} target="_blank" rel="noreferrer">
            <button>raw JSON (verifier)</button>
          </a>
          <Link href="/">
            <button>back to the app</button>
          </Link>
        </div>
      </div>

      <div className="card">
        <h2>
          Resolution <span className="badge">independent process</span>
        </h2>
        {error && (
          <pre className="out">
            <span className="err">verifier unreachable</span>
            {`\n${error}`}
          </pre>
        )}
        {!error && verdict && (
          <pre className="out">
            {verdict.error
              ? `error   ${verdict.error}\n${verdict.message ?? ""}\n${JSON.stringify(verdict.detail ?? {}, null, 2)}`
              : `resolved  ${
                  resolved
                    ? resolved.kind === "extrinsic"
                      ? `extrinsic #${resolved.extrinsic_index} in block ${resolved.block_number}`
                      : `block ${resolved.block_number}`
                    : block
                      ? `block ${block} (from the link)`
                      : "not in the verifier's scan window — open the block permalink instead"
                }${verdict.verdict !== undefined ? `\nverdict   ${verdict.verdict ? "PASS" : "FAIL"}` : ""}${
                  (verdict.checks ?? [])
                    .map((c: any) => `\n  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`)
                    .join("") || ""
                }${
                  (verdict.summary ?? []).length ? `\n\n${verdict.summary.join("\n")}` : ""
                }`}
          </pre>
        )}
      </div>

      {events.length > 0 && (
        <div className="card">
          <h2>
            Revive events in that block <span className="badge ok">decoded</span>
          </h2>
          <table className="events">
            <thead>
              <tr>
                <th>kind</th>
                <th>contract</th>
                <th>topics</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e: any, i: number) => (
                <tr key={i}>
                  <td>
                    <span className="ev">{e.variant ?? e.kind}</span>
                  </td>
                  <td className="mono">{e.contract ?? e.deployer ?? "—"}</td>
                  <td className="mono">{(e.topics ?? [])[0] ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
