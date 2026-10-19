import type { ApiPromise } from "@polkadot/api";
import type { SubmitOutcome, TwinKeySigner } from "./provider";
import type { RawContractEmitted } from "./logs";

/**
 * A signer backed by a local Keyring pair. Used by the scripts and the end-to-end test; in the
 * browser the same role is played by the wallet extension.
 */
export function keyringSigner(api: ApiPromise, pair: any, timeoutMs = 180_000): TwinKeySigner {
  return {
    ss58: pair.address,
    async submit(tx: any): Promise<SubmitOutcome> {
      return new Promise<SubmitOutcome>(async (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for inclusion")), timeoutMs);
        let unsub: (() => void) | undefined;
        try {
          unsub = await tx.signAndSend(pair, (result: any) => {
            const { status, events, dispatchError, txHash } = result;
            if (dispatchError) {
              clearTimeout(timer);
              unsub?.();
              let message = dispatchError.toString();
              if (dispatchError.isModule) {
                const d = api.registry.findMetaError(dispatchError.asModule);
                message = `${d.section}.${d.name}: ${d.docs.join(" ")}`;
              }
              reject(new Error(message));
              return;
            }
            if (status.isInBlock || status.isFinalized) {
              clearTimeout(timer);
              unsub?.();
              const blockHash = (status.isFinalized ? status.asFinalized : status.asInBlock).toHex();
              resolve({
                extrinsicHash: txHash.toHex(),
                blockHash,
                blockNumber: null,
                ok: true,
                emitted: extractEmitted(events),
              });
            }
          });
        } catch (e) {
          clearTimeout(timer);
          reject(e as Error);
        }
      });
    },
  };
}

/** Pull every `revive.ContractEmitted` out of an extrinsic's event list. */
export function extractEmitted(events: any[]): RawContractEmitted[] {
  const out: RawContractEmitted[] = [];
  for (const record of events ?? []) {
    const event = record.event ?? record;
    if (event.section !== "revive" || event.method !== "ContractEmitted") continue;
    const fields = event.meta?.fields ?? [];
    const get = (name: string, idx: number) => {
      const i = fields.findIndex((f: any) => f.name?.isSome && f.name.unwrap().toString() === name);
      return event.data[i >= 0 ? i : idx];
    };
    const contract = String(get("contract", 0));
    const data = String(get("data", 1));
    const topicsRaw = get("topics", 2);
    const topics: string[] = (topicsRaw?.toJSON?.() ?? topicsRaw ?? []).map((t: any) =>
      typeof t === "string" ? t : String(t),
    );
    out.push({ contract, data, topics });
  }
  return out;
}

/**
 * A signer backed by an injected Substrate wallet (polkadot.js extension, Talisman, SubWallet).
 * `web3FromSource` comes from @polkadot/extension-dapp and is only available in a browser.
 */
export function extensionSigner(api: ApiPromise, injected: any, address: string, timeoutMs = 180_000): TwinKeySigner {
  return {
    ss58: address,
    async submit(tx: any): Promise<SubmitOutcome> {
      return new Promise<SubmitOutcome>(async (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for inclusion")), timeoutMs);
        let unsub: (() => void) | undefined;
        try {
          unsub = await tx.signAndSend(address, { signer: injected.signer }, (result: any) => {
            const { status, events, dispatchError, txHash } = result;
            if (dispatchError) {
              clearTimeout(timer);
              unsub?.();
              let message = dispatchError.toString();
              if (dispatchError.isModule) {
                const d = api.registry.findMetaError(dispatchError.asModule);
                message = `${d.section}.${d.name}: ${d.docs.join(" ")}`;
              }
              reject(new Error(message));
              return;
            }
            if (status.isInBlock || status.isFinalized) {
              clearTimeout(timer);
              unsub?.();
              resolve({
                extrinsicHash: txHash.toHex(),
                blockHash: (status.isFinalized ? status.asFinalized : status.asInBlock).toHex(),
                blockNumber: null,
                ok: true,
                emitted: extractEmitted(events),
              });
            }
          });
        } catch (e) {
          clearTimeout(timer);
          reject(e as Error);
        }
      });
    },
  };
}
