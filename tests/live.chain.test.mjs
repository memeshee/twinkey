// Live-chain smoke test. Skipped unless TWINKEY_LIVE=1, so `npm test` stays offline and
// deterministic; `npm run test:live` is the run a judge can execute to check the deployment.
//
// Everything here is an assertion about the DEPLOYED system (app + verifier + chain), not about
// this checkout. If any of it fails, the submission's claims are false, which is the point.
import { test } from "node:test";
import assert from "node:assert/strict";

const LIVE = process.env.TWINKEY_LIVE === "1";
const APP = process.env.TWINKEY_APP ?? "https://twinkey.fly.dev";
const VERIFIER = process.env.TWINKEY_VERIFIER ?? "https://twinkey-verifier.kiter0211.workers.dev";

const PROJECT_SS58 = "5DMLUzwxrQsPwc9dsjz4WUVSy4qryn2xWhtvv4RDkjBko9C7";
const PROJECT_H160 = "0xe70fd7e24a9eee0d3a7302866e0e1e9597f4d934";
const PROBE = "0x19d5aa109cbf0d4e0a126f1438ea73b619cb7725";

const get = async (url, timeoutMs = 90_000) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test("the app answers and reports a healthy chain + verifier", { skip: !LIVE }, async () => {
  const { status, body } = await get(`${APP}/api/health`);
  assert.equal(status, 200);
  assert.equal(body.ok, true, `degraded: ${JSON.stringify(body.degraded)}`);
  assert.ok(body.substrate.head > 0, "chain head must be a real height");
});

test("one ss58 account resolves to its H160 on the live chain", { skip: !LIVE }, async () => {
  const { status, body } = await get(`${APP}/api/state?address=${PROJECT_SS58}`);
  assert.equal(status, 200);
  assert.equal(body.identity.ss58, PROJECT_SS58);
  assert.equal(body.identity.h160, PROJECT_H160, "the runtime API mapping, not a local derivation");
  assert.equal(body.chain.evmChainId, 420420777);
  assert.equal(body.chain.nativeDecimals, 14);
  assert.equal(body.chain.evmDecimals, 18);
});

test("the probe contract is deployed and its state is readable over EVM", { skip: !LIVE }, async () => {
  const { body } = await get(`${APP}/api/state?address=${PROJECT_SS58}`);
  assert.equal(body.contract.address, PROBE);
  assert.ok(Number(body.contract.state.callCount) > 0, "a callCount of 0 would mean nobody ever wrote");
});

test("the independent verifier agrees both runtimes are at the same height", { skip: !LIVE }, async () => {
  const { status, body } = await get(`${VERIFIER}/ready`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.head, body.evm_head_block, "substrate head and EVM head must be the same block");

  const verdict = await get(`${VERIFIER}/parity/${body.head - 5}`);
  assert.equal(verdict.status, 200);
  assert.equal(verdict.body.verdict, true, JSON.stringify(verdict.body.summary));
  assert.equal(verdict.body.parity, true);
});

test("the published package is installable from the registry", { skip: !LIVE }, async () => {
  const res = await fetch("https://registry.npmjs.org/twinkey-provider/latest", {
    signal: AbortSignal.timeout(30_000),
  });
  const pkg = await res.json();
  assert.equal(pkg.name, "twinkey-provider");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.ok(pkg.dependencies.viem, "the provider needs viem for encoding");
});
