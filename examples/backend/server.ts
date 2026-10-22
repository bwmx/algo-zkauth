// A dApp backend that signs users in with their AlgoZKAuth wallet, trusting
// neither the AlgoZKAuth service nor the browser: @bwmx/algo-zkauth-verify checks each
// sign-in against the chain. Four routes:
//
//   GET  /api/nonce     a single-use challenge
//   POST /api/sign-in   { fields, signature, proof } from session.createSignIn or
//                       wallet.createSignIn; sets this backend's own session cookie
//   GET  /api/me        who is signed in (401 if nobody)
//   POST /api/sign-out
//
// Run: node examples/backend/server.ts (Node 24 runs the TypeScript as is).
// Settings come from the environment; see examples/backend/README.md.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { providerById, type ProviderId } from "@bwmx/algo-zkauth-protocol/node";
import { SignInError, createNonce, createVerifier, fetchAppSettings, type AppSettings, type VerifiedSignIn } from "@bwmx/algo-zkauth-verify";

const env = process.env;
const PORT = Number(env.PORT ?? 8785);
const BIND = env.BIND ?? "127.0.0.1";
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS ?? "http://localhost:8775").split(",").map((o) => o.trim()).filter(Boolean);
const ROOT = new URL("../../", import.meta.url);
const NONCE_SECONDS = 300;
const SESSION_SECONDS = 3600;

// Pinned app settings: a JSON file (APP_SETTINGS, an array of AppSettings) in production.
// For the local stack, read once from the service (ZKAUTH_SERVICE) and logged so they can be pinned.
async function appSettings(): Promise<AppSettings[]> {
  if (env.APP_SETTINGS) return JSON.parse(readFileSync(env.APP_SETTINGS, "utf8")) as AppSettings[];
  const service = env.ZKAUTH_SERVICE ?? "http://localhost:8780";
  const apps = (env.ZKAUTH_APPS ?? "example,wallet").split(",").map((a) => a.trim()).filter(Boolean);
  const settings = await Promise.all(apps.map((app) => fetchAppSettings(service, app)));
  console.log(JSON.stringify({ event: "app_settings", note: "read from the service once; pin these with APP_SETTINGS", settings }));
  return settings;
}

const settings = await appSettings();
const verificationKeys = Object.fromEntries([...new Set(settings.map((s) => s.provider))].map((provider) =>
  [provider, readFileSync(new URL(`${providerById(provider as ProviderId).circuit.directory}/verification_key.json`, ROOT))]));
const verifier = createVerifier({
  algodUrl: env.ALGOD_URL ?? "http://localhost:4101",
  algodToken: env.ALGOD_TOKEN ?? "a".repeat(64),
  apps: settings,
  verificationKeys,
  // A dev-mode LocalNet's block clock stands still between transactions (compose sets 600).
  ...(env.CLOCK_TOLERANCE_SECONDS ? { clockToleranceSeconds: Number(env.CLOCK_TOLERANCE_SECONDS) } : {}),
});

// In memory for the example; a real backend keeps these in its database.
const nonces = new Map<string, number>();
const sessions = new Map<string, VerifiedSignIn & { until: number }>();
const now = () => Math.floor(Date.now() / 1000);

function cors(request: IncomingMessage): Record<string, string> {
  const origin = request.headers.origin;
  return origin && ALLOWED_ORIGINS.includes(origin)
    ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST", vary: "Origin" }
    : {};
}
function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
}
const cookie = (request: IncomingMessage) => /(?:^|;\s*)sid=([A-Za-z0-9_-]{43})/.exec(request.headers.cookie ?? "")?.[1];
async function json(request: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { size += chunk.length; if (size > 64 * 1024) throw new Error("too large"); chunks.push(chunk as Buffer); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

createServer(async (request, response) => {
  const headers = cors(request);
  const path = new URL(request.url ?? "/", "http://backend").pathname;
  try {
    if (request.method === "OPTIONS") { response.writeHead(204, headers); return response.end(); }
    if (request.method === "GET" && path === "/api/health") return send(response, 200, { ok: true }, headers);
    if (request.method === "GET" && path === "/api/nonce") {
      for (const [n, until] of nonces) if (until < now()) nonces.delete(n);
      const nonce = createNonce();
      nonces.set(nonce, now() + NONCE_SECONDS);
      return send(response, 200, { nonce }, headers);
    }
    if (request.method === "POST" && path === "/api/sign-in") {
      const signIn = await json(request) as { fields?: { nonce?: unknown } };
      const nonce = typeof signIn?.fields?.nonce === "string" ? signIn.fields.nonce : "";
      const issued = nonces.get(nonce);
      nonces.delete(nonce);                                  // single use, whatever the outcome
      if (!issued || issued < now()) return send(response, 400, { error: "wrong_nonce", message: "Unknown or expired challenge; get a new nonce" }, headers);
      const who = await verifier.verify(signIn, { origin: ALLOWED_ORIGINS, nonce });
      const sid = randomBytes(32).toString("base64url");
      sessions.set(sid, { ...who, until: now() + SESSION_SECONDS });
      console.log(JSON.stringify({ event: "signed_in", app: who.app, address: who.address }));
      return send(response, 200, who, { ...headers, "set-cookie": `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}` });
    }
    if (request.method === "GET" && path === "/api/me") {
      const s = sessions.get(cookie(request) ?? "");
      if (!s || s.until < now()) return send(response, 401, { error: "not_signed_in" }, headers);
      return send(response, 200, s, headers);
    }
    if (request.method === "POST" && path === "/api/sign-out") {
      sessions.delete(cookie(request) ?? "");
      return send(response, 200, { signedOut: true }, { ...headers, "set-cookie": "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    }
    return send(response, 404, { error: "not_found" }, headers);
  } catch (error) {
    if (error instanceof SignInError) return send(response, error.code === "node_unavailable" ? 503 : 401, { error: error.code, message: error.message }, headers);
    return send(response, 400, { error: "bad_request" }, headers);
  }
}).listen(PORT, BIND, () => console.log(JSON.stringify({ event: "listening", url: `http://${BIND}:${PORT}`, apps: settings.map((s) => s.app), origins: ALLOWED_ORIGINS })));
