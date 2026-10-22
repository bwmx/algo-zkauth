import { toBase64Url } from "@bwmx/algo-zkauth-protocol";
import type { ProofResult } from "@bwmx/algo-zkauth-protocol";
import { ZkAuthError } from "./errors.ts";
import type { BrowserProverOptions } from "./types.ts";

// Every 256-bit public value is two 128-bit big-endian limbs (docs/phase3-protocol.md).
function signalBytes(signals: bigint[], index: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 2; i++) {
    let value = signals[index + i]!;
    if (value < 0n || value >= 1n << 128n) throw new ZkAuthError("proof_failed", "Proof has a noncanonical public signal");
    for (let j = 15; j >= 0; j--) { bytes[i * 16 + j] = Number(value & 255n); value >>= 8n; }
  }
  return bytes;
}

export type DecodedSignals = { commitment: string; keyHash: string; audienceHash: string; sessionKey: string; genesisHash: string; expiresAt: number; notBefore: number };

export function decodeSignals(publicSignals: string[]): DecodedSignals {
  if (!Array.isArray(publicSignals) || publicSignals.length !== 12) throw new ZkAuthError("proof_failed", "Proof must have twelve public signals");
  let signals: bigint[];
  try { signals = publicSignals.map((s) => BigInt(s)); } catch { throw new ZkAuthError("proof_failed", "Proof has malformed public signals"); }
  const digest = (index: number) => toBase64Url(signalBytes(signals, index));
  return {
    commitment: digest(0), keyHash: digest(2), audienceHash: digest(4), sessionKey: digest(6), genesisHash: digest(8),
    expiresAt: Number(signals[10]), notBefore: Number(signals[11]),
  };
}

/** The browser checks a proof's public bindings itself before signing anything under it. */
export function checkProofBindings(
  publicSignals: string[],
  expected: { commitment: string; audienceHash?: string; genesisHash: string; sessionKey: string; expiresAt: number },
): void {
  const d = decodeSignals(publicSignals);
  const ok = d.commitment === expected.commitment
    && (expected.audienceHash === undefined || d.audienceHash === expected.audienceHash)
    && d.genesisHash === expected.genesisHash
    && d.sessionKey === expected.sessionKey
    && d.expiresAt === expected.expiresAt;
  if (!ok) throw new ZkAuthError("proof_failed", "The proof does not match this session (commitment, network, session key or expiry)");
}

export type ProverMessage =
  | { type: "progress"; message: string }
  | { type: "result"; proof: ProofResult["proof"]; publicSignals: string[] }
  | { type: "error"; message: string };

export type Prover = (input: Record<string, unknown>, progress: (message: string) => void, signal?: AbortSignal) => Promise<ProofResult>;

/** Runs the proof in a module worker (src/prover-worker.ts). snarkjs is loaded by the worker from snarkjsUrl, never bundled here. */
export function createBrowserProver(options: BrowserProverOptions): Prover {
  if (options.run) {
    const run = options.run;
    return (input, progress) => run(input, progress);
  }
  const { wasmUrl, zkeyUrl, snarkjsUrl } = options;
  if (!wasmUrl || !zkeyUrl || !snarkjsUrl) throw new ZkAuthError("bad_request", "browserProver needs wasmUrl, zkeyUrl and snarkjsUrl");
  const spawn = (): Worker => {
    const w = options.worker;
    if (typeof w === "function") return w();
    if (w !== undefined) return new Worker(w, { type: "module" });
    return new Worker(new URL("./prover-worker.ts", import.meta.url), { type: "module" });
  };
  return (input, progress, signal) => new Promise<ProofResult>((resolve, reject) => {
    let worker: Worker;
    try { worker = spawn(); } catch (cause) { return reject(new ZkAuthError("proof_failed", "The browser could not start the proving worker", { cause })); }
    const done = (fn: () => void) => { signal?.removeEventListener("abort", onAbort); worker.terminate(); fn(); };
    const onAbort = () => done(() => reject(new ZkAuthError("login_cancelled", "Proving was cancelled")));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<ProverMessage>) => {
      if (data.type === "progress") progress(data.message);
      else if (data.type === "result") done(() => resolve({ proof: data.proof, publicSignals: data.publicSignals }));
      else done(() => reject(new ZkAuthError("proof_failed", data.message)));
    };
    worker.onerror = (event) => { event.preventDefault?.(); done(() => reject(new ZkAuthError("proof_failed", "The proving worker failed to run"))); };
    worker.onmessageerror = () => done(() => reject(new ZkAuthError("proof_failed", "The proving worker sent an unreadable message")));
    worker.postMessage({ type: "prove", input, wasmUrl, zkeyUrl, snarkjsUrl });
  });
}
