import Link from "next/link";

import { decodeLog } from "@/lib/twinkey/logs";
import { scanRange } from "@/lib/twinkey/scan";
import { TWINKEY_PROBE_ABI, TWINKEY_PROBE_ADDRESS } from "@/lib/twinkey/abi";

export const dynamic = "force-dynamic";

const VERIFIER = process.env.TWINKEY_VERIFIER_URL ?? "https://twinkey-verifier.onrender.com";

async function verifier(path: string): Promise<any> {
  try {
    const res = await fetch(`${VERIFIER}${path}`, { cache: "no-store", signal: AbortSignal.timeout(25_000) });
    return await res.json();
  } catch (e: any) {
    return { available: false, error: String(e?.message ?? e), verifier: VERIFIER };
  }
}

/**
 * /block/:number — one block, rendered on the server, no client state involved.
 *
 * The point of a permalink is that it survives the app being unhealthy: this page
 * reads the archive node and the independent verifier and prints what it finds,
 * and it is honest about the parts that are missing.
 */
export default async function BlockPage({ params }: { params: Promise<{ n: string }> }) {
  const { n } = await params;
  const number = Number(n);

  if (!Number.isInteger(number) || number < 0) {
    return (
      <div className="wrap">
        <h1>bad block</h1>
        <p className="lede">
          {n} is not a block number. <Link href="/">back to the app</Link>
        </p>
      </div>
    );
  }

  const decode = (topics: string[], data: string) =>
    decodeLog({ topics: topics as any, data: data as `0x${string}` }, TWINKEY_PROBE_ABI);

  const [scan, verdict] = await Promise.all([
    scanRange(number, number, decode).catch((e) => ({ error: String(e?.message ?? e), events: [] as any[] })),
    verifier(`/verify/block/${number}`),
  ]);

  const events: any[] = (scan as any).events ?? [];

  return (
    <div className="wrap">
      <div className="top">
        <div className="brand">
          <span className="dot" />
          TwinKey
        </div>
        <div className="meta">
          <span>
            block <b>{number.toLocaleString()}</b>
          </span>
          <span>
            verifier <b>{verdict.available === false ? "unreachable" : "answered"}</b>
          </span>
        </div>
      </div>

      <section className="hero">
        <h1>
          Block <em>{number.toLocaleString()}</em>
        </h1>
        <p className="lede">
          Read from the Substrate archive node and cross-checked by an independent Rust verifier. This page is
          server-rendered, so it renders the same whether or not the rest of the app is healthy.
        </p>
      </section>

      <div className="card">
        <h2>
          Revive events <span className="badge ok">from Substrate, not eth_getLogs</span>
        </h2>
        {(scan as any).error && <div className="note">scan failed: {(scan as any).error}</div>}
        {events.length === 0 && !(scan as any).error && (
          <div className="empty">no revive events in this block</div>
        )}
        {events.length > 0 && (
          <table className="events">
            <thead>
              <tr>
                <th>kind</th>
                <th>contract</th>
                <th>decoded</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td>
                    <span className="ev">{e.kind}</span>
                  </td>
                  <td className="mono">{e.contract ?? e.deployer ?? "—"}</td>
                  <td className="mono">
                    {e.parsed
                      ? `${e.parsed.eventName}(${Object.entries(e.parsed.args)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(", ")})`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>
          Independent verdict <span className="badge">Rust verifier</span>
        </h2>
        {verdict.available === false ? (
          <pre className="out">
            <span className="err">verifier unreachable</span>
            {`\n${verdict.error ?? ""}\ncurl ${VERIFIER}/verify/block/${number}`}
          </pre>
        ) : (
          <pre className="out">{`verdict   ${verdict.verdict === undefined ? "report" : verdict.verdict ? "PASS" : "FAIL"}
${
  (verdict.checks ?? [])
    .map((c: any) => `  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`)
    .join("\n") || ""
}${
            (verdict.summary ?? []).length ? `\n${(verdict.summary ?? []).join("\n")}` : ""
          }`}</pre>
        )}
        <div className="row">
          <a href={`${VERIFIER}/verify/block/${number}`} target="_blank" rel="noreferrer">
            <button>raw JSON (verifier)</button>
          </a>
          <Link href={`/tx/${TWINKEY_PROBE_ADDRESS}`}>
            <button>probe contract</button>
          </Link>
          <Link href="/">
            <button>back to the app</button>
          </Link>
        </div>
      </div>
    </div>
  );
}
