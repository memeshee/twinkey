/**
 * Send native tPOT from the project key to another ss58 account.
 * Usage: npx tsx scripts/fund.ts <ss58|h160> <amount-tPOT>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keyring } from "@polkadot/api";
import { cryptoWaitReady, decodeAddress } from "@polkadot/util-crypto";
import { encodeAddress } from "@polkadot/util-crypto";
import { getApi } from "../lib/twinkey/chain";
import { formatNative } from "../lib/twinkey/config";
import { resolveAccountId } from "../lib/twinkey/chain";

const KEY_FILE = process.env.PORTALDOT_KEY ?? path.join(os.homedir(), ".hermes/keys/portaldot-testnet.json");

async function main() {
  const [dest, amountArg] = process.argv.slice(2);
  if (!dest || !amountArg) throw new Error("usage: npx tsx scripts/fund.ts <ss58|h160> <amount-tPOT>");

  await cryptoWaitReady();
  const key = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
  const pair = new Keyring({ type: key.crypto ?? "sr25519", ss58Format: 42 }).addFromUri(
    key.secretUri ?? key.mnemonic,
  );
  const api = await getApi();

  // Accept either an ss58 address or an H160, resolving the latter through the chain.
  const target = dest.startsWith("0x")
    ? await resolveAccountId(api, dest)
    : encodeAddress(decodeAddress(dest), 42);

  const amount = BigInt(Math.round(Number(amountArg) * 1e14));
  const { data: fromBalance } = (await api.query.system.account(pair.address)) as any;
  console.log("from   :", pair.address, "free", formatNative(BigInt(fromBalance.free.toString())), "tPOT");
  console.log("to     :", target);
  console.log("amount :", formatNative(amount), "tPOT");

  const hash = await new Promise<string>(async (resolve, reject) => {
    const unsub = await api.tx.balances
      .transferKeepAlive(target, amount)
      .signAndSend(pair, ({ status, dispatchError, txHash }) => {
        if (dispatchError) {
          unsub();
          let msg = dispatchError.toString();
          if (dispatchError.isModule) {
            const d = api.registry.findMetaError(dispatchError.asModule);
            msg = `${d.section}.${d.name}: ${d.docs.join(" ")}`;
          }
          reject(new Error(msg));
          return;
        }
        if (status.isInBlock) {
          unsub();
          resolve(txHash.toHex());
        }
      });
  });

  const { data: toBalance } = (await api.query.system.account(target)) as any;
  console.log("tx     :", hash);
  console.log("to free:", formatNative(BigInt(toBalance.free.toString())), "tPOT");
  await api.disconnect();
}

main().catch((e) => {
  console.error("fund failed:", e?.message ?? e);
  process.exit(1);
});
