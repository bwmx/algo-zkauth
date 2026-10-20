// Private local proving. Never place tokens, salts or keys in command arguments.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { resolve } from "node:path";
import * as snarkjs from "../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";
import { providerById } from "../src/phase3/oidc-providers.mjs";
const root = new URL("../", import.meta.url).pathname;
const dir = resolve(process.argv[2] ?? "");
if (!dir.startsWith(resolve(root, ".local/phase6/jobs") + "/")) throw new Error("Invalid private proof job directory");
const { circuit } = providerById(process.argv[3] ?? "google");
const artifact = `${root}${circuit.directory}/${circuit.name}`;
const { default: witnessBuilder } = await import(`${root}${circuit.directory}/${circuit.name}_js/witness_calculator.js`);
// rapidsnark (installed by scripts/artifacts.mjs fetch) reads the same proving key
// and writes the same proof format, about 20 times faster than snarkjs. If it is
// missing or fails, snarkjs proves instead. PROVER=snarkjs forces the fallback.
const rapidsnark = process.env.RAPIDSNARK_PATH ?? `${root}.local/bin/${process.platform}-${process.arch}/prover`;
async function groth16Prove(wtns) {
  if (process.env.PROVER !== "snarkjs" && existsSync(rapidsnark)) {
    try {
      await promisify(execFile)(rapidsnark, [`${artifact}.zkey`, wtns, `${dir}/rs-proof.json`, `${dir}/rs-public.json`], { maxBuffer: 1 << 20 });
      return { proof: JSON.parse(readFileSync(`${dir}/rs-proof.json`, "utf8")), publicSignals: JSON.parse(readFileSync(`${dir}/rs-public.json`, "utf8")), prover: "rapidsnark" };
    } catch { /* fall back to snarkjs */ } finally { rmSync(`${dir}/rs-proof.json`, { force: true }); rmSync(`${dir}/rs-public.json`, { force: true }); }
  }
  return { ...(await snarkjs.groth16.prove(`${artifact}.zkey`, wtns, undefined, { singleThread: true })), prover: "snarkjs" };
}
const started = performance.now(); let peakRssBytes = process.memoryUsage().rss;
const monitor = setInterval(() => peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss), 500);
const progress = stage => writeFileSync(`${dir}/progress.json`, JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - started) }), { mode: 0o600 });
try {
  const input = JSON.parse(readFileSync(`${dir}/input.json`, "utf8"));
  progress("witness");
  const calculator = await witnessBuilder(readFileSync(`${root}${circuit.directory}/${circuit.name}_js/${circuit.name}.wasm`));
  writeFileSync(`${dir}/proof.wtns`, new Uint8Array(await calculator.calculateWTNSBin(input, true)), { mode: 0o600 });
  const witnessMs = Math.round(performance.now() - started); progress("proof");
  const proofStarted = performance.now();
  const { proof, publicSignals, prover } = await groth16Prove(`${dir}/proof.wtns`);
  const proveMs = Math.round(performance.now() - proofStarted); progress("verification");
  const expected = [...input.identity, ...input.keyHash, ...input.audienceHash, ...input.sessionKey, ...input.genesisHash, input.sessionExpiresAt, input.notBefore].map(String);
  const vk = JSON.parse(readFileSync(`${root}${circuit.directory}/verification_key.json`, "utf8"));
  if (JSON.stringify(expected) !== JSON.stringify(publicSignals) || !(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error("Proof verification failed");
  writeFileSync(`${dir}/result.json`, JSON.stringify({ proof, publicSignals, measurement: { prover, witnessMs, proveMs, elapsedMs: Math.round(performance.now() - started), peakRssBytes, nodeVersion: process.version, platform: process.platform, architecture: process.arch, independentVerificationPassed: true, circuitPublicSignals: 12 } }), { mode: 0o600 });
  progress("ready");
} catch {
  progress("failed"); process.exitCode = 1;
} finally {
  clearInterval(monitor); rmSync(`${dir}/input.json`, { force: true }); rmSync(`${dir}/proof.wtns`, { force: true });
  await globalThis.curve_bn128?.terminate();
}
