// Internal prover service (docs/service-architecture.md, "prover").
//
//   POST /v1/prove   Authorization: Bearer $ZKAUTH_PROVER_TOKEN, body { provider, input }
//   GET  /v1/health  { ok, rapidsnark, providers }
//
// The input holds an ID token and the wallet salt. It is read into memory, handed to a
// one-job worker process on a pipe, and never logged, echoed or written to disk; the
// witness lives in a mode-700 job directory that is removed when the job ends and
// again, for everything, at startup. Logs carry job timing and outcome only.
import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "../../../packages/protocol/src/node.ts";
import { availableProviders, isCircuitInput, rapidsnarkAvailable } from "./prove.ts";
import type { ProveErrorCode, ProveResult } from "./prove.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const worker = fileURLToPath(new URL("./worker.ts", import.meta.url));

export type ProverConfig = {
  port: number;
  host: string;
  token: string;
  concurrency: number;
  queue: number;
  workDir: string;
  maxBodyBytes: number;
  jobTimeoutMs: number;
  log: (entry: Record<string, unknown>) => void;
};

const integer = (name: string, value: string | undefined, fallback: number, minimum: number) => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer of at least ${minimum}`);
  return parsed;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProverConfig {
  if (!env.ZKAUTH_PROVER_TOKEN) throw new Error("ZKAUTH_PROVER_TOKEN is required");
  return {
    port: integer("PROVER_PORT", env.PROVER_PORT, 8781, 0),
    host: env.PROVER_HOST ?? "0.0.0.0",
    token: env.ZKAUTH_PROVER_TOKEN,
    concurrency: integer("PROVER_CONCURRENCY", env.PROVER_CONCURRENCY, 1, 1),
    queue: integer("PROVER_QUEUE", env.PROVER_QUEUE, 4, 0),
    workDir: resolve(env.PROVER_WORK_DIR ?? `${root}.local/service/prover`),
    // A real input is about 7 KB; this leaves room for larger circuits and rejects anything else early.
    maxBodyBytes: integer("PROVER_MAX_BODY_BYTES", env.PROVER_MAX_BODY_BYTES, 128 * 1024, 1024),
    jobTimeoutMs: integer("PROVER_JOB_TIMEOUT_SECONDS", env.PROVER_JOB_TIMEOUT_SECONDS, 900, 1) * 1000,
    log: entry => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry })),
  };
}

const STATUS: Record<string, number> = { bad_request: 400, not_found: 404, proof_failed: 422, rate_limited: 429, service_unavailable: 503 };
// Static texts only: nothing from a request or an exception is ever copied into one.
const MESSAGES: Record<string, string> = {
  unauthorized: "Missing or invalid bearer token",
  bad_json: "The request body is not valid JSON",
  bad_body: "The request must be { provider, input }",
  too_large: "The request body is too large",
  not_found: "No such endpoint",
  busy: "The prover queue is full",
  stopping: "The prover is shutting down",
  internal: "The prover failed unexpectedly",
};

class HttpError extends Error {
  code: string; status: number; retryAfter: number | undefined;
  constructor(code: string, status: number, message: string, retryAfter?: number) {
    super(message);
    this.code = code; this.status = status; this.retryAfter = retryAfter;
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Empties (creating if needed) the work directory, mode 700. */
export function prepareWorkDir(dir: string) {
  if (dir === "/" || dir === homedir() || dir === root.replace(/\/$/, "")) throw new Error("PROVER_WORK_DIR must be a directory dedicated to the prover");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir)) rmSync(`${dir}/${entry}`, { recursive: true, force: true });
}

type Outcome = { ok: true; result: ProveResult } | { ok: false; code: ProveErrorCode; message: string };

export async function startProver(config: ProverConfig): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  prepareWorkDir(config.workDir);
  const expectedToken = digest(config.token);
  const providerIds = Object.keys(PROVIDERS);
  let active = 0;
  let stopping = false;
  const waiting: { start: () => void; reject: (error: HttpError) => void }[] = [];
  const running = new Set<ReturnType<typeof spawn>>();
  const recent: number[] = [];

  const retryAfter = () => {
    const average = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 20000;
    return Math.min(300, Math.max(1, Math.ceil((average * (waiting.length + 1)) / config.concurrency / 1000)));
  };
  const full = () => active >= config.concurrency && waiting.length >= config.queue;
  const busy = () => new HttpError("rate_limited", 429, MESSAGES.busy!, retryAfter());

  function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string | number> = {}) {
    const payload = JSON.stringify(body);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store", ...headers });
    response.end(payload);
  }

  function authorize(request: IncomingMessage) {
    const header = request.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    // Equal-length digests make the comparison constant time whatever the token's length.
    if (!timingSafeEqual(digest(presented), expectedToken) || !presented) throw new HttpError("bad_request", 401, MESSAGES.unauthorized!);
  }

  function readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise((resolveBody, rejectBody) => {
      const declared = Number(request.headers["content-length"]);
      if (declared > config.maxBodyBytes) return rejectBody(new HttpError("bad_request", 413, MESSAGES.too_large!));
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > config.maxBodyBytes) { rejectBody(new HttpError("bad_request", 413, MESSAGES.too_large!)); chunks.length = 0; return; }
        chunks.push(chunk);
      });
      request.on("end", () => resolveBody(Buffer.concat(chunks)));
      request.on("error", () => rejectBody(new HttpError("bad_request", 400, MESSAGES.bad_body!)));
      request.on("close", () => rejectBody(new HttpError("bad_request", 400, MESSAGES.bad_body!)));
    });
  }

  // Takes a proving slot, queueing behind running jobs; cancel() leaves the queue if the client goes away.
  function admit(): { slot: Promise<void>; cancel: () => void } {
    if (stopping) throw new HttpError("service_unavailable", 503, MESSAGES.stopping!);
    if (active < config.concurrency) { active++; return { slot: Promise.resolve(), cancel() {} }; }
    if (waiting.length >= config.queue) throw busy();
    let entry!: (typeof waiting)[number];
    const slot = new Promise<void>((resolveSlot, rejectSlot) => {
      entry = { start: () => { active++; resolveSlot(); }, reject: rejectSlot };
      waiting.push(entry);
    });
    return { slot, cancel() { const index = waiting.indexOf(entry); if (index >= 0) { waiting.splice(index, 1); entry.reject(new HttpError("service_unavailable", 503, MESSAGES.stopping!)); } } };
  }
  function release() {
    active--;
    const next = waiting.shift();
    if (next) next.start();
  }

  function runWorker(job: { provider: string; input: unknown; workDir: string }): Promise<Outcome> {
    return new Promise(resolveOutcome => {
      const failed = (code: ProveErrorCode, message: string) => resolveOutcome({ ok: false, code, message });
      const child = spawn(process.execPath, [...process.execArgv, "--max-old-space-size=6000", worker], {
        stdio: ["pipe", "pipe", "ignore"], detached: true, env: { ...process.env, ZKAUTH_PROVER_TOKEN: "" },
      });
      running.add(child);
      const kill = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
      const timer = setTimeout(() => { kill(); failed("proof_failed", "The proof timed out"); }, config.jobTimeoutMs);
      const out: Buffer[] = [];
      let size = 0;
      child.stdout!.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= 1 << 20) out.push(chunk); });
      child.stdin!.on("error", () => { /* the worker exited early; the exit handler reports it */ });
      child.once("error", () => { clearTimeout(timer); running.delete(child); failed("service_unavailable", "The prover worker could not start"); });
      child.once("close", () => {
        clearTimeout(timer); running.delete(child); kill();
        try {
          const parsed = JSON.parse(Buffer.concat(out).toString("utf8"));
          if (parsed?.ok === true) return resolveOutcome({ ok: true, result: parsed.result });
          const code = parsed?.code === "bad_request" || parsed?.code === "service_unavailable" ? parsed.code : "proof_failed";
          return failed(code, typeof parsed?.message === "string" ? parsed.message : "The proof could not be produced");
        } catch { return failed("proof_failed", "The proof could not be produced"); }
      });
      child.stdin!.end(JSON.stringify(job));
    });
  }

  async function prove(request: IncomingMessage, response: ServerResponse) {
    authorize(request);
    if (stopping) throw new HttpError("service_unavailable", 503, MESSAGES.stopping!);
    if (full()) throw busy();
    const raw = await readBody(request);
    let body: { provider?: unknown; input?: unknown };
    try { body = JSON.parse(raw.toString("utf8")); } catch { throw new HttpError("bad_request", 400, MESSAGES.bad_json!); }
    if (typeof body !== "object" || body === null || typeof body.provider !== "string" || !Object.hasOwn(PROVIDERS, body.provider)
      || !isCircuitInput(body.input)) throw new HttpError("bad_request", 400, MESSAGES.bad_body!);
    const { provider, input } = body as { provider: string; input: object };

    const queuedAt = performance.now();
    const { slot, cancel } = admit();
    let gone = false;
    response.once("close", () => { gone = true; if (!response.writableEnded) cancel(); });
    try { await slot; } catch (error) { if (gone) return; throw error; }
    if (gone) { release(); return; }
    const jobId = randomUUID();
    const workDir = `${config.workDir}/${jobId}`;
    const started = performance.now();
    let outcome: Outcome;
    try {
      mkdirSync(workDir, { mode: 0o700 });
      outcome = await runWorker({ provider, input, workDir });
    } catch {
      outcome = { ok: false, code: "service_unavailable", message: "The prover worker could not start" };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      release();
    }
    const elapsedMs = Math.round(performance.now() - started);
    recent.push(elapsedMs); if (recent.length > 8) recent.shift();
    config.log({
      event: "job", provider, outcome: outcome.ok ? "ok" : outcome.code,
      queuedMs: Math.round(started - queuedAt), elapsedMs,
      ...(outcome.ok ? { prover: outcome.result.measurement.prover, proveMs: outcome.result.measurement.proveMs, peakRssBytes: outcome.result.measurement.peakRssBytes } : {}),
    });
    if (gone) return;
    if (outcome.ok) return send(response, 200, outcome.result);
    throw new HttpError(outcome.code, STATUS[outcome.code] ?? 500, outcome.message);
  }

  const server = createServer(async (request, response) => {
    try {
      const path = (request.url ?? "").split("?")[0];
      if (request.method === "GET" && path === "/v1/health") {
        const providers = availableProviders(providerIds);
        return send(response, 200, { ok: providers.length > 0 && !stopping, rapidsnark: rapidsnarkAvailable(), providers });
      }
      if (request.method === "POST" && path === "/v1/prove") return await prove(request, response);
      throw new HttpError("not_found", 404, MESSAGES.not_found!);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof HttpError) {
        return send(response, error.status, { error: { code: error.code, message: error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) } },
          { ...(error.retryAfter ? { "retry-after": error.retryAfter } : {}), ...(error.status === 413 ? { connection: "close" } : {}) });
      }
      send(response, 500, { error: { code: "service_unavailable", message: MESSAGES.internal! } });
    }
  });
  // Receiving a request is bounded; waiting in the queue and proving are not part of it.
  server.requestTimeout = 30000;

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(config.port, config.host, resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  return {
    server, port,
    async close() {
      stopping = true;
      for (const entry of waiting.splice(0)) entry.reject(new HttpError("service_unavailable", 503, MESSAGES.stopping!));
      for (const child of running) { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      rmSync(config.workDir, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let config: ProverConfig;
  try { config = loadConfig(); } catch (error) {
    console.error(`prover: ${(error as Error).message}`);
    process.exit(1);
  }
  const prover = await startProver(config);
  config.log({ event: "listening", port: prover.port, concurrency: config.concurrency, queue: config.queue, rapidsnark: rapidsnarkAvailable(), providers: availableProviders(Object.keys(PROVIDERS)) });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void prover.close().then(() => process.exit(0)); });
}
