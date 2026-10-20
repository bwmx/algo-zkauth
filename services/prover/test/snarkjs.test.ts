// The snarkjs fallback (PROVER=snarkjs). Takes about two minutes and 2 GB.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { assertValidProof, input, prove, startServer } from "./helpers.ts";

test("PROVER=snarkjs proves with snarkjs even though rapidsnark is installed", {
  timeout: 600000,
  skip: existsSync(`${import.meta.dirname}/../../../fixtures/phase3/google_jwt.zkey`) ? false : "proving key not installed",
}, async () => {
  const server = await startServer(8981, { PROVER: "snarkjs" });
  try {
    const health = await (await fetch(`${server.url}/v1/health`)).json();
    assert.equal(health.rapidsnark, false);
    const response = await prove(server, { provider: "google", input });
    const text = await response.text();
    assert.equal(response.status, 200, text.slice(0, 200));
    const result = JSON.parse(text);
    assert.equal(result.measurement.prover, "snarkjs");
    assert.equal(await assertValidProof(result), true);
    assert.deepEqual(readdirSync(server.workDir), []);
    console.log(`snarkjs: witness ${result.measurement.witnessMs} ms, prove ${result.measurement.proveMs} ms, total ${result.measurement.elapsedMs} ms, peak RSS ${(result.measurement.peakRssBytes / 1e9).toFixed(2)} GB`);
  } finally { await server.stop(); }
});
