// Deterministic unit tests for the provider's constants and unit conversions.
// No network, no chain: these must pass on a plane. `npm test` runs this file only.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PORTALDOT,
  formatNative,
  formatWei,
  nativeToWei,
  weiToNative,
} from "../packages/twinkey-provider/dist/index.js";

test("chain id is the same number in both representations", () => {
  assert.equal(Number(PORTALDOT.evmChainIdHex), PORTALDOT.evmChainId);
  assert.equal(PORTALDOT.evmChainId, 420420777);
});

test("the 14/18 decimal split is exactly 10^4, not a rounding", () => {
  assert.equal(PORTALDOT.evmDecimals - PORTALDOT.nativeDecimals, 4);
  assert.equal(PORTALDOT.nativeToEthRatio, 10_000n);
  assert.equal(nativeToWei(1n), 10_000n);
  assert.equal(weiToNative(10_000n), 1n);
});

test("native -> wei -> native round-trips a real balance with no precision loss", () => {
  // 214.46073709943996 tPOT, the balance the deployed app reports for the project key.
  const raw = 21446073709943996n;
  const wei = nativeToWei(raw);
  assert.equal(wei, 214460737099439960000n);
  assert.equal(weiToNative(wei), raw);
});

test("a wei amount below one native unit floors to zero instead of throwing", () => {
  assert.equal(weiToNative(9_999n), 0n);
  assert.equal(weiToNative(10_000n), 1n);
});

test("formatting never silently drops the integer part", () => {
  assert.equal(formatNative(21446073709943996n), "214.4607");
  assert.equal(formatNative(0n), "0.0000");
  assert.equal(formatNative(1n), "0.0000");
  assert.equal(formatWei(214460737099439960000n), "214.4607");
  assert.equal(formatWei(1n), "0.0000");
});

test("the ss58 prefix is the generic substrate one", () => {
  assert.equal(PORTALDOT.ss58Prefix, 42);
  assert.equal(PORTALDOT.tokenSymbol, "tPOT");
});
