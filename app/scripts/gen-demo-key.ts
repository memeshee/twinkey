// Generates a throwaway sr25519 key used as the public demo signer for the deployed app.
// It is deliberately separate from the project's main testnet key: if the public endpoint is
// abused, only this account's small balance is at risk.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keyring } from "@polkadot/api";
import { cryptoWaitReady, mnemonicGenerate } from "@polkadot/util-crypto";

async function main() {
  await cryptoWaitReady();
  const mnemonic = mnemonicGenerate(12);
  const pair = new Keyring({ type: "sr25519", ss58Format: 42 }).addFromUri(mnemonic);
  const out = {
    name: "twinkey-public-demo",
    crypto: "sr25519",
    ss58Format: 42,
    address: pair.address,
    mnemonic,
    role: "public demo signer for the deployed app — throwaway, small balance",
  };
  const file = process.env.OUT ?? path.join(os.homedir(), ".hermes/keys/twinkey-demo.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  fs.chmodSync(file, 0o600);
  console.log("demo address:", pair.address);
  console.log("key file    :", file);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
