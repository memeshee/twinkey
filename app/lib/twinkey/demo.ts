import fs from "node:fs";

import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";

import { evmRpc, getApi, withDeadline } from "./chain";
import { createTwinKeyProvider, type TwinKeyProvider } from "./provider";
import { keyringSigner } from "./signers";

/**
 * The demo signer: a throwaway sr25519 account whose secret lives in the
 * deployment environment, used only so a judge without a Substrate extension can
 * watch a real `revive.call` land. It is never the project key, it is funded with
 * a few testnet tPOT, and every route that touches it is rate limited.
 */
export type DemoContext = {
  ss58: string;
  h160: string;
  provider: TwinKeyProvider;
};

export const demoEnabled = (): boolean =>
  Boolean(process.env.PORTALDOT_KEY || process.env.PORTALDOT_SECRET_URI);

export async function demoContext(): Promise<DemoContext> {
  const keyPath = process.env.PORTALDOT_KEY;
  const secretUri = process.env.PORTALDOT_SECRET_URI;
  if (!keyPath && !secretUri) {
    throw new Error(
      "demo signing disabled: set PORTALDOT_KEY (key file path) or PORTALDOT_SECRET_URI to enable a server-side write",
    );
  }

  await cryptoWaitReady();
  let uri = secretUri;
  let crypto = "sr25519";
  if (!uri && keyPath) {
    const key = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    uri = key.secretUri ?? key.mnemonic;
    crypto = key.crypto ?? "sr25519";
  }
  const pair = new Keyring({ type: crypto as any, ss58Format: 42 }).addFromUri(uri!);

  const api = await getApi();
  const provider = createTwinKeyProvider({ signer: keyringSigner(api, pair) });
  const [h160] = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  return { ss58: pair.address, h160, provider };
}

/** `eth_call` straight off the EVM endpoint: works even when the socket is down. */
export async function evmCall(to: string, data: string, block: string | number = "latest"): Promise<string> {
  const tag = typeof block === "number" ? "0x" + block.toString(16) : block;
  return evmRpc<string>("eth_call", [{ to, data }, tag]);
}

export type SubmitResult = {
  txHash: string;
  receipt: any | null;
  pending: boolean;
  elapsedMs: number;
  stateAfter?: string | null;
  note?: string;
};

/**
 * One contract call through the demo signer, with the two failure modes a
 * serverless host creates handled explicitly:
 *
 *  - the write takes longer than the request budget → return the hash, marked
 *    `pending`, instead of a 500 for a transaction that is already in a block;
 *  - the socket dies mid-flight → surfaced as a labelled error by `withDeadline`.
 */
export async function submitDemoCall(opts: {
  to: string;
  data: string;
  valueWei?: string;
  submitBudgetMs?: number;
  receiptBudgetMs?: number;
}): Promise<SubmitResult> {
  const { to, data, valueWei = "0x0", submitBudgetMs = 40_000, receiptBudgetMs = 12_000 } = opts;
  const { h160, provider } = await demoContext();
  const started = Date.now();

  const txHash = (await withDeadline(
    provider.request({
      method: "eth_sendTransaction",
      params: [{ from: h160, to, data, value: valueWei }],
    }),
    submitBudgetMs,
    "revive.call submit",
  )) as string;

  try {
    const receipt = await withDeadline(
      provider.request({ method: "eth_getTransactionReceipt", params: [txHash] }),
      receiptBudgetMs,
      "receipt",
    );
    return { txHash, receipt, pending: false, elapsedMs: Date.now() - started };
  } catch {
    return {
      txHash,
      receipt: null,
      pending: true,
      elapsedMs: Date.now() - started,
      note: "submitted — the receipt did not arrive inside this request. The transaction is on chain; reload the event feed for the proof.",
    };
  }
}

/** Per-IP fixed window. Lives on `globalThis` so a warm lambda keeps the window. */
export function rateLimited(ip: string, max = 3, windowMs = 60_000): boolean {
  const store: Map<string, number[]> = ((globalThis as any).__twinkeyHits ??= new Map());
  const now = Date.now();
  const recent = (store.get(ip) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    store.set(ip, recent);
    return true;
  }
  recent.push(now);
  store.set(ip, recent);
  return false;
}

export const clientIp = (req: Request): string =>
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
