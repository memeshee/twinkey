import type { ApiPromise } from "@polkadot/api";
import type { TwinKeySigner } from "./provider";
import { extensionSigner } from "./signers";

/**
 * Injected Substrate wallets (polkadot.js extension, Talisman, SubWallet) advertise themselves on
 * `window.injectedWeb3`. We talk to that object directly instead of pulling in
 * @polkadot/extension-dapp, which does exactly this and nothing more for our case.
 *
 * The important property for TwinKey: these wallets sign a *Substrate extrinsic*. That is the only
 * signature that can drive a contract on this chain, because the EVM write path rejects external
 * EOAs outright (docs/FINDINGS.md). So the wallet a Portaldot user already has is both necessary and
 * sufficient — no second seed.
 */
export type InjectedEntry = {
  name: string;
  title?: string;
  version?: string;
};

type InjectedWindow = Window & {
  injectedWeb3?: Record<string, { version?: string; enable: (app: string) => Promise<any> }>;
};

export function listExtensions(): InjectedEntry[] {
  if (typeof window === "undefined") return [];
  const injected = (window as InjectedWindow).injectedWeb3;
  if (!injected) return [];
  return Object.entries(injected).map(([name, meta]) => ({
    name,
    title: prettyName(name),
    version: meta?.version,
  }));
}

function prettyName(id: string): string {
  switch (id) {
    case "polkadot-js":
      return "polkadot.js extension";
    case "talisman":
      return "Talisman";
    case "subwallet-js":
      return "SubWallet";
    default:
      return id;
  }
}

export type ConnectedWallet = {
  name: string;
  ss58: string;
  signer: TwinKeySigner;
};

/**
 * Connect one injected wallet and return a TwinKey signer for the first account.
 * `api` must come from the same chain the wallet is configured for.
 */
export async function connectExtension(api: ApiPromise, name: string): Promise<ConnectedWallet> {
  const injected = (window as InjectedWindow).injectedWeb3?.[name];
  if (!injected) throw new Error(`${prettyName(name)} is not available in this browser`);

  const ext = await injected.enable("TwinKey — Portaldot Hacker House 2026");
  const accounts: { address: string; name?: string }[] = await ext.accounts.get();
  if (!accounts.length) {
    throw new Error(`${prettyName(name)} returned no accounts — add or unlock an account in the extension`);
  }

  const address = accounts[0].address;
  return {
    name: prettyName(name),
    ss58: address,
    signer: extensionSigner(api, ext, address),
  };
}
