// Verify the "unmodified viem" claim against the DEPLOYED endpoint, from Node.
//
//   npx tsx scripts/viem-prod-check.ts [rpc-url]
//
// This is the same client code the /viem page runs in a browser: createPublicClient
// + createWalletClient over http(), readContract, writeContract,
// waitForTransactionReceipt. If this passes, the page works; the only difference
// between them is the runtime.
import { createPublicClient, createWalletClient, http, erc20Abi, formatUnits } from "viem";

const RPC = process.argv[2] ?? "https://twinkey.vercel.app/api/rpc";
const TOKEN = "0x06f6e882ada6cd5cab74214ad90c3bd1b070e4e9" as const;
const TO = "0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934" as const;

async function main() {
  const transport = http(RPC, { timeout: 90_000 });
  const publicClient = createPublicClient({ transport });
  const walletClient = createWalletClient({ transport });

  const accounts = await walletClient.getAddresses();
  const from = accounts[0];
  console.log("rpc       ", RPC);
  console.log("account   ", from);

  const symbol = (await publicClient.readContract({
    address: TOKEN,
    abi: erc20Abi,
    functionName: "symbol",
  })) as string;

  const before = (await publicClient.readContract({
    address: TOKEN,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [from],
  })) as bigint;

  console.log("token     ", symbol, "at", TOKEN);
  console.log("balance   ", formatUnits(before, 18));

  const hash = await walletClient.writeContract({
    address: TOKEN,
    abi: erc20Abi,
    functionName: "transfer",
    args: [TO, 10n ** 18n],
    account: from,
    chain: null,
  });
  console.log("tx hash   ", hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log("block     ", receipt.blockNumber, "status", receipt.status, "logs", receipt.logs.length);

  const after = (await publicClient.readContract({
    address: TOKEN,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [from],
  })) as bigint;
  console.log("balance   ", formatUnits(before, 18), "->", formatUnits(after, 18));

  const transfer = receipt.logs.find(
    (l) => l.topics[0] === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  );
  console.log(
    "transfer  ",
    transfer ? `${transfer.address} value ${formatUnits(BigInt(transfer.data), 18)}` : "(no Transfer topic)",
  );

  const ok = receipt.status === "success" && after === before - 10n ** 18n && Boolean(transfer);
  console.log("RESULT    ", ok ? "PASS — ordinary viem settled a write on Portaldot" : "FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
