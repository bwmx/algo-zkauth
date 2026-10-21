// Private local proving. Never place tokens, salts or keys in command arguments.
// The proving itself (rapidsnark with a snarkjs fallback, and the verification
// checks) is services/prover/src/prove.ts; this script wraps it in a job directory
// that scripts/demo/phase6-server.mjs polls through progress.json and result.json.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_PROVIDER } from "../../packages/protocol/src/oidc-providers.mjs";
import { proveInput } from "../../services/prover/src/prove.ts";
const root = new URL("../../", import.meta.url).pathname;
const dir = resolve(process.argv[2] ?? "");
if (!dir.startsWith(resolve(root, ".local/phase6/jobs") + "/")) throw new Error("Invalid private proof job directory");
const provider = process.argv[3] ?? DEFAULT_PROVIDER;
const started = performance.now();
const progress = (stage, elapsedMs = Math.round(performance.now() - started)) => writeFileSync(`${dir}/progress.json`, JSON.stringify({ stage, elapsedMs }), { mode: 0o600 });
try {
  const input = JSON.parse(readFileSync(`${dir}/input.json`, "utf8"));
  const { proof, publicSignals, measurement } = await proveInput({ provider, input, workDir: dir, onStage: progress });
  writeFileSync(`${dir}/result.json`, JSON.stringify({ proof, publicSignals, measurement: { ...measurement, nodeVersion: process.version, platform: process.platform, architecture: process.arch, independentVerificationPassed: true, circuitPublicSignals: 12 } }), { mode: 0o600 });
  progress("ready");
} catch {
  progress("failed"); process.exitCode = 1;
} finally {
  rmSync(`${dir}/input.json`, { force: true }); rmSync(`${dir}/proof.wtns`, { force: true });
  await globalThis.curve_bn128?.terminate();
}
