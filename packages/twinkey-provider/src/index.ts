/**
 * twinkey-provider — an EIP-1193 provider backed by a Substrate signer.
 *
 * On this chain an external EOA cannot send a transaction at all, so every write has to
 * travel as a `revive.call` extrinsic signed by an ss58 key. This package hides that:
 * viem/wagmi/ethers talk to `createTwinKeyProvider(...)` and never learn the difference.
 */
export { createTwinKeyProvider } from "./provider";
export type {
  ProviderOptions,
  SubmitOutcome,
  TwinKeyProvider,
  TwinKeySigner,
} from "./provider";

export { extensionSigner, extractEmitted, keyringSigner } from "./signers";
export { evmRpc, getApi, resetApi } from "./chain";
export { PORTALDOT, formatNative, formatWei, nativeToWei, weiToNative } from "./config";
export { TWINKEY_PROBE_ABI, TWINKEY_PROBE_ADDRESS } from "./abi";
export type { EvmLog, RawContractEmitted } from "./logs";

/**
 * The signer most browser apps actually want: whatever Substrate extension is installed.
 *
 * `@polkadot/extension-dapp` is not a dependency — the injected interface is two calls, and
 * hard-depending on the extension package for them would make this unusable on Talisman or
 * SubWallet builds that inject a slightly different shape.
 *
 *   const signer = await fromExtension({ name: "polkadot" });
 *   const provider = createTwinKeyProvider({ signer });
 */
export async function fromExtension(opts: { name?: string; address?: string } = {}): Promise<{
  signer: import("./provider").TwinKeySigner;
  injected: any;
  address: string;
}> {
  const w = globalThis as any;
  const injectedWeb3 = w.injectedWeb3;
  if (!injectedWeb3) {
    throw new Error(
      "no Substrate wallet found: window.injectedWeb3 is undefined. Install the polkadot.js " +
        "extension, Talisman or SubWallet, or pass your own TwinKeySigner.",
    );
  }
  const name =
    opts.name ??
    ["polkadot-js", "polkadot", "talisman", "subwallet-js", "enkrypt"].find((n) => injectedWeb3[n]) ??
    Object.keys(injectedWeb3)[0];
  if (!name || !injectedWeb3[name]) {
    throw new Error(`wallet "${opts.name}" is not installed (found: ${Object.keys(injectedWeb3).join(", ")})`);
  }

  const injected = await injectedWeb3[name].enable("TwinKey");
  const accounts: { address: string }[] = await injected.accounts.get();
  if (accounts.length === 0) throw new Error("the wallet exposed no accounts — unlock it and retry");
  const address = opts.address ?? accounts[0].address;

  // A single injected account can select which one signs; the extension reads it from here.
  try {
    await injected.accounts.get();
  } catch {
    /* some builds need no permission step */
  }

  const { getApi } = await import("./chain");
  const { extensionSigner } = await import("./signers");
  const api = await getApi();
  return { signer: extensionSigner(api, injected, address), injected, address };
}
