// Shared test setup: starts the real server process on the +200 test port with a
// temporary work directory, and checks proofs independently with snarkjs.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expectedPublicSignals } from "../../../packages/protocol/src/node.ts";
import type { CircuitInput } from "../../../packages/protocol/src/node.ts";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const TOKEN = "test-prover-token-0123456789abcdef";
export const input: CircuitInput = JSON.parse(readFileSync(`${root}.local/phase3/synthetic-input.json`, "utf8"));
const verificationKey = JSON.parse(readFileSync(`${root}fixtures/phase3/verification_key.json`, "utf8"));

export type Running = { url: string; workDir: string; logs: string[]; stop(): Promise<void> };

export async function startServer(port: number, env: Record<string, string> = {}, options: { workDir?: string; token?: string | null } = {}): Promise<Running> {
  const workDir = options.workDir ?? mkdtempSync(`${tmpdir()}/prover-test-`);
  const logs: string[] = [];
  const child: ChildProcess = spawn(process.execPath, [...process.execArgv, `${root}services/prover/src/server.ts`], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PROVER_PORT: String(port), PROVER_HOST: "127.0.0.1", PROVER_WORK_DIR: workDir, ...(options.token === null ? {} : { ZKAUTH_PROVER_TOKEN: options.token ?? TOKEN }), ...env },
  });
  const ready = new Promise<void>((resolve, reject) => {
    let buffer = "";
    const read = (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        logs.push(line);
        if (line.includes('"event":"listening"')) resolve();
      }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.once("exit", code => reject(new Error(`prover exited with ${code}: ${logs.join(" | ")}`)));
  });
  await ready;
  return {
    url: `http://127.0.0.1:${port}`, workDir, logs,
    async stop() {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

export const prove = (server: Running, body: unknown, token: string | null = TOKEN) =>
  fetch(`${server.url}/v1/prove`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** Independent check, outside the service: the proof verifies and carries the expected public signals. */
export async function assertValidProof(result: { proof: unknown; publicSignals: string[] }, expected = input): Promise<boolean> {
  const snarkjs = await import(`${root}upstream/snarkjs-algorand/node_modules/snarkjs/main.js`);
  try {
    return JSON.stringify(result.publicSignals) === JSON.stringify(expectedPublicSignals(expected)) && await snarkjs.groth16.verify(verificationKey, result.publicSignals, result.proof);
  } finally { await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate(); }
}

/** Values from the input that must never appear in a response or a log line. */
export const secrets = (): string[] => {
  const raw = input as Record<string, unknown>;
  return [...input.identity, ...input.keyHash, ...input.sessionKey, ...["salt", "identityPreimage", "message", "signature"].map(key => JSON.stringify(raw[key]).slice(1, 41))];
};
