import Link from "next/link";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-static";

type Trap = {
  id: string;
  title: string;
  symptom: string;
  check: string;
  cost: string;
  workaround: string;
  evidence: string;
  severity: string;
};

/**
 * /pitfalls — the ecosystem contribution, as a page rather than a paragraph.
 *
 * Every entry was measured on this testnet while building TwinKey, and each one is
 * something that cost real time or produced silently wrong data. The machine
 * version is /traps.json so another team can consume it instead of re-deriving it.
 */
export default function PitfallsPage() {
  const raw = fs.readFileSync(path.join(process.cwd(), "public", "traps.json"), "utf8");
  const doc = JSON.parse(raw) as { title: string; subtitle: string; traps: Trap[]; generated: string };

  return (
    <div className="wrap">
      <div className="top">
        <div className="brand">
          <span className="dot" />
          TwinKey
        </div>
        <div className="meta">
          <span>
            traps <b>{doc.traps.length}</b>
          </span>
          <span>
            measured <b>{doc.generated}</b>
          </span>
        </div>
      </div>

      <section className="hero">
        <h1>
          Portaldot V3 <em>pitfalls</em>
        </h1>
        <p className="lede">{doc.subtitle}</p>
        <p className="lede">
          Machine-readable: <a href="/traps.json">/traps.json</a> · everything here is reproducible with the
          command shown
        </p>
      </section>

      {doc.traps.map((t, i) => (
        <div className="card" key={t.id} id={t.id}>
          <h2>
            {i + 1}. {t.title}{" "}
            <span className={`badge ${t.severity === "blocking" ? "warn" : ""}`}>{t.severity}</span>
          </h2>
          <p className="sub">{t.symptom}</p>
          <div className="ident">
            <span className="k">check</span>
            <span className="v mono" style={{ fontSize: 12 }}>
              {t.check}
            </span>
            <span className="k">cost</span>
            <span className="v">{t.cost}</span>
            <span className="k">instead</span>
            <span className="v">{t.workaround}</span>
            <span className="k">evidence</span>
            <span className="v mono" style={{ fontSize: 12 }}>
              {t.evidence}
            </span>
          </div>
        </div>
      ))}

      <div className="card">
        <h2>Why this page exists</h2>
        <p className="sub">
          Each of these is a place where the chain behaves differently from what an EVM developer expects, and
          none of them is documented in one place. TwinKey only exists because of the first two; the rest are
          the cost of finding out.
        </p>
        <div className="row">
          <Link href="/">
            <button>back to the app</button>
          </Link>
          <a href="/traps.json" target="_blank" rel="noreferrer">
            <button>raw traps.json</button>
          </a>
          <Link href="/viem">
            <button>see viem run unmodified</button>
          </Link>
        </div>
      </div>
    </div>
  );
}
