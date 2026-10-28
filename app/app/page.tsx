"use client";

import { useCallback, useEffect, useState } from "react";

import CallPane from "@/components/call-pane";
import StatusStrip from "@/components/status-strip";

type State = {
  chain: {
    name: string;
    spec: string;
    specVersion: number;
    head: number;
    headHash: string;
    evmChainId: number;
    token: string;
    nativeDecimals: number;
    evmDecimals: number;
  };
  identity: {
    ss58: string;
    h160: string;
    nativeFreeRaw: string;
    nativeFreeFormatted: string;
    evmBalanceWei: string;
    error?: string;
  } | null;
  contract: {
    address: string;
    codeBytes: number;
    state: { value: string; lastCaller: string; callCount: string } | null;
  };
  demoSigning: boolean;
  cached?: boolean;
  apiAgeMs?: number;
  error?: string;
};

type ReviveEvent = {
  blockNumber: number;
  eventIndex: number;
  kind: string;
  contract?: string;
  deployer?: string;
  topics?: string[];
  data?: string;
  parsed?: { eventName: string; args: Record<string, unknown> } | null;
};

const short = (v?: string, head = 8, tail = 6) =>
  !v ? "—" : v.length <= head + tail + 1 ? v : `${v.slice(0, head)}…${v.slice(-tail)}`;

export default function Page() {
  const [state, setState] = useState<State | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [activeSs58, setActiveSs58] = useState<string | null>(null);

  const [extensions, setExtensions] = useState<{ name: string; title: string }[]>([]);
  const [wallet, setWallet] = useState<{ name: string; ss58: string } | null>(null);
  const [walletProvider, setWalletProvider] = useState<any>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  const [events, setEvents] = useState<ReviveEvent[] | null>(null);
  const [scanMeta, setScanMeta] = useState<{ from: number; to: number; scanned: number } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const [lastWrite, setLastWrite] = useState<{ txHash: string; blockNumber: number | null } | null>(null);
  const [verdict, setVerdict] = useState<any>(null);
  const [verifying, setVerifying] = useState<string | null>(null);

  const runVerify = useCallback(async (block: number, mode: "parity" | "report" = "parity") => {
    setVerifying(mode === "report" ? `report:${block}` : `parity:${block}`);
    try {
      const res = await fetch(`/api/parity?block=${block}&mode=${mode}`, { cache: "no-store" });
      const json = await res.json();
      setVerdict({ ...json, requestedBlock: block, mode });
    } catch (e: any) {
      setVerdict({ available: false, error: String(e?.message ?? e), requestedBlock: block });
    } finally {
      setVerifying(null);
    }
  }, []);

  const loadState = useCallback(async (ss58?: string | null) => {
    try {
      const qs = ss58 ? `?ss58=${encodeURIComponent(ss58)}` : "";
      const res = await fetch(`/api/state${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (json.error) throw new Error(json.error + (json.hint ? ` — ${json.hint}` : ""));
      setState(json);
      setStateError(null);
    } catch (e: any) {
      // Keep the previous snapshot on screen: a stale number labelled stale beats a
      // blank pane while the socket rebuilds itself.
      setStateError(String(e?.message ?? e));
    }
  }, []);

  const scan = useCallback(
    async (lookback = 300) => {
      setScanning(true);
      setScanError(null);
      try {
        const head = state?.chain.head;
        const from = head ? Math.max(0, head - lookback) : undefined;
        const qs = from ? `?from=${from}&to=${head}` : `?lookback=${lookback}`;
        const res = await fetch(`/api/events${qs}`, { cache: "no-store" });
        const json = await res.json();
        if (json.error) throw new Error(json.error + (json.hint ? ` — ${json.hint}` : ""));
        setEvents(json.events ?? []);
        setScanMeta({ from: json.from, to: json.to, scanned: json.scanned });
      } catch (e: any) {
        setScanError(String(e?.message ?? e));
      } finally {
        setScanning(false);
      }
    },
    [state?.chain.head],
  );

  useEffect(() => {
    loadState(activeSs58);
  }, [loadState, activeSs58]);

  useEffect(() => {
    import("@/lib/twinkey/extension")
      .then((m) => setExtensions(m.listExtensions().map((e) => ({ name: e.name, title: e.title ?? e.name }))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (state && events === null && !scanning) scan(300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  async function connect(name: string) {
    setConnecting(name);
    setWalletError(null);
    try {
      const [{ getApi }, { createTwinKeyProvider }, { connectExtension }] = await Promise.all([
        import("@/lib/twinkey/chain"),
        import("@/lib/twinkey/provider"),
        import("@/lib/twinkey/extension"),
      ]);
      const api = await getApi();
      const connected = await connectExtension(api, name);
      const provider = createTwinKeyProvider({ signer: connected.signer });
      setWallet({ name: connected.name, ss58: connected.ss58 });
      setActiveSs58(connected.ss58);
      setWalletProvider(provider);
      // The same object a dApp gets. Devtools on this page:
      //   await twinKey.request({ method: "eth_requestAccounts" })
      (window as any).twinKey = provider;
    } catch (e: any) {
      setWalletError(String(e?.message ?? e));
    } finally {
      setConnecting(null);
    }
  }

  function disconnect() {
    setWallet(null);
    setWalletProvider(null);
    setActiveSs58(null);
    delete (window as any).twinKey;
  }

  async function onLanded(info: { txHash: string; blockNumber?: number | null }) {
    setLastWrite({ txHash: info.txHash, blockNumber: info.blockNumber ?? null });
    await loadState(activeSs58);
    scan(300);
    if (info.blockNumber) runVerify(info.blockNumber);
  }

  const c = state?.chain;
  const id = state?.identity;
  const cs = state?.contract.state;
  const zeroBalance = id && !id.error && BigInt(id.nativeFreeRaw || "0") === 0n;

  return (
    <div className="wrap">
      <div className="top">
        <div className="brand">
          <span className="dot" />
          TwinKey
        </div>
        <div className="meta">
          <span>
            chain <b>{c?.name ?? "…"}</b>
          </span>
          <span>
            spec <b>{c ? `${c.spec} v${c.specVersion}` : "…"}</b>
          </span>
          <span>
            block <b>{c?.head?.toLocaleString() ?? "…"}</b>
          </span>
          <span>
            evm chain id <b>{c?.evmChainId ?? "…"}</b>
          </span>
          {state?.cached && <span className="badge">cached 5s</span>}
        </div>
      </div>

      <section className="hero">
        <h1>
          One key. <em>Both runtimes.</em>
        </h1>
        <p className="lede">
          Portaldot V3 gives every account an SS58 address <strong>and</strong> an H160, then asks you to
          install a second wallet with a second seed to use Solidity. TwinKey turns the key you already have
          into a working EVM account — <strong>no second wallet, no seed import, no bridging between your own
          two identities.</strong>
        </p>
        <p className="lede">
          Every number on this page was read from <strong>{c?.name ?? "PortaldotV3 Test"}</strong> seconds ago.
          Nothing is simulated.
        </p>
      </section>

      <StatusStrip />

      <div className="card" style={{ marginTop: 18 }}>
        <h2>Connect the wallet you already have</h2>
        <p className="sub">
          A Substrate wallet signs with sr25519 — the only signature this chain accepts for a contract call.
          TwinKey never sees your seed: the signature happens inside the extension. Once connected the same
          provider is on the page as <code>window.twinKey</code>, for any dApp code.
        </p>
        {wallet ? (
          <div className="row">
            <span className="badge ok">connected · {wallet.name}</span>
            <span className="mono" style={{ fontSize: 12.5 }}>
              {wallet.ss58}
            </span>
            <button onClick={disconnect}>disconnect</button>
          </div>
        ) : extensions.length > 0 ? (
          <div className="row">
            {extensions.map((e) => (
              <button key={e.name} className="primary" onClick={() => connect(e.name)} disabled={!!connecting}>
                {connecting === e.name && <span className="spin" />}
                {connecting === e.name ? "waiting for wallet…" : `Connect ${e.title}`}
              </button>
            ))}
          </div>
        ) : (
          <div className="note">
            No Substrate wallet detected in this browser. Install the{" "}
            <a href="https://polkadot.js.org/extension/" target="_blank" rel="noreferrer">
              polkadot.js extension
            </a>
            , Talisman or SubWallet, then reload — or write with the demo signer below, which signs the same
            transaction type server-side so the flow is identical.
          </div>
        )}
        {walletError && (
          <pre className="out">
            <span className="err">{walletError}</span>
          </pre>
        )}
      </div>

      <div className="grid2" style={{ marginTop: 18 }}>
        <div className="card">
          <h2>
            Your account, both faces <span className="badge ok">resolved on-chain</span>
          </h2>
          <p className="sub">
            The H160 is asked of the runtime API <code>ReviveApi_address</code> — never derived locally. The
            mapping is not a truncation or a hash of the public key, so any client that computes it itself
            produces the wrong address.
          </p>
          {stateError && <div className="note">state unavailable: {stateError}</div>}
          {id && !id.error && (
            <div className="ident">
              <span className="k">SS58 (signs)</span>
              <span className="v">{id.ss58}</span>
              <span className="k">H160 (msg.sender)</span>
              <span className="v">{id.h160}</span>
              <span className="k">native free</span>
              <span className="v">
                {id.nativeFreeFormatted} tPOT <span className="badge">{c?.nativeDecimals} dec</span>
              </span>
              <span className="k">EVM balance</span>
              <span className="v">
                {(Number(BigInt(id.evmBalanceWei)) / 1e18).toFixed(4)} tPOT{" "}
                <span className="badge">{c?.evmDecimals} dec</span>
              </span>
            </div>
          )}
          {id?.error && <div className="note">mapping failed: {id.error}</div>}
          {!id && !stateError && <div className="empty">reading chain…</div>}
          {zeroBalance && (
            <div className="note">
              This account holds <b>0 tPOT</b>, so a write is rejected before it is included. There is no public
              faucet on this testnet (verified) — funds arrive only from the organiser.
            </div>
          )}
        </div>

        <div className="card">
          <h2>
            Live contract state <span className="badge ok">eth_call</span>
          </h2>
          <p className="sub">
            TwinKeyProbe at <code>{short(state?.contract.address, 10, 8)}</code> —{" "}
            {state?.contract.codeBytes ?? "…"} bytes of runtime, read over the standard EVM JSON-RPC straight
            from the endpoint. No Substrate involvement.
          </p>
          <div className="tiles">
            <div>
              <small>value</small>
              <strong>{cs?.value ?? "—"}</strong>
            </div>
            <div>
              <small>callCount</small>
              <strong>{cs?.callCount ?? "—"}</strong>
            </div>
            <div>
              <small>lastCaller</small>
              <strong className="addr">{short(cs?.lastCaller, 6, 4)}</strong>
            </div>
          </div>
          <p className="sub" style={{ marginBottom: 0 }}>
            The pane below defaults to this contract and writes to any other you name.
          </p>
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <CallPane
          walletProvider={walletProvider}
          demoSigning={Boolean(state?.demoSigning)}
          onLanded={onLanded}
        />
      </div>

      {lastWrite && (
        <div className="card" style={{ marginTop: 18 }}>
          <h2>
            Your last write <span className="badge ok">permalink</span>
          </h2>
          <p className="sub">
            Every artifact here has a URL that renders it without the app being healthy: a judge can open the
            receipt on its own.
          </p>
          <pre className="out">{`tx hash     ${lastWrite.txHash}
block       ${lastWrite.blockNumber ?? "pending"}
receipt     /tx/${lastWrite.txHash}${lastWrite.blockNumber ? `\nblock view  /block/${lastWrite.blockNumber}` : ""}`}</pre>
          <div className="row">
            <a
              href={`/tx/${lastWrite.txHash}${lastWrite.blockNumber ? `?block=${lastWrite.blockNumber}` : ""}`}
              target="_blank"
              rel="noreferrer"
            >
              <button>open /tx/{short(lastWrite.txHash, 8, 6)}</button>
            </a>
            {lastWrite.blockNumber && (
              <a href={`/block/${lastWrite.blockNumber}`} target="_blank" rel="noreferrer">
                <button>open /block/{lastWrite.blockNumber}</button>
              </a>
            )}
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 18 }}>
        <h2>
          EVM events, decoded <span className="badge warn">read from Substrate, not eth_getLogs</span>
        </h2>
        <p className="sub">
          The EVM endpoint&apos;s log index omits logs emitted by native-origin <code>revive.call</code> —
          including our own contract&apos;s. So this scans the Substrate event stream and decodes{" "}
          <code>revive.ContractEmitted</code> against the ABI instead, which is the only complete view of what
          happened on this chain.
        </p>
        <div className="row" style={{ marginBottom: 6 }}>
          <button onClick={() => scan(300)} disabled={scanning}>
            {scanning && <span className="spin" />}
            {scanning ? "scanning…" : "rescan last 300 blocks"}
          </button>
          <button onClick={() => scan(1200)} disabled={scanning}>
            last 1200 blocks
          </button>
          {scanMeta && (
            <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
              blocks {scanMeta.from.toLocaleString()}–{scanMeta.to.toLocaleString()} ({scanMeta.scanned}{" "}
              scanned)
            </span>
          )}
        </div>

        {scanError && (
          <pre className="out">
            <span className="err">error: {scanError}</span>
          </pre>
        )}
        {events && events.length === 0 && !scanning && (
          <div className="empty">
            No revive events in this window. Contract calls on this chain are rare — try a wider scan, or run a
            write above and rescan.
          </div>
        )}
        {events && events.length > 0 && (
          <table className="events">
            <thead>
              <tr>
                <th>block</th>
                <th>kind</th>
                <th>contract</th>
                <th>decoded</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={`${e.blockNumber}-${e.eventIndex}`}>
                  <td className="mono">{e.blockNumber}</td>
                  <td>
                    <span className="ev">{e.kind}</span>
                  </td>
                  <td className="mono">{short(e.contract, 8, 6)}</td>
                  <td className="mono">
                    {e.parsed
                      ? `${e.parsed.eventName}(${Object.entries(e.parsed.args)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(", ")})`
                      : e.deployer
                        ? `deployer ${short(e.deployer, 8, 6)}`
                        : short(e.topics?.[0], 10, 6)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <h2>
          Independent verdict <span className="badge">Rust verifier, separate process</span>
        </h2>
        <p className="sub">
          A second implementation with its own RPC readers re-reads the same block from the archive node and
          checks that the sender is the account&apos;s mapped H160 and that the EVM-visible state agrees with the
          emitted log. When it is down, this says so rather than inventing a verdict.
        </p>
        <div className="row" style={{ marginBottom: 8 }}>
          {lastWrite?.blockNumber && (
            <button className="primary" onClick={() => runVerify(lastWrite.blockNumber!)} disabled={!!verifying}>
              {verifying === `parity:${lastWrite.blockNumber}` && <span className="spin" />}
              verify your write (block {lastWrite.blockNumber})
            </button>
          )}
          {state && (
            <button onClick={() => runVerify(state.chain.head)} disabled={!!verifying}>
              {verifying === `parity:${state.chain.head}` && <span className="spin" />}
              verify head
            </button>
          )}
          <button onClick={() => runVerify(90995)} disabled={!!verifying}>
            first call, block 90995
          </button>
          <button onClick={() => runVerify(90990, "report")} disabled={!!verifying}>
            deploy block 90990 (report)
          </button>
        </div>
        {verdict && (
          <pre className="out">
            {verdict.available === false ? (
              <>
                <span className="err">{verdict.error}</span>
                {`\n${verdict.hint ?? ""}\ndetail: ${verdict.detail ?? ""}`}
              </>
            ) : (
              <>
                <span className={verdict.verdict === false ? "err" : "ok"}>
                  {verdict.verdict === undefined
                    ? `block ${verdict.requestedBlock} — report (${verdict.revive_event_count ?? verdict.revive_events?.length ?? 0} revive event(s))`
                    : `block ${verdict.requestedBlock} — verdict: ${verdict.verdict ? "PASS" : "FAIL"}`}
                </span>
                {verdict.checks
                  ? "\n" +
                    verdict.checks
                      .map((ch: any) => `  ${ch.ok ? "ok  " : "FAIL"} ${ch.name}: ${ch.detail}`)
                      .join("\n")
                  : ""}
                {(verdict.summary ?? verdict.notes)
                  ? "\n" +
                    (Array.isArray(verdict.summary ?? verdict.notes)
                      ? (verdict.summary ?? verdict.notes).join("\n")
                      : (verdict.summary ?? verdict.notes))
                  : ""}
                {verdict.policy ? `\npolicy: ${verdict.policy.history}` : ""}
              </>
            )}
          </pre>
        )}
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <h2>What a dApp developer changes: one line</h2>
        <p className="sub">
          Existing <code>viem</code> / <code>wagmi</code> / <code>ethers</code> code keeps working. The provider
          answers <code>eth_call</code>, <code>eth_estimateGas</code>, <code>eth_sendTransaction</code> and{" "}
          <code>eth_getTransactionReceipt</code> — the write goes out as a Substrate extrinsic signed by the
          user&apos;s own key. Connect a wallet above and this object is live on the page as{" "}
          <code>window.twinKey</code>.
        </p>
        <pre className="out">{`import { createWalletClient, custom } from "viem";
const twinKey = window.twinKey;               // or createTwinKeyProvider({ signer })

const wallet = createWalletClient({ transport: custom(twinKey) });
const hash = await wallet.writeContract({
  address: "0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725",
  abi, functionName: "setValue", args: [2077n],
});
const receipt = await wallet.waitForTransactionReceipt({ hash });
// receipt.logs[0].parsed -> { eventName: "ValueSet", args: { caller, value, callCount } }`}</pre>
        <div className="note" style={{ marginTop: 16 }}>
          <b>Why the write cannot just be an EVM transaction:</b> on this testnet build an external EOA cannot
          send one at all — every transaction type, fee and gas combination returns{" "}
          <code>Invalid Transaction</code>, while reads work normally. The native <code>revive.call</code> path
          is the only write path that exists, and it requires an sr25519 signature. That is the technical wall
          TwinKey is built on, and it is why a plain wallet adapter is not enough.
        </div>
      </div>

      <footer>
        <span>
          Portaldot Hacker House 2026 · Modular Cloud &amp; Middleware ·{" "}
          <a href="https://github.com/memeshee/twinkey">github.com/memeshee/twinkey</a>
        </span>
        <span>
          <a href="/viem">unmodified viem</a> · <a href="/wagmi">wagmi</a> · <a href="/pitfalls">pitfalls</a> ·{" "}
          <a href="/traps.json">traps.json</a> · contract{" "}
          <span className="mono">{short(state?.contract.address, 10, 6)}</span>
        </span>
      </footer>
    </div>
  );
}
