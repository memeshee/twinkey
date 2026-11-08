// The log decoder, against a log shaped exactly like the ones the chain emits.
// `revive.ContractEmitted` hands out { contract, topics[], data } as opaque hex and nothing on
// this chain decodes it, so this is the code path every TwinKey user depends on. The log below
// is built by hand from the ABI rather than encoded with viem: encoding it with the same
// library that decodes it would make the test agree with itself and prove nothing.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TWINKEY_PROBE_ABI,
  TWINKEY_PROBE_ADDRESS,
  decodeLog,
  emittedToLogs,
} from "../packages/twinkey-provider/dist/index.js";

const VALUE_SET_TOPIC0 = "0xc0e9036d619701c94569e1462d8120ef4a6d2b15a70d27cc942fd29ae2cc0e59";
const CALLER = "0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934";

/** 32-byte left-padded word, the way an EVM topic/data slot is laid out. */
const word = (hex) => "0x" + hex.replace(/^0x/, "").padStart(64, "0");

/** ValueSet(address indexed caller, uint256 indexed value, uint256 callCount) */
const valueSetLog = (value = 2077n, callCount = 4n) => ({
  address: TWINKEY_PROBE_ADDRESS,
  topics: [VALUE_SET_TOPIC0, word(CALLER), word(value.toString(16))],
  data: word(callCount.toString(16)),
});

test("decodes the ValueSet log the demo writes on chain", () => {
  const parsed = decodeLog(valueSetLog(), TWINKEY_PROBE_ABI);
  assert.ok(parsed, "decodeLog returned null for a log it should understand");
  assert.equal(parsed.eventName, "ValueSet");
  // viem returns addresses checksummed, so compare case-insensitively rather than pinning the case.
  assert.equal(parsed.args.caller.toLowerCase(), CALLER);
  // bigint does not survive JSON, so args are normalised to decimal strings on the way out.
  assert.equal(parsed.args.value, "2077");
  assert.equal(parsed.args.callCount, "4");
});

test("decodes a different value from the same shape — no hard-coded demo numbers", () => {
  const parsed = decodeLog(valueSetLog(4242n, 7n), TWINKEY_PROBE_ABI);
  assert.equal(parsed.args.value, "4242");
  assert.equal(parsed.args.callCount, "7");
});

test("an unknown topic0 returns null instead of throwing", () => {
  const foreign = { ...valueSetLog(), topics: [word("deadbeef"), word(CALLER)] };
  assert.equal(decodeLog(foreign, TWINKEY_PROBE_ABI), null);
});

test("a truncated log returns null instead of throwing", () => {
  const truncated = { address: TWINKEY_PROBE_ADDRESS, topics: [VALUE_SET_TOPIC0], data: "0x" };
  assert.equal(decodeLog(truncated, TWINKEY_PROBE_ABI), null);
});

test("emitted events become JSON-RPC shaped logs with per-transaction indexes", () => {
  const logs = emittedToLogs(
    [
      { contract: TWINKEY_PROBE_ADDRESS, topics: valueSetLog().topics, data: valueSetLog().data },
      { contract: TWINKEY_PROBE_ADDRESS.toUpperCase().replace("0X", "0x"), topics: [VALUE_SET_TOPIC0], data: "0x" },
    ],
    { blockNumber: 227275, blockHash: "0xabc", transactionHash: "0xdef" },
  );
  assert.equal(logs.length, 2);
  assert.equal(logs[0].address, TWINKEY_PROBE_ADDRESS, "address must be lower-cased");
  assert.equal(logs[1].address, TWINKEY_PROBE_ADDRESS, "a checksummed address must still lower-case");
  assert.equal(logs[0].logIndex, "0x0");
  assert.equal(logs[1].logIndex, "0x1", "logIndex restarts per transaction and increments within it");
  assert.equal(logs[0].blockNumber, "0x377cb", "block 227275 as hex");
  assert.equal(logs[0].transactionIndex, "0x0");
  assert.equal(logs[0].removed, false);
  assert.equal(logs[0].blockHash, "0xabc");
});

test("a log with no block context reports nulls rather than a wrong height", () => {
  const [log] = emittedToLogs([{ contract: TWINKEY_PROBE_ADDRESS, topics: [], data: "0x" }], {});
  assert.equal(log.blockNumber, null);
  assert.equal(log.blockHash, null);
  assert.equal(log.transactionHash, null);
});
