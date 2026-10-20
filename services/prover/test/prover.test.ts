// Prover service tests (port 8981 = 8781 + 200). Needs the Google proving key,
// witness files and rapidsnark, and .local/phase3/synthetic-input.json.
// Proofs are produced one at a time; run with --test-concurrency=1.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { describe, test, before, after } from "node:test";
import { assertValidProof, input, prove, secrets, startServer, TOKEN } from "./helpers.ts";
import type { Running } from "./helpers.ts";

const PORT = 8981;
const requiresKeys = existsSync(`${import.meta.dirname}/../../../fixtures/phase3/google_jwt.zkey`) ? false : "proving key not installed";

const assertStatic = (text: string, label: string) => {
  for (const secret of secrets()) assert.ok(!text.includes(secret), `${label} contains input data`);
};

describe("prover service", { skip: requiresKeys }, () => {
  let server: Running;
  before(async () => { server = await startServer(PORT, { PROVER_QUEUE: "2" }); });
  after(async () => { await server.stop(); });

  test("health reports rapidsnark and the provers it can serve", async () => {
    const response = await fetch(`${server.url}/v1/health`);
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.equal(health.rapidsnark, true);
    assert.ok(health.providers.includes("google"));
  });

  test("the work directory is private", () => {
    assert.equal(statSync(server.workDir).mode & 0o777, 0o700);
  });

  test("a missing or wrong bearer token is refused with 401", async () => {
    for (const token of [null, "wrong", TOKEN.slice(0, -1), `${TOKEN}x`]) {
      const response = await prove(server, { provider: "google", input }, token);
      assert.equal(response.status, 401);
      const body = await response.json();
      assert.deepEqual(Object.keys(body), ["error"]);
      assert.equal(body.error.code, "bad_request");
      assert.equal(body.error.message, "Missing or invalid bearer token");
    }
    const noScheme = await fetch(`${server.url}/v1/prove`, { method: "POST", headers: { authorization: TOKEN }, body: "{}" });
    assert.equal(noScheme.status, 401);
  });

  test("unknown paths and bad requests return static errors", async () => {
    assert.equal((await fetch(`${server.url}/v1/nothing`)).status, 404);
    const cases: [string, unknown, number][] = [
      ["not json", "{nope", 400],
      ["no provider", { input }, 400],
      ["unknown provider", { provider: "nobody", input }, 400],
      ["input is not an object", { provider: "google", input: "eyJ.token.value" }, 400],
      ["input without the public fields", { provider: "google", input: { message: [1, 2, 3], salt: [9, 9, 9] } }, 400],
    ];
    for (const [label, body, status] of cases) {
      const response = await prove(server, body);
      assert.equal(response.status, status, label);
      const text = await response.text();
      assert.equal(JSON.parse(text).error.code, "bad_request", label);
      assert.ok(!text.includes("9, 9") && !text.includes("eyJ"), `${label}: echoed input`);
    }
  });

  test("an oversized body is refused", async () => {
    const response = await prove(server, JSON.stringify({ provider: "google", input, padding: "x".repeat(200 * 1024) }));
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, "bad_request");
  });

  test("a rapidsnark proof verifies against the verification key and the expected public signals", async () => {
    const response = await prove(server, { provider: "google", input });
    const text = await response.text();
    assert.equal(response.status, 200, text.slice(0, 200));
    const result = JSON.parse(text);
    assert.deepEqual(Object.keys(result).sort(), ["measurement", "proof", "publicSignals"]);
    assert.equal(result.measurement.prover, "rapidsnark");
    for (const key of ["witnessMs", "proveMs", "elapsedMs", "peakRssBytes"]) assert.ok(result.measurement[key] > 0, key);
    assert.ok(result.measurement.peakRssBytes > 1e9, "peak includes the rapidsnark child (proving key is about 1.4 GB)");
    assert.equal(result.publicSignals.length, 12);
    assert.equal(await assertValidProof(result), true);
    // The job directory is gone and nothing about the input or proof was logged.
    assert.deepEqual(readdirSync(server.workDir), []);
    const logs = server.logs.join("\n");
    assertStatic(logs, "logs");
    assert.ok(!logs.includes(result.proof.pi_a[0]), "logs contain the proof");
    const job = server.logs.map(line => JSON.parse(line)).find(entry => entry.event === "job");
    assert.equal(job.outcome, "ok");
    assert.equal(job.provider, "google");
    console.log(`rapidsnark: witness ${result.measurement.witnessMs} ms, prove ${result.measurement.proveMs} ms, total ${result.measurement.elapsedMs} ms, peak RSS ${(result.measurement.peakRssBytes / 1e9).toFixed(2)} GB`);
  });

  test("an input the circuit rejects fails with a static message, leaves nothing behind and echoes nothing", async () => {
    const tampered = structuredClone(input) as Record<string, unknown>;
    const message = tampered.message as number[];
    message[40] = (message[40]! + 1) % 256;
    const response = await prove(server, { provider: "google", input: tampered });
    const text = await response.text();
    assert.equal(response.status, 422);
    assert.deepEqual(JSON.parse(text), { error: { code: "proof_failed", message: "The proof could not be produced" } });
    assertStatic(text, "response");
    assert.deepEqual(readdirSync(server.workDir), []);
    assertStatic(server.logs.join("\n"), "logs");
    assert.ok(server.logs.some(line => line.includes('"outcome":"proof_failed"')));
  });

  test("startup empties stale job directories and requires a token", async () => {
    const stale = `${server.workDir}/stale-job`;
    mkdirSync(stale, { mode: 0o700 });
    writeFileSync(`${stale}/proof.wtns`, "stale");
    const second = await startServer(PORT + 1, {}, { workDir: server.workDir });
    try { assert.deepEqual(readdirSync(server.workDir), []); } finally { await second.stop(); }
    await assert.rejects(startServer(PORT + 1, {}, { token: null }), /ZKAUTH_PROVER_TOKEN is required/);
  });
});

describe("prover queue", { skip: requiresKeys }, () => {
  let server: Running;
  before(async () => { server = await startServer(PORT, { PROVER_CONCURRENCY: "1", PROVER_QUEUE: "1" }); });
  after(async () => { await server.stop(); });

  test("a full queue answers 429 with Retry-After while earlier jobs still complete", async () => {
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const running = prove(server, { provider: "google", input });
    await sleep(800);
    const queued = prove(server, { provider: "google", input });
    await sleep(800);
    const refused = await prove(server, { provider: "google", input });
    assert.equal(refused.status, 429);
    const retryAfter = Number(refused.headers.get("retry-after"));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, "Retry-After seconds");
    const body = await refused.json();
    assert.equal(body.error.code, "rate_limited");
    assert.equal(body.error.retryAfter, retryAfter);
    assert.equal(body.error.message, "The prover queue is full");
    // Health stays responsive while a proof runs.
    assert.equal((await fetch(`${server.url}/v1/health`)).status, 200);
    for (const response of await Promise.all([running, queued])) {
      assert.equal(response.status, 200);
      assert.equal(await assertValidProof(await response.json()), true);
    }
    assert.deepEqual(readdirSync(server.workDir), []);
  });
});
