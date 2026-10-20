// LocalNet-only OpenID issuer. It emulates a real provider (Google by default):
// tokens carry that provider's issuer and claim profile, built with
// syntheticToken and signed by a persisted dev RSA-2048 key (kid "dev-1"). The
// provider's circuit accepts them once the dev key is registered in a LocalNet
// key registry. Nothing here authenticates a person; it must never run against
// TestNet or MainNet, and it refuses to start unless ZKAUTH_NETWORK=localnet.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, createHash, timingSafeEqual, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Provider } from "../../../packages/protocol/src/types.ts";
import { DEFAULT_PROVIDER, providerById, syntheticToken } from "../../../packages/protocol/src/node.ts";

export const KID = "dev-1";
export const CODE_TTL_SECONDS = 60;
export const DEFAULT_PORT = 8790;
const MAX_CODES = 1000;
const MAX_BODY = 16 * 1024;
const DEFAULT_SCOPE_VALUE = "T0DEVISSUER";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export type Config = { port: number; bind: string; baseUrl: string; provider: Provider; stateDir: string };
export type DevIssuer = { server: Server; url: string; provider: Provider; jwks: { keys: Record<string, unknown>[] }; close: () => Promise<void> };

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  if (env.ZKAUTH_NETWORK !== "localnet") throw new Error("The dev issuer runs only on LocalNet: set ZKAUTH_NETWORK=localnet");
  const port = env.DEV_ISSUER_PORT === undefined || env.DEV_ISSUER_PORT === "" ? DEFAULT_PORT : Number(env.DEV_ISSUER_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("DEV_ISSUER_PORT must be a port number");
  const baseUrl = (env.DEV_ISSUER_URL || `http://localhost:${port}`).replace(/\/+$/, "");
  try {
    if (!/^https?:$/.test(new URL(baseUrl).protocol)) throw new Error("scheme");
  } catch { throw new Error("DEV_ISSUER_URL must be an http or https URL"); }
  const provider = providerById(env.DEV_ISSUER_PROVIDER || DEFAULT_PROVIDER) as Provider;
  const stateDir = env.ZKAUTH_STATE_DIR ? resolve(env.ZKAUTH_STATE_DIR) : join(repoRoot, ".local/service");
  return { port, bind: env.DEV_ISSUER_BIND || "127.0.0.1", baseUrl, provider, stateDir };
}

// The RSA key lives in $ZKAUTH_STATE_DIR/dev-issuer/signing-key.pem (PKCS#8,
// 0600) so a restart serves the same JWKS and registered keys stay valid.
export function loadOrCreateKey(stateDir: string): KeyObject {
  const dir = join(stateDir, "dev-issuer");
  const file = join(dir, "signing-key.pem");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    try {
      writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  chmodSync(file, 0o600);
  const key = createPrivateKey(readFileSync(file));
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 2048) throw new Error("The dev issuer key must be RSA-2048");
  return key;
}

const SUBJECT = /^[A-Za-z0-9._@+-]{1,64}$/;
const CLIENT_ID = /^[A-Za-z0-9._~-]{1,200}$/;
const NONCE = /^[A-Za-z0-9._~+=-]{1,255}$/;
const STATE = /^[\x20-\x7e]{1,512}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE = /^[A-Za-z0-9_-]{1,128}$/;

type Pending = { clientId: string; redirectUri: string; nonce: string; subject: string; subjectScope: string; challenge?: string; expiresAt: number };
type Params = Record<string, string>;
class HttpError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

function validRedirect(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new HttpError(400, "invalid_redirect_uri");
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, "invalid_redirect_uri"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hash || url.username || url.password) throw new HttpError(400, "invalid_redirect_uri");
  return value;
}

function authorizeParams(source: Params) {
  if (source.response_type !== undefined && source.response_type !== "code") throw new HttpError(400, "unsupported_response_type");
  const redirectUri = validRedirect(source.redirect_uri);
  if (!CLIENT_ID.test(source.client_id ?? "")) throw new HttpError(400, "invalid_client_id");
  if (!NONCE.test(source.nonce ?? "")) throw new HttpError(400, "invalid_nonce");
  if (source.state !== undefined && !STATE.test(source.state)) throw new HttpError(400, "invalid_state");
  let challenge: string | undefined;
  if (source.code_challenge) {
    if (source.code_challenge_method !== "S256" || !CHALLENGE.test(source.code_challenge)) throw new HttpError(400, "invalid_code_challenge");
    challenge = source.code_challenge;
  }
  return { clientId: source.client_id, redirectUri, nonce: source.nonce, state: source.state, challenge };
}

export async function startDevIssuer(config: Config, options: { now?: () => number; key?: KeyObject } = {}): Promise<DevIssuer> {
  const { provider, baseUrl } = config;
  const now = options.now ?? Date.now;
  const privateKey = options.key ?? loadOrCreateKey(config.stateDir);
  const jwks = { keys: [{ ...createPublicKey(privateKey).export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }] };
  const codes = new Map<string, Pending>();
  const scope = provider.subjectScope;

  const issue = (audience: string, nonce: string, subject: string, subjectScope: string) =>
    syntheticToken(provider, { privateKey, kid: KID, audience, subject, subjectScope, nonce, issuedAt: Math.floor(now() / 1000) }) as string;

  function validSubject(subject: unknown, subjectScope: unknown) {
    if (typeof subject !== "string" || !SUBJECT.test(subject)) throw new HttpError(400, "invalid_subject");
    const value = subjectScope === undefined || subjectScope === "" ? DEFAULT_SCOPE_VALUE : subjectScope;
    if (scope && (typeof value !== "string" || !scope.pattern.test(value) || value.length > scope.maxLength)) throw new HttpError(400, "invalid_subject_scope");
    return { subject, subjectScope: String(value) };
  }

  function signInPage(params: ReturnType<typeof authorizeParams>) {
    const hidden = Object.entries({ client_id: params.clientId, redirect_uri: params.redirectUri, nonce: params.nonce, state: params.state, code_challenge: params.challenge, code_challenge_method: params.challenge ? "S256" : undefined })
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value as string)}">`).join("\n");
    const scopeField = scope
      ? `<label>${escapeHtml(scope.name)} (${escapeHtml(scope.claim)})<input name="subject_scope" value="${DEFAULT_SCOPE_VALUE}" maxlength="${scope.maxLength}" autocomplete="off"></label>`
      : "";
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dev issuer sign-in</title>
<style>body{font:16px system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem;margin:.25rem .25rem .25rem 0}label{display:block;margin:1rem 0}input[name=custom_subject],input[name=subject_scope]{display:block;font:inherit;width:100%;box-sizing:border-box;padding:.4rem}.warn{background:#fff3cd;color:#533f03;padding:.6rem .8rem;border-radius:.4rem}</style></head>
<body><h1>Dev issuer</h1>
<p class="warn">LocalNet only. This page signs in as a test user for ${escapeHtml(provider.label)}; it checks no password.</p>
<form method="post" action="/authorize">
${hidden}
${scopeField}
<p>Sign in as</p>
<button name="subject" value="alice">alice</button><button name="subject" value="bob">bob</button>
<label>or another subject<input name="custom_subject" maxlength="64" autocomplete="off" placeholder="letters, digits, . _ @ + -"></label>
<button name="subject" value="">Sign in with this subject</button>
</form></body></html>`;
  }

  function prune() {
    const t = now();
    for (const [code, entry] of codes) if (entry.expiresAt <= t) codes.delete(code);
    while (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value as string);
  }

  function complete(form: Params): string {
    const params = authorizeParams(form);
    const chosen = form.custom_subject?.trim() || form.subject;
    const { subject, subjectScope } = validSubject(chosen, form.subject_scope);
    prune();
    const code = randomBytes(32).toString("base64url");
    codes.set(code, { clientId: params.clientId, redirectUri: params.redirectUri, nonce: params.nonce, subject, subjectScope, challenge: params.challenge, expiresAt: now() + CODE_TTL_SECONDS * 1000 });
    const target = new URL(params.redirectUri);
    target.searchParams.set("code", code);
    if (params.state !== undefined) target.searchParams.set("state", params.state);
    return target.toString();
  }

  function exchange(form: Params): string {
    if (form.grant_type !== "authorization_code") throw new HttpError(400, "unsupported_grant_type");
    if (typeof form.code !== "string" || !CODE.test(form.code)) throw new HttpError(400, "invalid_grant");
    // Single use: any attempt consumes the code.
    const entry = codes.get(form.code);
    codes.delete(form.code);
    if (!entry || entry.expiresAt <= now()) throw new HttpError(400, "invalid_grant");
    if (typeof form.client_id !== "string" || !equal(form.client_id, entry.clientId)) throw new HttpError(400, "invalid_grant");
    if (typeof form.redirect_uri !== "string" || !equal(form.redirect_uri, entry.redirectUri)) throw new HttpError(400, "invalid_grant");
    if (entry.challenge) {
      if (typeof form.code_verifier !== "string" || !VERIFIER.test(form.code_verifier) || !equal(createHash("sha256").update(form.code_verifier, "ascii").digest("base64url"), entry.challenge)) throw new HttpError(400, "invalid_grant");
    }
    return issue(entry.clientId, entry.nonce, entry.subject, entry.subjectScope);
  }

  async function readBody(request: IncomingMessage): Promise<Params> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, "request_too_large");
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (/^application\/json\b/i.test(request.headers["content-type"] ?? "")) {
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new HttpError(400, "invalid_request"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request");
      return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string")) as Params;
    }
    return Object.fromEntries(new URLSearchParams(text));
  }

  const headers = (type: string) => ({ "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", Connection: "close" });
  const json = (response: ServerResponse, status: number, body: unknown) => { response.writeHead(status, headers("application/json")); response.end(JSON.stringify(body)); };
  const html = (response: ServerResponse, status: number, body: string) => {
    response.writeHead(status, { ...headers("text/html; charset=utf-8"), "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
    response.end(body);
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://dev-issuer.invalid");
    const path = url.pathname;
    const method = request.method ?? "GET";
    const wantsHtml = path === "/authorize";
    try {
      const only = (allowed: string) => { if (method !== allowed) { response.setHeader("Allow", allowed); throw new HttpError(405, "method_not_allowed"); } };
      if (path === "/.well-known/openid-configuration") {
        only("GET");
        return json(response, 200, {
          issuer: provider.issuer,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          jwks_uri: `${baseUrl}/jwks`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          scopes_supported: ["openid"],
          code_challenge_methods_supported: ["S256"],
          dev_issuer: true,
        });
      }
      if (path === "/jwks") { only("GET"); return json(response, 200, jwks); }
      if (path === "/v1/health") { only("GET"); return json(response, 200, { ok: true, provider: provider.id, issuer: provider.issuer, kid: KID }); }
      if (path === "/authorize") {
        if (method === "GET") return html(response, 200, signInPage(authorizeParams(Object.fromEntries(url.searchParams))));
        only("POST");
        response.writeHead(302, { ...headers("text/plain"), Location: complete(await readBody(request)) });
        return response.end();
      }
      if (path === "/token") {
        only("POST");
        return json(response, 200, { ok: true, token_type: "Bearer", id_token: exchange(await readBody(request)) });
      }
      if (path === "/test/token") {
        only("POST");
        const body = await readBody(request);
        if (!CLIENT_ID.test(body.audience ?? "")) throw new HttpError(400, "invalid_audience");
        if (!NONCE.test(body.nonce ?? "")) throw new HttpError(400, "invalid_nonce");
        const { subject, subjectScope } = validSubject(body.subject, body.subjectScope);
        return json(response, 200, { id_token: issue(body.audience, body.nonce, subject, subjectScope) });
      }
      throw new HttpError(404, "not_found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "server_error";
      if (wantsHtml && request.headers.accept?.includes("text/html")) return html(response, status, `<!doctype html><meta charset="utf-8"><title>Dev issuer</title><p>Sign-in request refused: ${escapeHtml(code)}.</p>`);
      json(response, status, { error: code });
    }
  });

  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(config.port, config.bind, () => { server.off("error", fail); done(); }); });
  return {
    server, url: baseUrl, provider, jwks,
    close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const issuer = await startDevIssuer(config);
    console.log(JSON.stringify({ service: "dev-issuer", provider: config.provider.id, url: issuer.url, bind: config.bind, port: config.port, kid: KID }));
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void issuer.close().then(() => process.exit(0)); });
  } catch (error) {
    console.error(`dev-issuer: ${(error as Error).message}`);
    process.exit(1);
  }
}
