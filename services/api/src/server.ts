// AlgoZKAuth /v1 REST service (services/api/openapi.yaml, docs/service-architecture.md).
//
// Sessions bind a browser session key into the login nonce; the service checks
// the provider's ID token (in-page, or by exchanging a code-flow code itself),
// binds the wallet salt, obtains a proof from the prover (or verifies one the
// browser made), prepares action plans the session key signs, and submits them
// with the sponsor paying fees.
//
// Never logged or echoed: ID tokens, codes, salts, circuit input, session ids
// and mnemonics. Log lines carry the route template, status and timing only.
// Errors are openapi ErrorCode values with static messages.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  actionDigest, authorizeUrl, exchangeCode, expectedPublicSignals, fetchJwks, fromBase64Url, oidcCircuitInput,
  redirectUri, signalDigest, usesPkce,
} from "../../../packages/protocol/src/node.ts";
import type { ActionPlan, CircuitInput, Jwks, Provider, ProofResult } from "../../../packages/protocol/src/node.ts";
import {
  ConfigError, appClientSecret, deployedApps, loadServiceEnv, providerFor, requireRole,
} from "../../../packages/config/src/index.ts";
import type { AppConfig, ServiceEnv } from "../../../packages/config/src/index.ts";
import type { AppDeployment, ProviderDeployment, Signer } from "../../../packages/chain/src/types.ts";
import { ChainError } from "../../../packages/chain/src/errors.ts";
import { AlgorandClient, decodeAddress, microAlgos } from "../../../packages/chain/src/deps.ts";
import { ApiError, MESSAGES, errorBody, fail, toApiError } from "./errors.ts";
import { readJson, sendClosePage, sendJson } from "./http.ts";
import { RateLimiter, SponsorQuotas, checkOrigin, corsHeaders, knownOrigins } from "./policy.ts";
import { Sessions, sessionView } from "./sessions.ts";
import type { ProofJob, Session } from "./sessions.ts";

export const PLAN_SECONDS = 120;
const PROVER_TIMEOUT_MS = 15 * 60_000;
const JWKS_TTL_MS = 60_000;
const KEYS_TTL_MS = 30_000;

export type ApiConfig = {
  port: number;
  host: string;
  publicUrl: string;
  proverUrl: string;
  proverToken: string;
  service: ServiceEnv;
  sponsor: Signer;
  /** Sessions one client address may start per window. */
  sessionRateLimit: number;
  sessionRateWindowMs: number;
  /** Take the client address from X-Forwarded-For (behind a trusted proxy only). */
  trustProxy: boolean;
  publicAlgodUrl?: string;
  publicIndexerUrl?: string;
  env: NodeJS.ProcessEnv;
  log: (entry: Record<string, unknown>) => void;
};

const integer = (name: string, value: string | undefined, fallback: number, minimum: number) => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new ConfigError(`${name} must be an integer of at least ${minimum}`);
  return parsed;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env, log: ApiConfig["log"] = (entry) => console.log(JSON.stringify({ time: new Date().toISOString(), service: "api", ...entry }))): ApiConfig {
  const service = loadServiceEnv(env);
  const port = integer("API_PORT", env.API_PORT, 8780, 0);
  const publicUrl = (env.ZKAUTH_API_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, "");
  try { if (!/^https?:$/.test(new URL(publicUrl).protocol)) throw new Error(); } catch { throw new ConfigError("ZKAUTH_API_PUBLIC_URL must be an http or https URL"); }
  if (!env.ZKAUTH_PROVER_TOKEN) throw new ConfigError("Set ZKAUTH_PROVER_TOKEN, the prover's bearer secret");
  return {
    port, host: env.API_HOST || "127.0.0.1", publicUrl,
    proverUrl: (env.ZKAUTH_PROVER_URL || "http://localhost:8781").replace(/\/+$/, ""),
    proverToken: env.ZKAUTH_PROVER_TOKEN,
    service,
    sponsor: requireRole("sponsor", service, env, (message) => log({ event: "warning", message })),
    sessionRateLimit: integer("API_SESSION_RATE_LIMIT", env.API_SESSION_RATE_LIMIT, 30, 1),
    sessionRateWindowMs: integer("API_SESSION_RATE_WINDOW_SECONDS", env.API_SESSION_RATE_WINDOW_SECONDS, 60, 1) * 1000,
    trustProxy: env.API_TRUST_PROXY === "1",
    publicAlgodUrl: env.ZKAUTH_PUBLIC_ALGOD_URL || (env.ZKAUTH_ALGOD_URL ? undefined : service.algodUrl),
    publicIndexerUrl: env.ZKAUTH_PUBLIC_INDEXER_URL || (env.ZKAUTH_INDEXER_URL ? undefined : service.indexerUrl),
    env, log,
  };
}

/** AlgoKit logs every transaction (with app-call arguments) at info level; the service logs nothing of it. */
async function silenceAlgoKit() {
  const { Config } = await import("../../../upstream/snarkjs-algorand/node_modules/@algorandfoundation/algokit-utils/index.mjs");
  const quiet = () => {};
  Config.configure({ logger: { error: quiet, warn: quiet, info: quiet, verbose: quiet, debug: quiet } as any, debug: false });
}

type Wallets = ReturnType<Awaited<ReturnType<typeof import("../../../packages/chain/src/index.ts").openChain>>["wallets"]>;
type AppRuntime = {
  config: AppConfig;
  record: AppDeployment;
  deployment: ProviderDeployment;
  provider: Provider;
  wallets: Wallets;
  /** Code flow: where the provider redirects, whether PKCE is used and the client secret. */
  code?: { redirect: string; pkce: boolean; clientSecret?: string };
};
type Plan = { plan: ActionPlan; sessionId: string; app: string; expiresAt: number; used: boolean };

type Route = { name: string; params: string[] };
const ROUTES: [string, RegExp, string][] = [
  ["GET", /^\/v1\/health$/, "health"],
  ["GET", /^\/v1\/apps\/([^/]+)\/config$/, "config"],
  ["GET", /^\/v1\/apps\/([^/]+)\/wallets\/([^/]+)$/, "wallet"],
  ["POST", /^\/v1\/sessions$/, "start"],
  ["GET", /^\/v1\/sessions\/([^/]+)$/, "session"],
  ["DELETE", /^\/v1\/sessions\/([^/]+)$/, "end"],
  ["POST", /^\/v1\/sessions\/([^/]+)\/token$/, "token"],
  ["POST", /^\/v1\/sessions\/([^/]+)\/salt$/, "salt"],
  ["POST", /^\/v1\/sessions\/([^/]+)\/proofs$/, "prove"],
  ["GET", /^\/v1\/sessions\/([^/]+)\/proofs\/([^/]+)$/, "job"],
  ["POST", /^\/v1\/sessions\/([^/]+)\/circuit-input$/, "circuitInput"],
  ["PUT", /^\/v1\/sessions\/([^/]+)\/proof$/, "uploadProof"],
  ["POST", /^\/v1\/actions$/, "prepare"],
  ["POST", /^\/v1\/actions\/([^/]+)\/submit$/, "submit"],
  ["GET", /^\/v1\/oauth\/([a-z]{1,32})\/callback$/, "callback"],
  // LocalNet only: fund a wallet from the sponsor so the demo can be used without a dispenser.
  ["POST", /^\/v1\/apps\/([^/]+)\/dev\/fund$/, "devFund"],
];
// Log templates: never the path, which carries session ids.
const TEMPLATES: Record<string, string> = {
  health: "/v1/health", config: "/v1/apps/:app/config", wallet: "/v1/apps/:app/wallets/:address", start: "/v1/sessions",
  session: "/v1/sessions/:id", end: "/v1/sessions/:id", token: "/v1/sessions/:id/token", salt: "/v1/sessions/:id/salt",
  prove: "/v1/sessions/:id/proofs", job: "/v1/sessions/:id/proofs/:job", circuitInput: "/v1/sessions/:id/circuit-input",
  uploadProof: "/v1/sessions/:id/proof", prepare: "/v1/actions", submit: "/v1/actions/:plan/submit", callback: "/v1/oauth/:provider/callback", devFund: "/v1/apps/:app/dev/fund",
};

function match(method: string, path: string): Route | "method" | undefined {
  let pathMatched = false;
  for (const [m, pattern, name] of ROUTES) {
    const found = pattern.exec(path);
    if (!found) continue;
    pathMatched = true;
    if (m === method) return { name, params: found.slice(1) };
  }
  return pathMatched ? "method" : undefined;
}

const str = (value: unknown) => (typeof value === "string" ? value : undefined);

export async function startApi(config: ApiConfig): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const { service, log } = config;
  await silenceAlgoKit();
  const { openChain } = await import("../../../packages/chain/src/index.ts");
  const chain = await openChain({ network: service.network, algodUrl: service.algodUrl, algodToken: service.algodToken, indexerUrl: service.indexerUrl, root: service.root });
  const genesisHash = Buffer.from(chain.genesisHash, "base64url");

  // Apps with their deployments. An app whose on-chain registry differs from its record is left out.
  const apps = new Map<string, AppRuntime>();
  for (const { app, record, provider: deployment } of deployedApps(service)) {
    const provider = providerFor(app.provider, service);
    let wallets: Wallets;
    try {
      wallets = chain.wallets(record, deployment);
      await wallets.verify({ sender: config.sponsor.addr });
    } catch (error) {
      log({ event: "app_skipped", app: app.id, reason: error instanceof ChainError ? error.code : "unavailable" });
      continue;
    }
    let code: AppRuntime["code"];
    if (provider.login.flow === "code") {
      const redirect = redirectUri(provider, `${config.publicUrl}/v1/oauth/${provider.id}/callback`, app.redirectUri ?? undefined);
      const pkce = usesPkce(provider, redirect);
      // The dev issuer checks no secret, but the exchange without PKCE sends one.
      const clientSecret = appClientSecret(app, config.env) || (service.devIssuerUrl ? "dev-issuer" : undefined);
      if (!pkce && !clientSecret) throw new ConfigError(`App ${app.id} uses the code flow with an https redirect; set ${app.clientSecretEnv ?? "its clientSecretEnv"}`);
      code = { redirect, pkce, clientSecret };
    }
    apps.set(app.id, { config: app, record, deployment, provider, wallets, code });
  }
  const origins = knownOrigins([...apps.values()].map((a) => a.config));

  // Session times follow the chain's clock (the latest block), because the proof's
  // session window is checked against it on chain. On TestNet that is within a block
  // of wall time; a LocalNet in dev mode keeps its own clock.
  let clockOffset = 0;
  const syncClock = async () => {
    try { clockOffset = Number(await chain.time()) - Math.floor(Date.now() / 1000); } catch { fail("service_unavailable"); }
  };
  await syncClock();
  const sessions = new Sessions({ now: () => Math.floor(Date.now() / 1000) + clockOffset });
  const quotas = new SponsorQuotas();
  const sessionLimiter = new RateLimiter(config.sessionRateLimit, config.sessionRateWindowMs);
  // The LocalNet faucet: 5 ALGO from the sponsor, a few times a minute per client, never past 20 ALGO.
  const faucetLimiter = new RateLimiter(6, 60_000);
  const faucet = service.network === "localnet" && config.env.API_DEV_FAUCET !== "0"
    ? AlgorandClient.fromConfig({ algodConfig: { server: service.algodUrl, token: service.algodToken } })
    : undefined;
  async function devFund(address: unknown, client: string) {
    if (!faucet) fail("not_found");
    if (typeof address !== "string") fail("bad_request", "Not an Algorand address");
    try { decodeAddress(address); } catch { fail("bad_request", "Not an Algorand address"); }
    faucetLimiter.hit(client);
    const account = await faucet.client.algod.accountInformation(address).do();
    if (account.amount >= 20_000_000n) fail("quota_exceeded", "This address already holds enough LocalNet ALGO");
    const sent = await faucet.send.payment({ sender: config.sponsor.addr, signer: config.sponsor.signer as never, receiver: address, amount: microAlgos(5_000_000), note: "algozkauth localnet faucet" });
    return { txId: sent.txIds[0], amountMicroAlgos: "5000000" };
  }
  const plans = new Map<string, Plan>();
  const running = new Set<Promise<void>>();
  let stopping = false;

  // ---- Cached public data ------------------------------------------------------
  const jwksCache = new Map<string, { at: number; value: Promise<Jwks> }>();
  const jwksFor = (provider: Provider): Promise<Jwks> => {
    const cached = jwksCache.get(provider.id);
    if (cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.value;
    const value = fetchJwks(provider).catch(() => { jwksCache.delete(provider.id); return fail("service_unavailable", "The provider's signing keys are unavailable"); });
    jwksCache.set(provider.id, { at: Date.now(), value });
    return value;
  };
  const keysCache = new Map<string, { at: number; value: Promise<unknown[]> }>();
  const approvedKeys = (rt: AppRuntime) => {
    const cached = keysCache.get(rt.deployment.provider);
    if (cached && Date.now() - cached.at < KEYS_TTL_MS) return cached.value;
    const value = chain.keys(rt.deployment).list()
      .then((keys) => keys.filter((k) => !k.revoked).map(({ revoked: _revoked, ...k }) => k))
      .catch(() => { keysCache.delete(rt.deployment.provider); return fail("service_unavailable"); });
    keysCache.set(rt.deployment.provider, { at: Date.now(), value });
    return value;
  };

  // ---- Helpers -------------------------------------------------------------------
  const appById = (id: unknown): AppRuntime => (typeof id === "string" && apps.get(id)) || fail("app_unknown");
  const sessionFor = (id: unknown, origin: string | undefined, o: { requireLogin?: boolean } = {}) => {
    const s = sessions.get(id);
    const rt = appById(s.app);
    checkOrigin(rt.config, origin);
    if (o.requireLogin && !s.loggedIn) fail("not_signed_in");
    return { s, rt };
  };
  const withSalt = (s: Session) => (s.salt && s.owner ? s : fail("salt_required"));
  const circuitInput = (s: Session): CircuitInput => {
    withSalt(s);
    try {
      // Token checks are as of login; the session's own expiry still applies.
      return oidcCircuitInput({
        provider: s.provider, token: s.token!, jwks: s.jwks!, audience: s.audience, nonce: s.nonce, genesisHash: s.genesisHash,
        sessionPublicKey: s.sessionPublicKey, expiresAt: s.expiresAt, randomness: s.randomness, salt: s.salt!, nowSeconds: s.verifiedAt!,
      });
    } catch { return fail("proof_failed", "The login token does not fit the circuit"); }
  };
  // A chain call on a proof; a key still in its approval delay reports when it activates.
  const onProof = async <T>(rt: AppRuntime, proof: ProofResult, call: () => Promise<T>): Promise<T> => {
    try { return await call(); } catch (error) {
      if (error instanceof ChainError && error.code === "key_pending_delay") {
        let retryAfter: number | undefined;
        try {
          const fingerprint = signalDigest(proof.publicSignals, 2).toString("base64url");
          const key = (await chain.keys(rt.deployment).list()).find((k) => k.fingerprint === fingerprint);
          if (key) retryAfter = Math.max(1, Number(BigInt(key.validFrom) - (await chain.time())));
        } catch { /* without a hint */ }
        throw new ApiError("key_pending_delay", MESSAGES.key_pending_delay, retryAfter);
      }
      throw error;
    }
  };
  const jobView = (job: ProofJob, s: Session) => ({
    stage: job.stage, elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    ...(job.stage === "ready" && s.proof ? { publicSignals: s.proof.publicSignals } : {}),
    ...(job.measurement ? { measurement: job.measurement } : {}),
    ...(job.error ? { error: job.error } : {}),
  });

  async function completeLogin(s: Session, token: unknown) {
    const jwks = await jwksFor(s.provider);
    await syncClock();
    sessions.login(s.id, token, jwks);
  }

  // A service proof: the circuit input goes to the prover and is not kept.
  async function runProof(s: Session, rt: AppRuntime, job: ProofJob) {
    try {
      let input: CircuitInput | undefined = circuitInput(s);
      const expected = expectedPublicSignals(input);
      job.stage = "proof";
      let response: Response;
      try {
        response = await fetch(`${config.proverUrl}/v1/prove`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.proverToken}` },
          body: JSON.stringify({ provider: rt.provider.id, input }),
          signal: AbortSignal.timeout(PROVER_TIMEOUT_MS),
        });
      } catch { return fail("service_unavailable"); }
      finally { input = undefined; }
      if (response.status === 429) return fail("rate_limited");
      if (response.status === 422) return fail("proof_failed");
      if (!response.ok) return fail("service_unavailable");
      const result = await response.json() as ProofResult & { measurement?: Record<string, unknown> };
      job.stage = "verification";
      if (!Array.isArray(result?.publicSignals) || JSON.stringify(result.publicSignals) !== JSON.stringify(expected)) fail("proof_failed");
      const proof = { proof: result.proof, publicSignals: result.publicSignals };
      await onProof(rt, proof, () => rt.wallets.checkProof(proof));
      const m = result.measurement ?? {};
      job.measurement = {
        prover: m.prover === "snarkjs" ? "snarkjs" : "rapidsnark",
        ...(typeof m.witnessMs === "number" ? { witnessMs: m.witnessMs } : {}),
        ...(typeof m.proveMs === "number" ? { proveMs: m.proveMs } : {}),
        ...(typeof m.elapsedMs === "number" ? { elapsedMs: m.elapsedMs } : {}),
      };
      if (sessions.entries.get(s.id) !== s) return;
      s.proof = proof;
      job.stage = "ready";
    } catch (error) {
      job.stage = "failed";
      job.error = toApiError(error).code;
    } finally {
      job.finishedAt = Date.now();
    }
  }

  // ---- Handlers -----------------------------------------------------------------
  async function health() {
    const probe = async (url: string, headers: Record<string, string>, ok: (r: Response) => Promise<boolean>) => {
      try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(3000) }); return (await ok(r)) ? "ok" : "unavailable"; } catch { return "unavailable"; }
    };
    const [prover, algod] = await Promise.all([
      probe(`${config.proverUrl}/v1/health`, {}, async (r) => r.ok && (await r.json())?.ok === true),
      probe(`${service.algodUrl.replace(/\/+$/, "")}/health`, service.algodToken ? { "X-Algo-API-Token": service.algodToken } : {}, async (r) => r.ok),
    ]);
    return { ok: prover === "ok" && algod === "ok" && !stopping, network: service.network, prover, algod };
  }

  async function appConfig(rt: AppRuntime) {
    const { config: app, record, deployment, provider } = rt;
    return {
      app: app.id, provider: provider.id, providers: [provider.id], providerLabels: { [provider.id]: provider.label },
      loginFlow: provider.login.flow, clientId: app.clientId, network: service.network, genesisHash: chain.genesisHash,
      audienceHash: record.audienceHash, registryId: record.registryId, keyRegistryId: deployment.keyRegistryId,
      verifier: deployment.verifier, verificationKeySha256: deployment.verificationKeySha256,
      enrollmentDeposit: record.enrollmentDeposit, groupFeeMicroAlgos: record.groupFeeMicroAlgos, sponsor: config.sponsor.addr,
      ...(config.publicAlgodUrl ? { algodUrl: config.publicAlgodUrl } : {}),
      ...(config.publicIndexerUrl ? { indexerUrl: config.publicIndexerUrl } : {}),
      approvedKeys: await approvedKeys(rt),
    };
  }

  async function startSession(body: Record<string, unknown>, origin: string | undefined, client: string) {
    const rt = appById(body.app);
    checkOrigin(rt.config, origin);
    if (body.provider !== undefined && body.provider !== rt.provider.id) fail("provider_unsupported");
    sessionLimiter.hit(client);
    await syncClock();
    const s = sessions.start({
      app: rt.config.id, provider: rt.provider, audience: rt.config.clientId, genesisHash,
      sessionPublicKey: body.sessionPublicKey, randomness: body.randomness,
      ...(rt.code ? { redirect: rt.code.redirect, pkce: rt.code.pkce } : {}),
    });
    return {
      sessionId: s.id, nonce: s.nonce, expiresAt: s.expiresAt, networkTime: sessions.now(), loginFlow: rt.provider.login.flow,
      ...(rt.code ? { authorizeUrl: authorizeUrl(rt.provider, { clientId: rt.config.clientId, redirectUri: rt.code.redirect, nonce: s.nonce, state: s.state!, codeChallenge: rt.code.pkce ? s.codeChallenge : undefined }) } : {}),
    };
  }

  // The provider redirects the login window here. The page shows only a static
  // message; the dApp's tab learns the outcome by polling the session.
  async function callback(providerId: string, url: URL, response: ServerResponse) {
    const known = [...apps.values()].find((a) => a.code && a.provider.id === providerId);
    if (!known) return sendClosePage(response, 404, "Sign-in", "Unknown sign-in provider. This window can close.");
    const label = known.provider.label;
    let s: Session | undefined;
    try {
      s = sessions.byState(url.searchParams.get("state"));
      const rt = appById(s.app);
      const codeVerifier = s.codeVerifier;
      s.state = undefined; s.codeVerifier = undefined;
      if (s.provider.id !== providerId || !rt.code) fail("bad_request");
      if (s.loginUsed) fail("login_consumed");
      if (url.searchParams.has("error")) { s.loginUsed = true; fail("token_invalid", "The sign-in was cancelled or denied"); }
      let token: string;
      try {
        token = await exchangeCode(rt.provider, {
          clientId: rt.config.clientId, clientSecret: rt.code!.clientSecret, code: url.searchParams.get("code"),
          codeVerifier: rt.code!.pkce ? codeVerifier : undefined, redirectUri: s.redirect!,
        });
      } catch { s.loginUsed = true; return fail("token_invalid", "The provider did not accept the sign-in code"); }
      await completeLogin(s, token);
    } catch (error) {
      const api = toApiError(error);
      if (s && !s.loggedIn) s.loginError = api.code;
      return sendClosePage(response, 400, `${label} sign-in`, `${label} sign-in failed. Return to the app and try again; this window can close.`);
    }
    return sendClosePage(response, 200, `${label} sign-in`, `${label} sign-in complete. Return to the app; this window can close.`);
  }

  async function prepare(body: Record<string, unknown>, origin: string | undefined) {
    const { s, rt } = sessionFor(body.sessionId, origin, { requireLogin: true });
    withSalt(s);
    if (body.version !== 1) fail("bad_request", "Unsupported action version");
    const operation = str(body.operation);
    if (!operation || !["0", "1", "2", "3"].includes(operation)) fail("bad_request", "Unknown operation");
    for (const field of ["recipient", "assetId", "amount"] as const) if (body[field] !== undefined && typeof body[field] !== "string") fail("bad_request", "Action fields are strings");
    if (!s.proof) fail("proof_pending", s.job && s.job.stage !== "failed" ? MESSAGES.proof_pending : "Request a proof first");
    quotas.check(rt.config, s, operation!, BigInt(rt.record.groupFeeMicroAlgos));
    const proof = s.proof!;
    let request: { operation: any; recipient?: string; assetId?: string; amount?: string };
    if (operation === "0") request = { operation };
    else if (operation === "2") {
      // An opt-in's recipient is the wallet itself.
      const wallet = await rt.wallets.discover(s.owner!);
      if (!wallet.enrolled) fail("not_enrolled");
      request = { operation, recipient: wallet.address!, assetId: str(body.assetId), amount: "0" };
    } else {
      if (!str(body.recipient) || !str(body.amount)) fail("bad_request", "A transfer needs a recipient and an amount");
      request = { operation, recipient: str(body.recipient), assetId: str(body.assetId) ?? (operation === "1" ? "0" : undefined), amount: str(body.amount) };
      if (operation === "3" && !request.assetId) fail("bad_request", "An asset transfer needs an assetId");
    }
    // Enrollment's recipient, asset and amount are fixed (the sponsor, 0, the deposit) and an
    // opt-in's recipient and amount are (the wallet, 0). A client may send them, as the SDK
    // does, but they must be those values: nothing it asked for is silently replaced.
    if (operation === "0") {
      if ((body.recipient !== undefined && body.recipient !== config.sponsor.addr) || (body.assetId !== undefined && body.assetId !== "0") || (body.amount !== undefined && body.amount !== rt.record.enrollmentDeposit))
        fail("bad_request", "Enrollment pays the enrollment deposit to the sponsor");
    }
    const plan = await onProof(rt, proof, () => rt.wallets.prepare({ proof, request, sponsor: config.sponsor.addr }));
    for (const field of ["recipient", "assetId", "amount"] as const)
      if (body[field] !== undefined && body[field] !== plan[field]) fail("bad_request", "The request's recipient, asset or amount differs from what the operation does");
    const expiresAt = Math.floor(Date.now() / 1000) + PLAN_SECONDS;
    plans.set(plan.planId, { plan, sessionId: s.id, app: rt.config.id, expiresAt, used: false });
    return { ...plan, expiresAt };
  }

  async function submit(planId: string, body: Record<string, unknown>, origin: string | undefined) {
    const { s, rt } = sessionFor(body.sessionId, origin, { requireLogin: true });
    const pending = plans.get(planId);
    if (!pending || pending.sessionId !== s.id) return fail("not_found", "Unknown action plan");
    if (pending.used) fail("replay", "The action plan was already submitted");
    // Single use, whatever the outcome below.
    pending.used = true;
    if (Math.floor(Date.now() / 1000) > pending.expiresAt) fail("plan_expired");
    if (!s.proof) fail("proof_pending");
    let signature: Uint8Array;
    try { signature = fromBase64Url(body.signature as string, 64); } catch { return fail("bad_request", "The signature must be 64 bytes in base64url"); }
    const sessionKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: s.sessionPublicKey.toString("base64url") }, format: "jwk" });
    if (!verify(null, await actionDigest(pending.plan), sessionKey, signature)) fail("unauthorized", "The signature does not match the plan and the session key");
    const hold = quotas.reserve(rt.config, s, pending.plan.operation, BigInt(rt.record.groupFeeMicroAlgos));
    try {
      const proof = s.proof!;
      const result = await onProof(rt, proof, () => rt.wallets.submit({ proof, plan: pending.plan, signature, sponsor: config.sponsor }));
      hold.commit(BigInt(result.groupFeeMicroAlgos));
      return {
        txId: result.txId, transactionIds: result.transactionIds, groupId: result.groupId, confirmedRound: result.confirmedRound,
        groupFeeMicroAlgos: result.groupFeeMicroAlgos, wallet: result.wallet,
      };
    } catch (error) { hold.release(); throw error; }
  }

  async function uploadProof(s: Session, rt: AppRuntime, body: Record<string, unknown>) {
    if (s.proof) fail("bad_request", "The session already has a proof");
    if (s.job && !["ready", "failed"].includes(s.job.stage)) fail("proof_pending", "A service proof is running for this session");
    const expected = expectedPublicSignals(circuitInput(s));
    const publicSignals = body.publicSignals;
    if (!body.proof || typeof body.proof !== "object" || !Array.isArray(publicSignals) || publicSignals.length !== 12 || !publicSignals.every((v) => typeof v === "string"))
      fail("bad_request", "Expected { proof, publicSignals }");
    if (JSON.stringify(publicSignals) !== JSON.stringify(expected)) fail("proof_failed", "The proof is not for this session");
    const proof = { proof: body.proof, publicSignals } as ProofResult;
    const started = Date.now();
    // checkProof verifies the Groth16 proof (snarkjs) and the key policy on chain.
    await onProof(rt, proof, () => rt.wallets.checkProof(proof));
    s.proof = proof;
    s.job = { id: randomUUID(), stage: "ready", startedAt: started, finishedAt: Date.now(), measurement: { prover: "browser" } };
    return jobView(s.job, s);
  }

  async function handle(route: Route, request: IncomingMessage, response: ServerResponse, url: URL, cors: Record<string, string>) {
    const origin = str(request.headers.origin);
    const ok = (status: number, value?: unknown) => sendJson(response, status, value, cors);
    const [a, b] = route.params.map((p) => { try { return decodeURIComponent(p); } catch { return fail("bad_request"); } }) as [string, string];
    switch (route.name) {
      case "health": return ok(200, await health());
      case "callback": return callback(a, url, response);
      case "config": { const rt = appById(a); checkOrigin(rt.config, origin); return ok(200, await appConfig(rt)); }
      case "wallet": {
        const rt = appById(a); checkOrigin(rt.config, origin);
        try { return ok(200, await rt.wallets.snapshotByAddress(b)); } catch (error) {
          if (error instanceof ChainError && error.code === "not_enrolled") fail("not_found", "No enrolled wallet at this address");
          if (error instanceof ChainError && error.code === "rejected") fail("bad_request", "Not an Algorand address");
          throw error;
        }
      }
      case "start": {
        const client = (config.trustProxy ? str(request.headers["x-forwarded-for"])?.split(",")[0]?.trim() : undefined) || request.socket.remoteAddress || "unknown";
        return ok(201, await startSession(await readJson(request), origin, client));
      }
      case "session": { const { s } = sessionFor(a, origin); return ok(200, sessionView(s, sessions.now())); }
      case "end": {
        const existing = sessions.entries.get(a);
        if (existing) { checkOrigin(appById(existing.app).config, origin); sessions.delete(a); }
        return ok(204);
      }
      case "token": {
        const { s } = sessionFor(a, origin);
        const body = await readJson(request);
        if (s.provider.login.flow !== "in-page") fail("bad_request", "This provider signs in through its login window");
        if (typeof body.idToken !== "string") fail("bad_request", "Expected { idToken }");
        await completeLogin(s, body.idToken);
        return ok(200, sessionView(s, sessions.now()));
      }
      case "salt": {
        const { s, rt } = sessionFor(a, origin, { requireLogin: true });
        const body = await readJson(request);
        sessions.bindSalt(s.id, body.salt);
        const wallet = await rt.wallets.discover(s.owner!);
        return ok(200, { commitment: s.owner!.toString("base64url"), wallet });
      }
      case "prove": {
        const { s, rt } = sessionFor(a, origin, { requireLogin: true });
        await readJson(request, { optional: true });
        withSalt(s);
        if (stopping) fail("service_unavailable");
        if (s.job && s.job.stage !== "failed") return ok(202, { jobId: s.job.id });
        const job: ProofJob = { id: randomUUID(), stage: "queued", startedAt: Date.now() };
        s.job = job;
        const task = runProof(s, rt, job).finally(() => running.delete(task));
        running.add(task);
        return ok(202, { jobId: job.id });
      }
      case "job": {
        const { s } = sessionFor(a, origin, { requireLogin: true });
        if (!s.job || s.job.id !== b) fail("not_found", "Unknown proof job");
        return ok(200, jobView(s.job!, s));
      }
      case "circuitInput": {
        const { s } = sessionFor(a, origin, { requireLogin: true });
        await readJson(request, { optional: true });
        return ok(200, circuitInput(s));
      }
      case "uploadProof": {
        const { s, rt } = sessionFor(a, origin, { requireLogin: true });
        return ok(200, await uploadProof(s, rt, await readJson(request)));
      }
      case "prepare": return ok(201, await prepare(await readJson(request), origin));
      case "submit": return ok(200, await submit(a, await readJson(request), origin));
      case "devFund": {
        const rt = appById(a); checkOrigin(rt.config, origin);
        const client = (config.trustProxy ? str(request.headers["x-forwarded-for"])?.split(",")[0]?.trim() : undefined) || request.socket.remoteAddress || "unknown";
        return ok(200, await devFund((await readJson(request) as { address?: unknown }).address, client));
      }
    }
    fail("not_found");
  }

  const server = createServer(async (request, response) => {
    const started = performance.now();
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://api.invalid");
    const origin = str(request.headers.origin);
    const found = match(method === "HEAD" ? "GET" : method, url.pathname);
    const name = typeof found === "object" ? found.name : found === "method" ? "method_not_allowed" : "not_found";
    let status = 500; let code: string | undefined;
    response.once("finish", () => {
      status = response.statusCode;
      log({ event: "request", method, route: TEMPLATES[name] ?? name, status, ms: Math.round(performance.now() - started), ...(code ? { code } : {}) });
    });
    const cors = corsHeaders(origins, origin, method === "OPTIONS");
    try {
      if (method === "OPTIONS") {
        // Preflight: the origin must be configured for some app; each request then checks its own app.
        if (!cors["Access-Control-Allow-Origin"] || !found) fail("origin_not_allowed");
        return sendJson(response, 204, undefined, cors);
      }
      if (!found) fail("not_found");
      if (found === "method") fail("bad_request", "Method not allowed for this path");
      await handle(found as Route, request, response, url, cors);
    } catch (error) {
      const api = toApiError(error);
      code = api.code;
      if (!(error instanceof ApiError) && !(error instanceof ChainError)) log({ event: "error", route: TEMPLATES[name] ?? name, kind: (error as Error)?.name ?? "unknown" });
      if (response.headersSent || response.destroyed) return;
      sendJson(response, api.status, errorBody(api), { ...cors, ...(api.retryAfter !== undefined ? { "Retry-After": api.retryAfter } : {}) });
    }
  });
  server.requestTimeout = 120_000;

  const sweep = setInterval(() => {
    sessions.clean(); quotas.prune(); sessionLimiter.prune();
    const now = Math.floor(Date.now() / 1000);
    for (const [id, p] of plans) if (p.expiresAt + PLAN_SECONDS < now) plans.delete(id);
  }, 30_000);
  sweep.unref();

  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(config.port, config.host, () => { server.off("error", reject); done(); }); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  log({ event: "listening", port, network: service.network, apps: [...apps.keys()] });

  return {
    server, port,
    async close() {
      stopping = true;
      clearInterval(sweep);
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await Promise.allSettled([...running]);
      sessions.close();
      plans.clear();
      await chain.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let config: ApiConfig;
  try { config = loadConfig(); } catch (error) {
    console.error(`api: ${error instanceof ConfigError ? error.message : "configuration failed"}`);
    process.exit(1);
  }
  try {
    const api = await startApi(config);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void api.close().then(() => process.exit(0)); });
  } catch (error) {
    console.error(`api: ${error instanceof ConfigError || error instanceof ChainError ? error.message : "startup failed"}`);
    process.exit(1);
  }
}
