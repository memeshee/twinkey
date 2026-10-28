"use client";

import { useCallback, useMemo, useState } from "react";

import { TWINKEY_PROBE_ABI, TWINKEY_PROBE_ADDRESS } from "@/lib/twinkey/abi";

/**
 * The generic call surface.
 *
 * The first version of this app could only call one hardcoded function on one
 * hardcoded contract, which made the product look like a demo of the mechanism
 * rather than a tool that uses it. This pane takes any address, any JSON ABI and
 * any function: reads go straight to the EVM endpoint, writes are signed as
 * `revive.call` — by the connected Substrate wallet if there is one, otherwise by
 * the server-side demo signer so a judge with no extension can still execute.
 */

const SHORT = (v?: string, head = 10, tail = 8) =>
  !v ? "—" : v.length <= head + tail + 1 ? v : `${v.slice(0, head)}…${v.slice(-tail)}`;

const DEFAULT_ABI = JSON.stringify(TWINKEY_PROBE_ABI as any, null, 0);

type FnAbi = {
  type: string;
  name: string;
  inputs: { name: string; type: string }[];
  outputs?: { name: string; type: string }[];
  stateMutability?: string;
};

export default function CallPane({
  walletProvider,
  demoSigning,
  onLanded,
}: {
  walletProvider: any | null;
  demoSigning: boolean;
  onLanded: (info: { txHash: string; blockNumber?: number | null }) => void;
}) {
  const [address, setAddress] = useState<string>(TWINKEY_PROBE_ADDRESS);
  const [abiText, setAbiText] = useState<string>(DEFAULT_ABI);
  const [fnName, setFnName] = useState<string>("setValue");
  const [args, setArgs] = useState<string[]>(["2026"]);
  const [value, setValue] = useState<string>("0");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const abi = useMemo<FnAbi[] | null>(() => {
    try {
      const parsed = JSON.parse(abiText);
      const arr = Array.isArray(parsed) ? parsed : parsed?.abi;
      if (!Array.isArray(arr)) return null;
      return arr as FnAbi[];
    } catch {
      return null;
    }
  }, [abiText]);

  const functions = useMemo(() => (abi ?? []).filter((e) => e.type === "function"), [abi]);
  const selected = functions.find((f) => f.name === fnName) ?? functions[0] ?? null;
  const isView = selected?.stateMutability === "view" || selected?.stateMutability === "pure";
  const isPayable = selected?.stateMutability === "payable";

  const pick = useCallback(
    (name: string) => {
      setFnName(name);
      const fn = functions.find((f) => f.name === name);
      setArgs((fn?.inputs ?? []).map(() => ""));
      setResult(null);
      setError(null);
    },
    [functions],
  );

  // Keep the arg row in sync when a new ABI arrives.
  const argCount = selected?.inputs.length ?? 0;
  const argValues = Array.from({ length: argCount }, (_, i) => args[i] ?? "");

  const encode = useCallback(async (): Promise<string> => {
    const { encodeFunctionData } = await import("viem");
    if (!selected) throw new Error("no function selected — paste a JSON ABI first");
    const parsedArgs = argValues.map((raw, i) => {
      const type = selected.inputs[i]?.type ?? "";
      if (/^u?int/.test(type)) return BigInt(raw || "0");
      if (type === "bool") return raw === "true";
      return raw;
    });
    return encodeFunctionData({
      abi: (abi ?? []) as any,
      functionName: selected.name,
      args: parsedArgs as any,
    });
  }, [abi, argValues, selected]);

  async function read() {
    setBusy("read");
    setError(null);
    setResult(null);
    try {
      const data = await encode();
      let raw: string;
      if (walletProvider) {
        raw = (await walletProvider.request({ method: "eth_call", params: [{ to: address, data }, "latest"] })) as string;
      } else {
        const res = await fetch("/api/read", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: address, data }),
        });
        const json = await res.json();
        if (json.error) throw new Error(json.error);
        raw = json.result;
      }
      let decoded: unknown = null;
      if (selected?.outputs?.length && raw && raw !== "0x") {
        try {
          const { decodeFunctionResult } = await import("viem");
          decoded = decodeFunctionResult({ abi: (abi ?? []) as any, functionName: selected.name, data: raw as `0x${string}` });
        } catch {
          decoded = null;
        }
      }
      setResult({ kind: "read", data, raw, decoded });
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function estimate() {
    setBusy("estimate");
    setError(null);
    setResult(null);
    try {
      const data = await encode();
      const res = await fetch("/api/estimate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: address, data, value: String(BigInt(value || "0")) }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setResult({ kind: "estimate", data, ...json });
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function write() {
    setBusy("write");
    setError(null);
    setResult(null);
    try {
      const data = await encode();
      const valueWei = isPayable ? "0x" + BigInt(Math.round(Number(value || "0") * 1e18)).toString(16) : "0x0";

      if (walletProvider) {
        const [from] = (await walletProvider.request({ method: "eth_requestAccounts" })) as string[];
        const txHash = (await walletProvider.request({
          method: "eth_sendTransaction",
          params: [{ from, to: address, data, value: valueWei }],
        })) as string;
        const receipt = await walletProvider.request({ method: "eth_getTransactionReceipt", params: [txHash] });
        const blockNumber = Number(BigInt(receipt?.blockNumber ?? "0x0"));
        setResult({ kind: "write", data, txHash, receipt, path: "signed by your wallet (revive.call)" });
        onLanded({ txHash, blockNumber: blockNumber || null });
      } else {
        const res = await fetch("/api/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to: address, data, value: valueWei }),
        });
        const json = await res.json();
        if (json.error) throw new Error(json.error + (json.hint ? ` — ${json.hint}` : ""));
        const blockNumber = Number(BigInt(json.receipt?.blockNumber ?? "0x0"));
        setResult({ kind: "write", data, ...json, path: json.path ?? "demo signer (revive.call)" });
        if (json.txHash) onLanded({ txHash: json.txHash, blockNumber: blockNumber || null });
      }
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  const canWrite = Boolean(walletProvider) || demoSigning;

  return (
    <div className="card">
      <h2>
        Call any contract <span className="badge ok">your call, your calldata</span>
      </h2>
      <p className="sub">
        Paste any address and any JSON ABI. <code>view</code> functions are read over the EVM endpoint; a write
        is encoded by viem, signed as a <code>revive.call</code> extrinsic and returned as a receipt with its
        decoded log. Nothing here is special-cased to the probe contract except its default value.
      </p>

      <div className="row">
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value.trim())}
          aria-label="contract address"
          spellCheck={false}
          style={{ minWidth: 330 }}
        />
        <button
          onClick={() => {
            setAddress(TWINKEY_PROBE_ADDRESS);
            setAbiText(DEFAULT_ABI);
            setFnName("setValue");
            setArgs(["2026"]);
            setResult(null);
            setError(null);
          }}
        >
          use the probe contract
        </button>
      </div>

      <textarea
        value={abiText}
        onChange={(e) => setAbiText(e.target.value)}
        spellCheck={false}
        aria-label="contract ABI (JSON)"
        rows={3}
        style={{
          width: "100%",
          marginTop: 8,
          background: "var(--surface-2)",
          color: "var(--ink)",
          border: "1px solid var(--line)",
          borderRadius: 8,
          padding: "8px 10px",
          fontFamily: "var(--mono)",
          fontSize: 11.5,
        }}
      />
      {!abi && <div className="note">ABI is not valid JSON — fix it or paste one function&apos;s fragment.</div>}

      <div className="row" style={{ marginTop: 8 }}>
        <select
          value={selected?.name ?? ""}
          onChange={(e) => pick(e.target.value)}
          aria-label="function"
          style={{
            background: "var(--surface-2)",
            color: "var(--ink)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: "8px 10px",
            fontFamily: "var(--mono)",
            fontSize: 12.5,
          }}
        >
          {functions.length === 0 && <option value="">(no functions in ABI)</option>}
          {functions.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}({f.inputs.map((i) => i.type).join(",")})
            </option>
          ))}
        </select>
        {selected?.inputs.map((input, i) => (
          <input
            key={`${selected.name}-${i}`}
            value={argValues[i] ?? ""}
            onChange={(e) => {
              const next = [...argValues];
              next[i] = e.target.value;
              setArgs(next);
            }}
            placeholder={`${input.name || "arg"} : ${input.type}`}
            aria-label={`argument ${input.name || i}`}
            spellCheck={false}
            style={{ minWidth: 150 }}
          />
        ))}
        {isPayable && (
          <input
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="value in tPOT"
            aria-label="value in tPOT"
            style={{ width: 120 }}
          />
        )}
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <button onClick={read} disabled={!!busy || !selected || !isView}>
          {busy === "read" && <span className="spin" />}
          {busy === "read" ? "reading…" : "read()"}
        </button>
        <button onClick={estimate} disabled={!!busy || !selected}>
          {busy === "estimate" && <span className="spin" />}
          {busy === "estimate" ? "estimating…" : "cost: EVM vs runtime"}
        </button>
        <button className="primary" onClick={write} disabled={!!busy || !selected || isView || !canWrite}>
          {busy === "write" && <span className="spin" />}
          {busy === "write"
            ? walletProvider
              ? "waiting for your signature…"
              : "signing revive.call…"
            : walletProvider
              ? `write ${selected?.name ?? ""}() with your wallet`
              : `write ${selected?.name ?? ""}() with the demo signer`}
        </button>
      </div>
      {!canWrite && <div className="note">No wallet connected and demo signing is off on this deployment.</div>}

      {error && (
        <pre className="out">
          <span className="err">error: {error}</span>
        </pre>
      )}

      {result && (
        <pre className="out">
          {result.kind === "read" && (
            <>
              <span className="ok">✓ eth_call</span>
              {`\ncalldata   ${result.data}\nraw        ${SHORT(result.raw, 40, 20)}`}
              {result.decoded !== null && result.decoded !== undefined
                ? `\ndecoded    ${JSON.stringify(result.decoded, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`
                : ""}
            </>
          )}
          {result.kind === "estimate" && (
            <>
              <span className={result.ratio_evm_over_runtime > 100 ? "err" : "ok"}>
                {`cost: ${result.verdict}`}
              </span>
              {`\neth_estimateGas     ${result.evm_estimate?.gas ?? result.evm_estimate?.error ?? "—"}
runtime dry run     ${result.runtime_dry_run?.gasConsumed ?? result.runtime_dry_run?.error ?? "—"}
weight required     ${
                result.runtime_dry_run?.weightRequired
                  ? `refTime ${result.runtime_dry_run.weightRequired.refTime} / proofSize ${result.runtime_dry_run.weightRequired.proofSize}`
                  : "—"
              }
storage deposit     ${result.runtime_dry_run?.storageDepositCharge ?? "—"}${
                result.ratio_evm_over_runtime
                  ? `\neth_estimateGas is ${result.ratio_evm_over_runtime}× the runtime's own number`
                  : ""
              }`}
            </>
          )}
          {result.kind === "write" && (
            <>
              <span className="ok">✓ included — {result.path}</span>
              {`\ncontract      ${address}
tx hash       ${result.txHash}
block         ${result.receipt?.blockNumber ?? "?"}${
                result.pending ? "\nstatus        pending — receipt did not arrive inside the request" : ""
              }${
                result.receipt?.logs?.find?.((l: any) => l?.parsed)?.parsed
                  ? `\ndecoded log   ${JSON.stringify(
                      result.receipt.logs.find((l: any) => l?.parsed).parsed,
                      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
                    )}`
                  : ""
              }${result.note ? `\nnote          ${result.note}` : ""}`}
            </>
          )}
        </pre>
      )}
    </div>
  );
}
