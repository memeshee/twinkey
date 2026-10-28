"use client";

import { useCallback, useState } from "react";

import { TWINKEY_TOKEN_ABI, TWINKEY_TOKEN_ADDRESS, TWINKEY_TOKEN_SYMBOL } from "@/lib/twinkey/token";

/**
 * /viem — unmodified viem code against a Substrate-signed JSON-RPC endpoint.
 *
 * The claim the whole project rests on is "standard EVM tooling works". So this
 * page contains no TwinKey-specific call: `createPublicClient` and
 * `createWalletClient` with `http("/api/rpc")`, then `readContract` /
 * `writeContract` / `waitForTransactionReceipt`. The only thing that is not
 * ordinary EVM code is the URL, and the write signature that reaches the chain is
 * sr25519 rather than secp256k1 because there is no EVM write path on this build.
 *
 * The signer behind /api/rpc is the demo account, and the page says so: reading
 * this as "your wallet signs" would be false. The app's own pane is where a
 * visitor's own wallet signs.
 */

const CODE = `import { createPublicClient, createWalletClient, http, erc20Abi, formatUnits } from "viem";

// one line differs from any other EVM project: the transport URL
const transport = http("/api/rpc");
const publicClient = createPublicClient({ transport });
const walletClient = createWalletClient({ transport });

const [from] = await walletClient.getAddresses();
const before = await publicClient.readContract({
  address: TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [from],
});

const hash = await walletClient.writeContract({
  address: TOKEN, abi: erc20Abi, functionName: "transfer",
  args: [TO, 10n ** 18n], account: from,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
// receipt.logs[0] -> Transfer(from, to, value), decoded by viem, from the receipt`;

export default function ViemPage() {
  const [log, setLog] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<string>("0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934");

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setLog("connecting to /api/rpc …");
    try {
      const viem = await import("viem");
      const { createPublicClient, createWalletClient, http, erc20Abi, formatUnits } = viem;
      const transport = http("/api/rpc", { timeout: 40_000 });
      const publicClient = createPublicClient({ transport });
      const walletClient = createWalletClient({ transport });

      const [from] = await walletClient.getAddresses();
      setLog(`account   ${from}\nreading balanceOf …`);

      const symbol = (await publicClient.readContract({
        address: TWINKEY_TOKEN_ADDRESS,
        abi: TWINKEY_TOKEN_ABI as any,
        functionName: "symbol",
      })) as string;

      const before = (await publicClient.readContract({
        address: TWINKEY_TOKEN_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [from as `0x${string}`],
      })) as bigint;

      const recipientBal = (await publicClient.readContract({
        address: TWINKEY_TOKEN_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [recipient as `0x${string}`],
      })) as bigint;

      setLog(
        `account   ${from}\ntoken     ${symbol} at ${TWINKEY_TOKEN_ADDRESS}\n` +
          `balance   ${formatUnits(before, 18)} (sender)\n` +
          `          ${formatUnits(recipientBal, 18)} (recipient)\n\nwriting transfer(recipient, 1) …`,
      );

      const hash = await walletClient.writeContract({
        address: TWINKEY_TOKEN_ADDRESS,
        abi: erc20Abi,
        functionName: "transfer",
        args: [recipient as `0x${string}`, 10n ** 18n],
        account: from as `0x${string}`,
        chain: null,
      });

      setLog((l) => `${l}\ntx hash   ${hash}\nwaiting for the receipt (resolved from the Substrate archive) …`);

      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });

      const after = (await publicClient.readContract({
        address: TWINKEY_TOKEN_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [from as `0x${string}`],
      })) as bigint;

      const transferLog = receipt.logs.find(
        (l) => l.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      );

      setLog(
        `account   ${from}\ntx hash   ${hash}\nblock     ${receipt.blockNumber} (${receipt.blockHash})\n` +
          `status    ${receipt.status}\n` +
          `log       ${transferLog ? transferLog.address : "(no Transfer topic)"}\n` +
          `topics    ${transferLog?.topics.slice(0, 3).join(" ") ?? ""}\n` +
          `value     ${transferLog ? formatUnits(BigInt(transferLog.data), 18) : "?"} ${symbol}\n` +
          `balance   ${formatUnits(before, 18)} → ${formatUnits(after, 18)}\n` +
          `\n/block/${receipt.blockNumber}  ·  /tx/${hash}?block=${receipt.blockNumber}`,
      );
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [recipient]);

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
            token <b>{TWINKEY_TOKEN_SYMBOL}</b>
          </span>
        </div>
      </div>

      <section className="hero">
        <h1>
          Unmodified <em>viem</em>
        </h1>
        <p className="lede">
          Below is ordinary EVM client code — <code>createPublicClient</code>,{" "}
          <code>createWalletClient</code>, <code>readContract</code>, <code>writeContract</code>,{" "}
          <code>waitForTransactionReceipt</code> — pointed at a TwinKey JSON-RPC endpoint. The write becomes a
          native <code>revive.call</code> extrinsic; the receipt is resolved from the Substrate archive, because
          the EVM log index on this chain omits native-origin calls entirely.
        </p>
        <p className="lede">
          <strong>Read this honestly:</strong> the key signing here is the deployment&apos;s demo account, not
          yours — that is what makes the demo runnable in a browser with no extension. To sign as yourself,
          connect your wallet in the app.
        </p>
      </section>

      <div className="card">
        <h2>The code that runs</h2>
        <pre className="out">{CODE}</pre>
      </div>

      <div className="card">
        <h2>
          Run it <span className="badge ok">live chain</span>
        </h2>
        <div className="row">
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value.trim())}
            aria-label="recipient"
            spellCheck={false}
            style={{ minWidth: 330 }}
          />
          <button className="primary" onClick={run} disabled={busy}>
            {busy && <span className="spin" />}
            {busy ? "running…" : "read + write 1 TKT"}
          </button>
          <a href="/" rel="noreferrer">
            <button>back to the app</button>
          </a>
        </div>
        {error && (
          <pre className="out">
            <span className="err">error: {error}</span>
          </pre>
        )}
        {log && <pre className="out">{log}</pre>}
      </div>
    </div>
  );
}
