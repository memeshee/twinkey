// Portaldot V3 testnet constants. Every value here was verified against the live chain —
// see docs/VERIFIED-FACTS.md for the command that produced it. Nothing is guessed.
export const PORTALDOT = {
  /** Substrate RPC. ARCHIVE node: historical state readable at any block, including 0. */
  substrateWs: "wss://test-node-v3.portaldot.dev",
  substrateHttp: "https://test-node-v3.portaldot.dev",

  /**
   * EVM JSON-RPC — a SEPARATE endpoint from the Substrate one, and NOT archival for state:
   * eth_call / eth_getBlockByNumber at a historical block fail with
   * "UnknownBlock: State already discarded" beyond roughly 256 blocks back.
   * Use it for CURRENT state and for eth_getLogs only. This asymmetry is the whole reason
   * the TwinKey verifier reads history from the Substrate side.
   */
  evmRpc: "https://test-evm-rpc-v3.portaldot.dev",

  evmChainId: 420420777,
  evmChainIdHex: "0x190f1ca9",

  ss58Prefix: 42,
  /** Native tPOT has 14 decimals; the EVM side is denominated in 18. Ratio = 10^4. */
  nativeDecimals: 14,
  evmDecimals: 18,
  nativeToEthRatio: 10_000n,
  tokenSymbol: "tPOT",

  genesis: "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd",
  substrateName: "PortaldotV3 Test",
  runtimeSpec: "portaldot-v3",
} as const;

/** 14-decimal native base units <-> 18-decimal EVM wei. */
export const nativeToWei = (native: bigint): bigint => native * PORTALDOT.nativeToEthRatio;
export const weiToNative = (wei: bigint): bigint => wei / PORTALDOT.nativeToEthRatio;

export const formatNative = (raw: bigint, dp = 4): string => {
  const whole = raw / 10n ** 14n;
  const frac = (raw % 10n ** 14n).toString().padStart(14, "0").slice(0, dp);
  return `${whole}.${frac}`;
};

export const formatWei = (wei: bigint, dp = 4): string => {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, dp);
  return `${whole}.${frac}`;
};
