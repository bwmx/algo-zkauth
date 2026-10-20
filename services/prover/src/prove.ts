// Private proving: circuit input → witness → Groth16 proof → verified result.
// Factored from the original scripts/prove-demo.mjs, which now calls proveInput.
//
// Native rapidsnark (installed by scripts/artifacts.mjs fetch, or RAPIDSNARK_PATH)
// reads the same proving key and writes the same proof format, about 20 times
// faster than snarkjs. If it is missing or fails, snarkjs proves instead.
// PROVER=snarkjs forces the fallback. Every proof is checked against the
// provider's verification key and the public signals the input must produce.
//
// Nothing from the input, witness or proof is ever put in an error. Files the job
// writes (witness, rapidsnark outputs) live in workDir and are removed in all cases.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expectedPublicSignals, providerById } from "../../../packages/protocol/src/node.ts";
import type { CircuitInput } from "../../../packages/protocol/src/node.ts";
import type { Groth16Proof, Provider, ProviderId } from "../../../packages/protocol/src/types.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const execFileAsync = promisify(execFile);

export type ProveErrorCode = "bad_request" | "proof_failed" | "service_unavailable";

/** Carries only a code and a fixed message; the cause is deliberately dropped. */
export class ProveError extends Error {
  code: ProveErrorCode;
  constructor(code: ProveErrorCode, message: string) {
    super(message);
    this.name = "ProveError";
    this.code = code;
  }
}

export type Stage = "witness" | "proof" | "verification";

/**
 * - prover: which prover made the proof.
 * - witnessMs: from the start of proveInput until the witness file was written.
 * - proveMs: the Groth16 proving step alone (including a failed rapidsnark attempt before a fallback).
 * - elapsedMs: the whole of proveInput, including verification.
 * - peakRssBytes: the highest sampled sum of this process's resident set size and, while
 *   rapidsnark runs, the rapidsnark child's (see startRssSampler). Samples every 250 ms, so a
 *   spike shorter than that in this process can be missed; the child's peak is exact on Linux.
 *   With PROVER_CONCURRENCY above 1 the process figure includes the other running jobs.
 */
export type Measurement = { prover: "rapidsnark" | "snarkjs"; witnessMs: number; proveMs: number; elapsedMs: number; peakRssBytes: number };
export type ProveResult = { proof: Groth16Proof; publicSignals: string[]; measurement: Measurement };

type Snarkjs = {
  groth16: {
    prove(zkey: string, wtns: string, logger?: unknown, options?: { singleThread?: boolean }): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(vk: unknown, publicSignals: string[], proof: Groth16Proof): Promise<boolean>;
  };
};
let snarkjsModule: Promise<Snarkjs> | undefined;
// The development checkout's snarkjs (scripts/fetch-upstream.sh), else SNARKJS_PATH, else the installed "snarkjs" package (the Docker image).
const loadSnarkjs = () => snarkjsModule ??= import(
  process.env.SNARKJS_PATH ? pathToFileURL(process.env.SNARKJS_PATH).href
    : existsSync(`${root}upstream/snarkjs-algorand/node_modules/snarkjs/main.js`) ? `${root}upstream/snarkjs-algorand/node_modules/snarkjs/main.js`
    : "snarkjs") as Promise<Snarkjs>;

type Builder = (wasm: Uint8Array) => Promise<{ calculateWTNSBin(input: unknown, sanityCheck: boolean): Promise<Uint8Array> }>;
const builders = new Map<string, Promise<Builder>>();
const loadBuilder = (path: string) => {
  let builder = builders.get(path);
  if (!builder) builders.set(path, builder = import(pathToFileURL(path).href).then(module => module.default as Builder));
  return builder;
};

const circuitFiles = (provider: Provider) => {
  const base = `${root}${provider.circuit.directory}`;
  const { name } = provider.circuit;
  return { zkey: `${base}/${name}.zkey`, wasm: `${base}/${name}_js/${name}.wasm`, calculator: `${base}/${name}_js/witness_calculator.js`, verificationKey: `${base}/verification_key.json` };
};
const hasArtifacts = (provider: Provider) => Object.values(circuitFiles(provider)).every(path => existsSync(path));

export const rapidsnarkPath = () => process.env.RAPIDSNARK_PATH ?? `${root}.local/bin/${process.platform}-${process.arch}/prover`;
export const rapidsnarkAvailable = () => process.env.PROVER !== "snarkjs" && existsSync(rapidsnarkPath());

/** Provider ids this host can prove for (proving key, witness files and verification key present). */
export function availableProviders(ids: ProviderId[]): ProviderId[] {
  return ids.filter(id => { try { return hasArtifacts(providerById(id)); } catch { return false; } });
}

// Resident set size in bytes of another process; 0 when it cannot be read. Linux reads
// the kernel's own high-water mark (VmHWM), elsewhere (macOS) ps reports the current size.
async function processRss(pid: number): Promise<number> {
  try {
    if (process.platform === "linux") {
      const match = /^VmHWM:\s+(\d+) kB/m.exec(await readFile(`/proc/${pid}/status`, "utf8"));
      return match ? Number(match[1]) * 1024 : 0;
    }
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    return Number(stdout.trim()) * 1024 || 0;
  } catch { return 0; }
}

function startRssSampler() {
  let peak = process.memoryUsage().rss;
  let child: number | undefined;
  let busy = false;
  const sample = async () => {
    if (busy) return;
    busy = true;
    try {
      const own = process.memoryUsage().rss;
      peak = Math.max(peak, own + (child ? await processRss(child) : 0));
    } finally { busy = false; }
  };
  const timer = setInterval(sample, 250);
  return {
    setChild(pid: number | undefined) { child = pid; void sample(); },
    stop() { clearInterval(timer); return Math.max(peak, process.memoryUsage().rss); },
  };
}

/** Tries rapidsnark; on any failure (or when absent) proves with snarkjs. */
async function groth16Prove(zkey: string, wtns: string, workDir: string, sampler: ReturnType<typeof startRssSampler>) {
  if (rapidsnarkAvailable()) {
    const proofPath = `${workDir}/rs-proof.json`;
    const publicPath = `${workDir}/rs-public.json`;
    try {
      const running = execFileAsync(rapidsnarkPath(), [zkey, wtns, proofPath, publicPath], { maxBuffer: 1 << 20 });
      sampler.setChild(running.child.pid);
      await running;
      return { proof: JSON.parse(readFileSync(proofPath, "utf8")) as Groth16Proof, publicSignals: JSON.parse(readFileSync(publicPath, "utf8")) as string[], prover: "rapidsnark" as const };
    } catch { /* fall back to snarkjs */ } finally {
      sampler.setChild(undefined);
      rmSync(proofPath, { force: true });
      rmSync(publicPath, { force: true });
    }
  }
  const snarkjs = await loadSnarkjs();
  return { ...(await snarkjs.groth16.prove(zkey, wtns, undefined, { singleThread: true })), prover: "snarkjs" as const };
}

const isFieldList = (value: unknown, length: number) => Array.isArray(value) && value.length === length;
export const isCircuitInput = (value: unknown): value is CircuitInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const scalar = (v: unknown) => typeof v === "number" || typeof v === "string";
  return ["identity", "keyHash", "audienceHash", "sessionKey", "genesisHash"].every(key => isFieldList(input[key], 2)) && scalar(input.sessionExpiresAt) && scalar(input.notBefore);
};

/**
 * Proves `input` for `provider` (a provider or its id) and verifies the result.
 * workDir must exist and be private (mode 700); it is left empty of this job's files.
 * Rejects with a ProveError whose message is fixed text.
 */
export async function proveInput({ provider, input, workDir, onStage }: {
  provider: Provider | ProviderId;
  input: unknown;
  workDir: string;
  /** Called as each stage starts, with the time since proveInput began. */
  onStage?: (stage: Stage, elapsedMs: number) => void;
}): Promise<ProveResult> {
  let resolved: Provider;
  try { resolved = typeof provider === "string" ? providerById(provider) : provider; } catch { throw new ProveError("bad_request", "Unknown provider"); }
  if (!isCircuitInput(input)) throw new ProveError("bad_request", "Input is not a circuit input");
  const files = circuitFiles(resolved);
  if (!hasArtifacts(resolved)) throw new ProveError("service_unavailable", "Proving keys for this provider are not installed");

  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const sampler = startRssSampler();
  const wtns = `${workDir}/proof.wtns`;
  const stage = (name: Stage) => onStage?.(name, elapsed());
  try {
    stage("witness");
    const builder = await loadBuilder(files.calculator);
    const calculator = await builder(readFileSync(files.wasm));
    writeFileSync(wtns, new Uint8Array(await calculator.calculateWTNSBin(input, true)), { mode: 0o600 });
    const witnessMs = elapsed();
    stage("proof");
    const proofStarted = performance.now();
    const { proof, publicSignals, prover } = await groth16Prove(files.zkey, wtns, workDir, sampler);
    const proveMs = Math.round(performance.now() - proofStarted);
    stage("verification");
    const verificationKey = JSON.parse(readFileSync(files.verificationKey, "utf8"));
    const snarkjs = await loadSnarkjs();
    if (JSON.stringify(expectedPublicSignals(input)) !== JSON.stringify(publicSignals) || !(await snarkjs.groth16.verify(verificationKey, publicSignals, proof))) throw new Error("verification");
    return { proof, publicSignals, measurement: { prover, witnessMs, proveMs, elapsedMs: elapsed(), peakRssBytes: sampler.stop() } };
  } catch {
    throw new ProveError("proof_failed", "The proof could not be produced");
  } finally {
    sampler.stop();
    rmSync(wtns, { force: true });
  }
}
