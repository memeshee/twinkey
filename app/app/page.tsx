"use client";

import { useCallback, useEffect, useState } from "react";

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

type WriteResult = {
  signedBy: string;
  mappedH160: string;
  txHash: string;
  receipt: any;
  elapsedMs: number;
  path: string;
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

  const [value, setValue] = useState("31337");
  const [writing, setWriting] = useState(false);
  const [writeResult, setWriteResult] = useState<WriteResult | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  const [events, setEvents] = useState<ReviveEvent[] | null>(null);
  const [scanMeta, setScanMeta] = useState<{ from: number; to: number; scanned: number } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const loadState = useCallback(async (ss58?: string | null) => {
    try {
      const qs = ss58 ? `?ss58=${encodeURIComponent(ss58)}` : "";
      const res = await fetch(`/api/state${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setState(json);
      setStateError(null);
    } catch (e: any) {
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
        if (json.error) throw new Error(json.error);
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
    // Wallet detection is client-only.
    import("@/lib/twinkey/extension")
      .then((m) => setExtensions(m.listExtensions().map((e) => ({ name: e.name, title: e.title ?? e.name }))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (state && events === null && !scanning) scan(300);
  }, [state, events, scanning, scan]);

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
      setWallet({ name: connected.name, ss58: connected.ss58 });
      setActiveSs58(connected.ss58);
      setWalletProvider(createTwinKeyProvider({ signer: connected.signer }));
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
    setWriteResult(null);
  }

  async function runWrite() {
    setWriting(true);
    setWriteError(null);
    setWriteResult(null);
    const started = Date.now();
    try {
      const { encodeFunctionData } = await import("viem");
      const { TWINKEY_PROBE_ABI, TWINKEY_PROBE_ADDRESS } = await import("@/lib/twinkey/abi");
      const data = encodeFunctionData({
        abi: TWINKEY_PROBE_ABI,
        functionName: "setValue",
        args: [BigInt(value || "0")],
      });

      if (walletProvider) {
        // ---- in-browser path: the user's own wallet extension signs the extrinsic -------------
        const [h160] = (await walletProvider.request({ method: "eth_requestAccounts" })) as string[];
        const txHash = (await walletProvider.request({
          method: "eth_sendTransaction",
          params: [{ from: h160, to: TWINKEY_PROBE_ADDRESS, data, value: "0x0" }],
        })) as string;
        const receipt = await walletProvider.request({
          method: "eth_getTransactionReceipt",
          params: [txHash],
        });
        setWriteResult({
          signedBy: wallet!.ss58,
          mappedH160: h160,
          txHash,
          receipt,
          elapsedMs: Date.now() - started,
          path: "revive.call signed in your wallet",
        });
      } else {
        // ---- server path: the demo signer, for judges without an extension --------------------
        const res = await fetch("/api/demo-write", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: Number(value || "0"), action: "set" }),
        });
        const json = await res.json();
        if (json.error) throw new Error(json.error + (json.hint ? ` — ${json.hint}` : ""));
        setWriteResult(json);
      }
      // The write is done at this point; refreshing the page data must not keep the button
      // spinning, because a 300-block rescan takes several seconds.
      setWriting(false);
      await loadState(activeSs58);
      scan(300);
    } catch (e: any) {
      setWriteError(String(e?.message ?? e));
      setWriting(false);
    }
  }

  const c = state?.chain;
  const id = state?.identity;
  const cs = state?.contract.state;
  const decoded = writeResult?.receipt?.logs?.find((l: any) => l?.parsed)?.parsed;
  const canWrite = Boolean(walletProvider) || Boolean(state?.demoSigning);

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
        </div>
      </div>

      <section className="hero">
        <h1>
          One key. <em>Both runtimes.</em>
        </h1>
        <p className="lede">
          Portaldot V3 gives every account an SS58 address <strong>and</strong> an H160, then asks you to
          install a second wallet with a second seed to use Solidity. TwinKey turns the key you already
          have into a working EVM account — <strong>no second wallet, no seed import, no bridging between
          your own two identities.</strong>
        </p>
        <p className="lede">
          Every number on this page was read from <strong>PortaldotV3 Test</strong> seconds ago.
        </p>
      </section>

      {/* ---------------- wallet ---------------- */}
      <div className="card">
        <h2>Connect the wallet you already have</h2>
        <p className="sub">
          A Substrate wallet signs with sr25519 — the only signature this chain accepts for a contract
          call. TwinKey never sees your seed: the signature happens inside the extension.
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
            , Talisman or SubWallet, then reload — or use the demo signer below, which signs the same
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
        {/* ---------------- identity ---------------- */}
        <div className="card">
          <h2>
            Your account, both faces <span className="badge ok">resolved on-chain</span>
          </h2>
          <p className="sub">
            The H160 is asked of the runtime API <code>ReviveApi_address</code> — never derived locally.
            The mapping is not a truncation or a hash of the public key, so any client that computes it
            itself produces the wrong address.
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
        </div>

        {/* ---------------- contract + write ---------------- */}
        <div className="card">
          <h2>
            Live contract state <span className="badge ok">eth_call</span>
          </h2>
          <p className="sub">
            TwinKeyProbe at <code>{short(state?.contract.address, 10, 8)}</code> —{" "}
            {state?.contract.codeBytes ?? "…"} bytes of runtime. Read over the standard EVM JSON-RPC.
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

          <div className="row">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ""))}
              aria-label="value to set"
              inputMode="numeric"
            />
            <button className="primary" onClick={runWrite} disabled={writing || !canWrite}>
              {writing && <span className="spin" />}
              {writing
                ? walletProvider
                  ? "waiting for your signature…"
                  : "signing revive.call…"
                : `setValue(${value || 0}) on-chain`}
            </button>
          </div>
          <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
            {walletProvider
              ? "Signs in your wallet, submits revive.call, decodes the emitted EVM log."
              : state?.demoSigning
                ? "Using the demo signer: an sr25519 key signs a real revive.call. Rate limited to 3/min."
                : "Demo signing is off on this deployment — connect a wallet above to write."}
          </p>

          {writeError && (
            <pre className="out">
              <span className="err">error: {writeError}</span>
            </pre>
          )}
          {writeResult && (
            <pre className="out">
              <span className="ok">✓ included — {writeResult.path}</span>
              {`
signed by     ${writeResult.signedBy}
mapped H160   ${writeResult.mappedH160}
tx hash       ${writeResult.txHash}
block         ${writeResult.receipt?.blockNumber} (${BigInt(writeResult.receipt?.blockNumber ?? "0x0")})
gas used      ${BigInt(writeResult.receipt?.gasUsed ?? "0x0").toString()}
status        ${writeResult.receipt?.status}
elapsed       ${writeResult.elapsedMs} ms
${
  decoded
    ? `
decoded EVM log
  ${decoded.eventName}(${Object.entries(decoded.args)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")})
  topic0  ${writeResult.receipt.logs.find((l: any) => l?.parsed)?.topics?.[0]}`
    : ""
}`}
            </pre>
          )}
        </div>
      </div>

      {/* ---------------- event feed ---------------- */}
      <div className="card" style={{ marginTop: 18 }}>
        <h2>
          EVM events, decoded <span className="badge warn">read from Substrate, not eth_getLogs</span>
        </h2>
        <p className="sub">
          The EVM endpoint&apos;s log index omits logs emitted by native-origin <code>revive.call</code> —
          including our own contract&apos;s. So this scans the Substrate event stream and decodes{" "}
          <code>revive.ContractEmitted</code> against the ABI instead.
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
            No revive events in this window. Contract calls on this chain are rare — try a wider scan, or
            run a write above and rescan.
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

      {/* ---------------- provider snippet ---------------- */}
      <div className="card" style={{ marginTop: 18 }}>
        <h2>What a dApp developer changes: one line</h2>
        <p className="sub">
          Existing <code>viem</code> / <code>wagmi</code> / <code>ethers</code> code keeps working. The
          provider answers <code>eth_call</code>, <code>eth_estimateGas</code>,{" "}
          <code>eth_sendTransaction</code> and <code>eth_getTransactionReceipt</code> — the write goes out
          as a Substrate extrinsic signed by the user&apos;s own key.
        </p>
        <pre className="out">{`import { createWalletClient, custom } from "viem";
import { createTwinKeyProvider } from "twinkey";

const twinKey = createTwinKeyProvider({ signer });   // polkadot.js, Talisman, SubWallet

const wallet = createWalletClient({ transport: custom(twinKey) });
const hash = await wallet.writeContract({
  address: "0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725",
  abi, functionName: "setValue", args: [2077n],
});

const receipt = await wallet.waitForTransactionReceipt({ hash });
// receipt.logs[0].parsed -> { eventName: "ValueSet", args: { caller, value, callCount } }`}</pre>
        <div className="note" style={{ marginTop: 16 }}>
          <b>Why the write cannot just be an EVM transaction:</b> on this testnet build an external EOA
          cannot send one at all — every transaction type, fee and gas combination returns{" "}
          <code>Invalid Transaction</code>, while reads work normally. The native{" "}
          <code>revive.call</code> path is the only write path that exists, and it requires an sr25519
          signature. That is the technical wall TwinKey is built on, and it is why a plain wallet adapter
          is not enough.
        </div>
      </div>

      <footer>
        <span>
          Portaldot Hacker House 2026 · Modular Cloud &amp; Middleware ·{" "}
          <a href="https://github.com/memeshee/twinkey">github.com/memeshee/twinkey</a>
        </span>
        <span>
          contract <span className="mono">{short(state?.contract.address, 10, 6)}</span>
        </span>
      </footer>
    </div>
  );
}
