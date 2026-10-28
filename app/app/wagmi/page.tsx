"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { custom, defineChain, erc20Abi, formatUnits } from "viem";
import {
  WagmiProvider,
  createConfig,
  useAccount,
  useChainId,
  useConnect,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { mock } from "wagmi/connectors/mock";

import { TWINKEY_TOKEN_ADDRESS, TWINKEY_TOKEN_SYMBOL } from "@/lib/twinkey/token";

/**
 * /wagmi — the same claim as /viem, one layer up: a wagmi v3 app talking to Portaldot through
 * TwinKey's transport.
 *
 * What is ordinary here: createConfig, WagmiProvider, useReadContract, useWriteContract,
 * useWaitForTransactionReceipt, the mock connector standing in for a wallet, erc20Abi.
 * What is TwinKey: the transport. Everything else is the framework's own code, which is the
 * point — a team porting an existing dApp changes one line.
 *
 * The demo account signs server-side (/api/rpc), so the page says that out loud instead of
 * implying the visitor's key is involved.
 */

const DEMO_H160 = "0xfd2d914eefc568c86f907e29e02dbd2c51c462e7" as const;
const OWNER_H160 = "0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934" as const;

const PORTALDOT_EVM = defineChain({
  id: 420420777,
  name: "Portaldot V3 Test",
  nativeCurrency: { name: "PDOT", symbol: "PDOT", decimals: 18 },
  rpcUrls: { default: { http: ["https://test-evm-rpc-v3.portaldot.dev"] } },
});

/** An EIP-1193 provider object whose `request` is the TwinKey JSON-RPC endpoint. */
function twinKeyProvider() {
  let id = 0;
  return {
    isTwinKey: true as const,
    async request({ method, params }: { method: string; params?: unknown }) {
      const res = await fetch("/api/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
      });
      const json: any = await res.json();
      if (json.error) {
        const err = new Error(json.error.message ?? "rpc error") as Error & { code?: number };
        err.code = json.error.code;
        throw err;
      }
      return json.result;
    },
  };
}

const wagmiConfig = createConfig({
  chains: [PORTALDOT_EVM],
  connectors: [mock({ accounts: [DEMO_H160], features: { defaultConnected: true } })],
  transports: { [PORTALDOT_EVM.id]: custom(twinKeyProvider()) },
});

const queryClient = new QueryClient();

const CODE = `import { createConfig, WagmiProvider, useReadContract, useWriteContract } from "wagmi";
import { custom, defineChain, erc20Abi } from "viem";
import { mock } from "wagmi/connectors/mock";

const chain = defineChain({ id: 420420777, name: "Portaldot V3 Test", … });

const config = createConfig({
  chains: [chain],
  connectors: [mock({ accounts: [H160], features: { defaultConnected: true } })],
  transports: { [chain.id]: custom(twinKeyProvider()) },   // <- the only TwinKey line
});

// below this point it is a normal wagmi app
const { data: balance } = useReadContract({ address: TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [H160] });
const { writeContractAsync } = useWriteContract();
const hash = await writeContractAsync({ address: TOKEN, abi: erc20Abi, functionName: "transfer", args: [TO, 10n ** 18n] });`;

function Panel() {
  const chainId = useChainId();
  const { address, isConnected } = useAccount();
  const { connect, connectors, error: connectError } = useConnect();
  const [log, setLog] = useState<string>("");

  const { data: symbol } = useReadContract({
    address: TWINKEY_TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "symbol",
  });

  const { data: balance, refetch } = useReadContract({
    address: TWINKEY_TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const { writeContractAsync, data: hash, isPending: isWriting } = useWriteContract();
  const { data: receipt, isLoading: isMining, error: receiptError } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (receipt?.status === "success") refetch();
  }, [receipt, refetch]);

  useEffect(() => {
    if (connectError) setLog(`connect error: ${connectError.message.slice(0, 200)}`);
  }, [connectError]);

  const transfer = async () => {
    setLog("eth_sendTransaction → revive.call …");
    try {
      const h = await writeContractAsync({
        address: TWINKEY_TOKEN_ADDRESS,
        abi: erc20Abi,
        functionName: "transfer",
        args: [OWNER_H160, 10n ** 18n],
      });
      setLog(`tx hash   ${h}\nwaiting for the receipt (resolved from the Substrate archive) …`);
    } catch (e: any) {
      setLog(`error: ${e?.shortMessage ?? e?.message ?? String(e)}`);
    }
  };

  return (
    <>
      <div className="card">
        <h2>
          Live <span className="badge ok">wagmi v3</span>
        </h2>
        <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
          <span>
            chainId <b>{chainId}</b>
          </span>
          <span>
            account <b>{address ?? (isConnected ? "—" : "not connected")}</b>
          </span>
          <span>
            token <b>{String(symbol ?? "…")}</b>
          </span>
          <span>
            balance{" "}
            <b>{balance === undefined ? "…" : formatUnits(balance as bigint, 18)}</b>{" "}
            {String(symbol ?? TWINKEY_TOKEN_SYMBOL)}
          </span>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          {!isConnected && (
            <button
              className="primary"
              onClick={() => {
                setLog("connecting the mock connector (stands in for a wallet) …");
                connect({ connector: connectors[0] });
              }}
            >
              connect
            </button>
          )}
          <button className="primary" onClick={transfer} disabled={!isConnected || isWriting || isMining}>
            {(isWriting || isMining) && <span className="spin" />}
            {isWriting ? "signing…" : isMining ? "mining…" : "transfer 1 TKT with wagmi"}
          </button>
          <a href="/viem" rel="noreferrer">
            <button>same thing in plain viem</button>
          </a>
          <a href="/" rel="noreferrer">
            <button>back to the app</button>
          </a>
        </div>
        {hash && <pre className="out">{`tx hash   ${hash}`}</pre>}
        {receipt && (
          <pre className="out">{`block     ${receipt.blockNumber}  status ${receipt.status}  logs ${receipt.logs.length}
transfer  ${receipt.logs.length} log(s) decoded by wagmi from an extrinsic hash the EVM node never saw`}</pre>
        )}
        {receiptError && <pre className="out"><span className="err">receipt: {receiptError.message.slice(0, 300)}</span></pre>}
        {log && <pre className="out">{log}</pre>}
      </div>
    </>
  );
}

export default function WagmiPage() {
  return (
    <div className="wrap">
      <div className="top">
        <div className="brand">
          <span className="dot" />
          TwinKey
        </div>
        <div className="meta">
          <span>
            transport <b>/api/rpc</b>
          </span>
          <span>
            wagmi <b>v3</b>
          </span>
        </div>
      </div>

      <section className="hero">
        <h1>
          wagmi, <em>unchanged</em>
        </h1>
        <p className="lede">
          A wagmi v3 config with one TwinKey line: <code>transports: {"{"} [chain.id]: custom(twinKeyProvider()) {"}"}</code>.
          The hooks below are the framework&apos;s own — <code>useReadContract</code>,{" "}
          <code>useWriteContract</code>, <code>useWaitForTransactionReceipt</code>. The write becomes a
          native <code>revive.call</code> extrinsic signed with an sr25519 key, and the receipt comes back
          from the Substrate archive because this chain&apos;s EVM log index never sees that call.
        </p>
        <p className="lede">
          <strong>Read this honestly:</strong> the demo account signs server-side, so this runs in any
          browser with no extension. A wallet signing in the browser is what the main app does with your
          own key.
        </p>
      </section>

      <div className="card">
        <h2>The config that runs</h2>
        <pre className="out">{CODE}</pre>
      </div>

      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <Panel />
        </QueryClientProvider>
      </WagmiProvider>
    </div>
  );
}
