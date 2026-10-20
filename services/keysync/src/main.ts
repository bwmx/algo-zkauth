// keysync: keeps each provider's key registry in step with the provider's JWKS
// and watches it as the guardian does (docs/service-architecture.md, "keysync").
// Holds the administrator key. Logs one JSON object per line; never a mnemonic,
// a webhook URL or an SDK error text.
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { ConfigError, listProviderDeployments, loadServiceEnv, requireRole } from "../../../packages/config/src/index.ts";
import { openChain } from "../../../packages/chain/src/index.ts";
import type { ProviderDeployment, Signer } from "../../../packages/chain/src/types.ts";
import type { Jwks, Provider } from "../../../packages/protocol/src/types.ts";
import { runProvider, silenceAlgoKit, type RunResult } from "./sync.ts";

export const DEFAULT_PORT = 8782;
export const DEFAULT_INTERVAL_SECONDS = 900;
const DEFAULT_REPEAT_SECONDS = 6 * 3600;
const WEBHOOK_TIMEOUT_MS = 10_000;

type Env = NodeJS.ProcessEnv;
export type KeysyncConfig = { port: number; bind: string; intervalSeconds: number; webhook?: string; repeatSeconds: number };

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function loadKeysyncConfig(env: Env = process.env): KeysyncConfig {
  const webhook = env.KEYSYNC_ALERT_WEBHOOK || undefined;
  if (webhook) {
    let protocol = "";
    try { protocol = new URL(webhook).protocol; } catch { /* reported below */ }
    // The URL may carry a secret, so the message never repeats it.
    if (protocol !== "http:" && protocol !== "https:") throw new ConfigError("KEYSYNC_ALERT_WEBHOOK must be an http or https URL");
  }
  return {
    port: integer(env, "KEYSYNC_PORT", DEFAULT_PORT, 0, 65535),
    bind: env.KEYSYNC_BIND || "127.0.0.1",
    intervalSeconds: integer(env, "KEYSYNC_INTERVAL_SECONDS", DEFAULT_INTERVAL_SECONDS, 1, 86400),
    repeatSeconds: integer(env, "KEYSYNC_ALERT_REPEAT_SECONDS", DEFAULT_REPEAT_SECONDS, 0, 30 * 86400),
    ...(webhook ? { webhook } : {}),
  };
}

export type KeysyncOptions = {
  env?: Env;
  /** One JSON-serialisable object per log line; defaults to stdout. */
  log?: (line: Record<string, unknown>) => void;
  fetchJwks?: (provider: Provider) => Promise<Jwks>;
};

export type Keysync = {
  url: string;
  server: Server;
  /** Settles when the run at start has finished. */
  ready: Promise<void>;
  /** One pass over every provider deployment now (after any run in progress). */
  runOnce(): Promise<RunResult[]>;
  health(): Record<string, unknown>;
  close(): Promise<void>;
};

const stdout = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

export async function startKeysync(options: KeysyncOptions = {}): Promise<Keysync> {
  const env = options.env ?? process.env;
  const config = loadKeysyncConfig(env);
  const service = loadServiceEnv(env);
  silenceAlgoKit();
  const emit = options.log ?? stdout;
  const log = (level: "info" | "warn" | "alert" | "error", event: string, fields: Record<string, unknown> = {}) =>
    emit({ ts: new Date().toISOString(), service: "keysync", level, event, ...fields });
  const administrator: Signer = requireRole("admin", service, env, (message) => log("warn", "config", { message }));
  const startedAt = new Date().toISOString();

  let chain: Awaited<ReturnType<typeof openChain>> | undefined;
  const lastRun = new Map<string, RunResult>();
  const notified = new Map<string, { signature: string; at: number }>();

  async function notify(record: ProviderDeployment, result: RunResult) {
    const signature = result.alerts.map((a) => a.fingerprint).sort().join(",");
    const previous = notified.get(record.provider);
    if (!signature) {
      if (previous) { notified.delete(record.provider); log("info", "guardian_alert_cleared", { provider: record.provider }); }
      return;
    }
    // One JSON log line per run while the alert stands; the webhook hears of a change at once and a standing alert every repeat window.
    log("alert", "guardian_alert", {
      provider: record.provider, network: service.network, keyRegistryId: record.keyRegistryId, guardian: record.guardian,
      alerts: result.alerts.map(({ fingerprint, state, validFrom, validUntil, renewalEffectiveAt }) => ({ fingerprint, state, validFrom, validUntil, ...(renewalEffectiveAt ? { renewalEffectiveAt } : {}) })),
    });
    if (!config.webhook) return;
    const now = Date.now();
    if (previous && previous.signature === signature && now - previous.at < config.repeatSeconds * 1000) return;
    try {
      const response = await fetch(config.webhook, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        body: JSON.stringify({
          service: "keysync", event: "guardian_alert", at: result.at, network: service.network,
          provider: record.provider, keyRegistryId: record.keyRegistryId, guardian: record.guardian, alerts: result.alerts,
        }),
      });
      if (!response.ok) throw new Error("rejected");
      notified.set(record.provider, { signature, at: now });
    } catch {
      // Not the URL and not the error text: either may reveal the webhook's secret.
      log("error", "alert_webhook_failed", { provider: record.provider });
    }
  }

  async function pass(): Promise<RunResult[]> {
    let records: ProviderDeployment[] = [];
    try { records = listProviderDeployments(service); } catch { log("error", "deployments_unreadable"); }
    const results: RunResult[] = [];
    for (const record of records) {
      let result: RunResult;
      try {
        chain ??= await openChain({ network: service.network, algodUrl: service.algodUrl, algodToken: service.algodToken, indexerUrl: service.indexerUrl, root: service.root });
        result = await runProvider(chain, record, { service, administrator, ...(options.fetchJwks ? { fetchJwks: options.fetchJwks } : {}) });
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        result = { provider: record.provider, at: new Date().toISOString(), registered: [], renewed: [], sealed: false, alerts: [], error: typeof code === "string" ? code : "unexpected" };
      }
      lastRun.set(record.provider, result);
      log(result.error ? "error" : "info", "sync", {
        provider: result.provider, registered: result.registered.length, renewed: result.renewed.length, sealed: result.sealed, alerts: result.alerts.length, error: result.error,
      });
      await notify(record, result);
      results.push(result);
    }
    return results;
  }

  let queue: Promise<unknown> = Promise.resolve();
  const runOnce = () => { const next = queue.then(pass); queue = next.catch(() => {}); return next; };

  const health = () => {
    const providers = Object.fromEntries([...lastRun].map(([id, r]) => [id, { lastRun: { at: r.at, registered: r.registered, renewed: r.renewed, sealed: r.sealed, alerts: r.alerts, error: r.error } }]));
    return {
      ok: [...lastRun.values()].every((r) => r.error === null),
      service: "keysync", network: service.network, intervalSeconds: config.intervalSeconds, startedAt, providers,
    };
  };

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://keysync.invalid").pathname;
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Connection: "close" });
      response.end(JSON.stringify(body));
    };
    if (path !== "/v1/health") return send(404, { error: "not_found" });
    if (request.method !== "GET") { response.setHeader("Allow", "GET"); return send(405, { error: "method_not_allowed" }); }
    send(200, health());
  });
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(config.port, config.bind, () => { server.off("error", fail); done(); }); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  log("info", "start", { network: service.network, administrator: administrator.addr, intervalSeconds: config.intervalSeconds, port, webhook: Boolean(config.webhook), stateDir: service.stateDir });

  const ready = runOnce().then(() => {}, () => {});
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => { void runOnce().catch(() => {}).finally(schedule); }, config.intervalSeconds * 1000);
  };
  void ready.then(schedule);

  return {
    url: `http://${config.bind === "0.0.0.0" ? "127.0.0.1" : config.bind}:${port}`,
    server, ready, runOnce, health,
    async close() {
      stopped = true; clearTimeout(timer);
      await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); });
      await queue.catch(() => {});
      await chain?.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const keysync = await startKeysync();
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void keysync.close().then(() => process.exit(0)); });
  } catch (error) {
    // ConfigError and listen errors carry static text; anything else is reported by its class only.
    console.error(`keysync: ${error instanceof ConfigError ? error.message : `cannot start (${(error as NodeJS.ErrnoException)?.code ?? "error"})`}`);
    process.exit(1);
  }
}
