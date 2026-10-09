// Private local proving. Never place tokens, salts or keys in command arguments.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import witnessBuilder from "../fixtures/phase3/google_jwt_js/witness_calculator.js";
import * as snarkjs from "../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";
const root = new URL("../", import.meta.url).pathname;
const dir = resolve(process.argv[2] ?? "");
if (!dir.startsWith(resolve(root, ".local/phase6/jobs") + "/")) throw new Error("Invalid private proof job directory");
const started = performance.now(); let peakRssBytes = process.memoryUsage().rss;
const monitor = setInterval(() => peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss), 500);
const progress = stage => writeFileSync(`${dir}/progress.json`, JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - started) }), { mode: 0o600 });
try {
  const input = JSON.parse(readFileSync(`${dir}/input.json`, "utf8"));
  progress("witness");
  const calculator = await witnessBuilder(readFileSync(`${root}fixtures/phase3/google_jwt_js/google_jwt.wasm`));
  writeFileSync(`${dir}/proof.wtns`, new Uint8Array(await calculator.calculateWTNSBin(input, true)), { mode: 0o600 });
  const witnessMs = Math.round(performance.now() - started); progress("proof");
  const proofStarted = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.prove(`${root}fixtures/phase3/google_jwt.zkey`, `${dir}/proof.wtns`, undefined, { singleThread: true });
  const proveMs = Math.round(performance.now() - proofStarted); progress("verification");
  const expected = [...input.identity, ...input.keyHash, ...input.audienceHash, ...input.sessionKey, ...input.genesisHash, input.sessionExpiresAt, input.notBefore].map(String);
  const vk = JSON.parse(readFileSync(`${root}fixtures/phase3/verification_key.json`, "utf8"));
  if (JSON.stringify(expected) !== JSON.stringify(publicSignals) || !(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error("Proof verification failed");
  writeFileSync(`${dir}/result.json`, JSON.stringify({ proof, publicSignals, measurement: { witnessMs, proveMs, elapsedMs: Math.round(performance.now() - started), peakRssBytes, nodeVersion: process.version, platform: process.platform, architecture: process.arch, independentVerificationPassed: true, circuitPublicSignals: 12 } }), { mode: 0o600 });
  progress("ready");
} catch {
  progress("failed"); process.exitCode = 1;
} finally {
  clearInterval(monitor); rmSync(`${dir}/input.json`, { force: true }); rmSync(`${dir}/proof.wtns`, { force: true });
  await globalThis.curve_bn128?.terminate();
}
