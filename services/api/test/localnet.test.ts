// services/api on LocalNet, end to end through HTTP: the dev issuer (in process,
// port 9190), the prover service (spawned, port 9181) and the API (in process,
// port 9180) over one provider deployment and one app deployed here. Uses its own
// state directory; does not move LocalNet's clock and writes no benchmarks.
// Development identities only: the dev issuer signs for anyone.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AlgorandClient, microAlgos } from "../../../packages/chain/src/deps.ts";
import { openChain } from "../../../packages/chain/src/index.ts";
import { actionDigest } from "../../../packages/protocol/src/node.ts";
import { loadServiceEnv, writeApps, writeAppDeployment, writeProviderDeployment } from "../../../packages/config/src/index.ts";
import { secretKeyToMnemonic } from "../../../upstream/snarkjs-algorand/node_modules/algosdk/dist/esm/index.js";
import { startDevIssuer } from "../../dev-issuer/src/server.ts";
import { providerById } from "../../../packages/protocol/src/node.ts";
import { loadConfig, startApi } from "../src/server.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const API = "http://localhost:9180";
const ISSUER = "http://localhost:9190";
const PROVER_PORT = 9181;
const PROVER_TOKEN = `api-test-${randomBytes(16).toString("hex")}`;
const ORIGIN = "http://localhost:8775";
const APP = "api-test";
const AUDIENCE = `algozkauth-api-test-${randomBytes(4).toString("hex")}.apps.googleusercontent.com`;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

const localnet = AlgorandClient.defaultLocalNet();
const funded = async (algos: number) => {
  const dispenser = await localnet.account.localNetDispenser();
  const a = localnet.account.random();
  await localnet.send.payment({ sender: dispenser, receiver: a.addr, amount: microAlgos(algos * 1_000_000) });
  return { addr: a.addr.toString(), signer: a.signer, mnemonic: secretKeyToMnemonic(a.account.sk) };
};
// LocalNet makes blocks only for transactions; a fresh one keeps its clock current.
const tick = async () => {
  const dispenser = await localnet.account.localNetDispenser();
  await localnet.send.payment({ sender: dispenser, receiver: dispenser, amount: microAlgos(0), note: `api-test-clock-${randomUUID()}` });
};

// The dev issuer stamps tokens on the chain's clock, as a real provider's wall clock
// matches TestNet's; LocalNet in dev mode keeps its own block clock.
let issuerOffsetMs = 0;
const syncIssuerClock = async () => {
  const algod = localnet.client.algod;
  const { lastRound } = await algod.status().do();
  const timestamp = Number((await algod.block(lastRound).do()).block.header.timestamp);
  issuerOffsetMs = timestamp * 1000 - Date.now();
};

type Reply = { status: number; body: any; headers: Headers };
async function api(path: string, o: { method?: string; body?: unknown; origin?: string | null } = {}): Promise<Reply> {
  const origin = o.origin === undefined ? ORIGIN : o.origin;
  const response = await fetch(`${API}${path}`, {
    method: o.method ?? (o.body === undefined ? "GET" : "POST"),
    headers: { ...(origin ? { origin } : {}), ...(o.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
}
const expectError = (reply: Reply, status: number, code: string) => {
  assert.equal(reply.status, status, JSON.stringify(reply.body));
  assert.equal(reply.body.error.code, code);
  assert.equal(typeof reply.body.error.message, "string");
};

// The browser's side: a WebCrypto Ed25519 session key whose private half cannot leave it.
async function browserKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { publicKey: b64(publicKey), sign: async (plan: any) => b64(new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, await actionDigest(plan)))) };
}

// The code flow as a browser does it: open authorizeUrl, submit the sign-in form, follow the redirect.
async function codeLogin(authorizeUrl: string, subject: string) {
  const page = await fetch(authorizeUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  const form = new URLSearchParams();
  for (const [, name, value] of html.matchAll(/<input type="hidden" name="([a-z_]+)" value="([^"]*)">/g))
    form.set(name!, value!.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))));
  form.set("subject", subject);
  const posted = await fetch(`${ISSUER}/authorize`, { method: "POST", body: form, redirect: "manual" });
  assert.equal(posted.status, 302);
  const location = posted.headers.get("location")!;
  assert.ok(location.startsWith(`${API}/v1/oauth/google/callback?`));
  const callback = await fetch(location);
  return { status: callback.status, html: await callback.text(), csp: callback.headers.get("content-security-policy") };
}

async function signedInSession(subject: string) {
  const key = await browserKey();
  const started = await api("/v1/sessions", { body: { app: APP, sessionPublicKey: key.publicKey, randomness: b64(randomBytes(32)) } });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  await syncIssuerClock();
  const login = await codeLogin(started.body.authorizeUrl, subject);
  assert.equal(login.status, 200, login.html);
  return { key, sessionId: started.body.sessionId as string, started: started.body };
}

async function waitForProof(sessionId: string, jobId: string) {
  const deadline = Date.now() + 600_000;
  for (;;) {
    const job = await api(`/v1/sessions/${sessionId}/proofs/${jobId}`);
    assert.equal(job.status, 200);
    if (job.body.stage === "ready" || job.body.stage === "failed") return job.body;
    if (Date.now() > deadline) throw new Error("proof timed out");
    await new Promise((r) => setTimeout(r, 500));
  }
}

const logs: string[] = [];
let stateDir: string;
let proverDir: string;
let prover: ChildProcess | undefined;
let issuer: Awaited<ReturnType<typeof startDevIssuer>>;
let server: Awaited<ReturnType<typeof startApi>>;
let sponsor: Awaited<ReturnType<typeof funded>>;

before(async () => {
  stateDir = mkdtempSync(`${tmpdir()}/zkauth-api-test-`);
  proverDir = mkdtempSync(`${tmpdir()}/zkauth-api-prover-`);
  const env = {
    ZKAUTH_NETWORK: "localnet", ZKAUTH_STATE_DIR: stateDir, ZKAUTH_DEV_ISSUER_URL: ISSUER,
    API_PORT: "9180", ZKAUTH_API_PUBLIC_URL: API, ZKAUTH_PROVER_URL: `http://127.0.0.1:${PROVER_PORT}`, ZKAUTH_PROVER_TOKEN: PROVER_TOKEN,
    API_SESSION_RATE_LIMIT: "6",
  } as Record<string, string>;
  issuer = await startDevIssuer({ port: 9190, bind: "127.0.0.1", baseUrl: ISSUER, provider: providerById("google"), stateDir }, { now: () => Date.now() + issuerOffsetMs });

  prover = spawn(process.execPath, [`${root}services/prover/src/server.ts`], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PROVER_PORT: String(PROVER_PORT), PROVER_HOST: "127.0.0.1", PROVER_WORK_DIR: proverDir, ZKAUTH_PROVER_TOKEN: PROVER_TOKEN },
  });
  await new Promise<void>((resolve, reject) => {
    let buffer = "";
    prover!.stdout!.on("data", (chunk: Buffer) => { buffer += chunk; if (buffer.includes('"event":"listening"')) resolve(); });
    prover!.once("exit", (code) => reject(new Error(`prover exited with ${code}`)));
  });

  // One provider deployment and one app, recorded as the cli would.
  const service = loadServiceEnv(env);
  const [administrator, guardian] = [await funded(5), await funded(1)];
  sponsor = await funded(20);
  const chain = await openChain({ network: "localnet", root });
  try {
    const provider = await chain.deployProvider({ provider: "google", administrator, guardian: guardian.addr });
    const app = await chain.deployApp({ provider, app: APP, audience: AUDIENCE, funder: sponsor });
    await chain.keys(provider).ensureKeys({ jwks: issuer.jwks, administrator });
    writeProviderDeployment(service, provider);
    writeAppDeployment(service, app);
    // Enough daily sponsorship for exactly two groups: the enrollment and one transfer.
    writeApps(service, [{ id: APP, provider: "google", clientId: AUDIENCE, clientSecretEnv: null, redirectUri: null, allowedOrigins: [ORIGIN], shared: false,
      sponsor: { operations: ["0", "1", "2", "3"], maxActionsPerSession: 20, maxDailyFeeMicroAlgos: String(2n * BigInt(app.groupFeeMicroAlgos)) } }]);
  } finally { await chain.close(); }

  server = await startApi(loadConfig({ ...env, ZKAUTH_SPONSOR_MNEMONIC: sponsor.mnemonic }, (entry) => logs.push(JSON.stringify(entry))));
});

after(async () => {
  await server?.close();
  await issuer?.close();
  if (prover && prover.exitCode === null) { const exited = new Promise((r) => prover!.once("exit", r)); prover.kill("SIGTERM"); await exited; }
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(proverDir, { recursive: true, force: true });
  await (globalThis as any).curve_bn128?.terminate();
});

const secrets: string[] = [];

test("health and app config", async () => {
  const health = await api("/v1/health", { origin: null });
  assert.deepEqual(health.body, { ok: true, network: "localnet", prover: "ok", algod: "ok" });
  const config = await api(`/v1/apps/${APP}/config`);
  assert.equal(config.status, 200);
  assert.equal(config.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(config.body.app, APP);
  assert.equal(config.body.provider, "google");
  assert.deepEqual(config.body.providers, ["google"]);
  assert.equal(config.body.loginFlow, "code");
  assert.equal(config.body.clientId, AUDIENCE);
  assert.equal(config.body.network, "localnet");
  assert.equal(config.body.sponsor, sponsor.addr);
  assert.equal(config.body.approvedKeys.length, 1);
  for (const field of ["genesisHash", "registryId", "keyRegistryId", "verifier", "enrollmentDeposit", "groupFeeMicroAlgos"]) assert.equal(typeof config.body[field], "string", field);
  expectError(await api("/v1/apps/nope/config"), 404, "app_unknown");
  expectError(await api("/v1/nothing"), 404, "not_found");
});

test("code-flow login, salt, service proof, enrollment, transfer, single-use plans, origins and quotas", { timeout: 900_000 }, async () => {
  const { key, sessionId, started } = await signedInSession("alice");
  secrets.push(sessionId);
  assert.equal(started.loginFlow, "code");
  assert.match(started.nonce, /^[A-Za-z0-9_-]{43}$/);
  const authorize = new URL(started.authorizeUrl);
  assert.equal(authorize.origin, ISSUER);
  assert.equal(authorize.searchParams.get("nonce"), started.nonce);
  assert.equal(authorize.searchParams.get("redirect_uri"), `${API}/v1/oauth/google/callback`);

  const session = await api(`/v1/sessions/${sessionId}`);
  assert.equal(session.status, 200);
  assert.equal(session.body.loggedIn, true);
  assert.deepEqual(session.body.identity, { issuer: "https://accounts.google.com", audience: AUDIENCE, subject: "alice" });
  assert.equal(session.body.hasSalt, false);

  // Proofs and actions need the salt.
  expectError(await api(`/v1/sessions/${sessionId}/proofs`, { method: "POST" }), 409, "salt_required");
  const salt = b64(randomBytes(32));
  secrets.push(salt);
  const discovery = await api(`/v1/sessions/${sessionId}/salt`, { body: { salt } });
  assert.equal(discovery.status, 200);
  assert.match(discovery.body.commitment, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(discovery.body.wallet.enrolled, false);
  expectError(await api(`/v1/sessions/${sessionId}/salt`, { body: { salt: b64(randomBytes(32)) } }), 409, "salt_conflict");
  expectError(await api("/v1/actions", { body: { sessionId, version: 1, operation: "0" } }), 409, "proof_pending");

  await tick();
  const requested = await api(`/v1/sessions/${sessionId}/proofs`, { method: "POST" });
  assert.equal(requested.status, 202);
  const again = await api(`/v1/sessions/${sessionId}/proofs`, { method: "POST" });
  assert.equal(again.body.jobId, requested.body.jobId);
  const proofStarted = Date.now();
  const job = await waitForProof(sessionId, requested.body.jobId);
  assert.equal(job.stage, "ready", JSON.stringify(job));
  assert.equal(job.publicSignals.length, 12);
  assert.equal(job.proof.protocol, "groth16");
  console.log(`# service proof ${Date.now() - proofStarted} ms (${job.measurement.prover}, prove ${job.measurement.proveMs} ms)`);
  assert.equal((await api(`/v1/sessions/${sessionId}`)).body.proofReady, true);

  // Enrollment: the sponsor pays the deposit and the group fee.
  const enrollPlan = await api("/v1/actions", { body: { sessionId, version: 1, operation: "0" } });
  assert.equal(enrollPlan.status, 201, JSON.stringify(enrollPlan.body));
  assert.equal(enrollPlan.body.version, 1);
  assert.equal(enrollPlan.body.recipient, sponsor.addr);
  assert.equal(enrollPlan.body.owner, discovery.body.commitment);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(enrollPlan.body.expiresAt > now + 100 && enrollPlan.body.expiresAt <= now + 121);
  const forged = b64(randomBytes(64));
  // A bad signature uses up the plan too.
  expectError(await api(`/v1/actions/${enrollPlan.body.planId}/submit`, { body: { sessionId, signature: forged } }), 401, "unauthorized");
  expectError(await api(`/v1/actions/${enrollPlan.body.planId}/submit`, { body: { sessionId, signature: await key.sign(enrollPlan.body) } }), 409, "replay");
  // The SDK sends enrollment's fixed values; they must be exactly those.
  const sdkEnroll = { sessionId, version: 1, operation: "0", recipient: sponsor.addr, assetId: "0", amount: enrollPlan.body.amount };
  expectError(await api("/v1/actions", { body: { ...sdkEnroll, amount: "1" } }), 400, "bad_request");
  expectError(await api("/v1/actions", { body: { ...sdkEnroll, recipient: localnet.account.random().addr.toString() } }), 400, "bad_request");
  const plan = await api("/v1/actions", { body: sdkEnroll });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const enrolled = await api(`/v1/actions/${plan.body.planId}/submit`, { body: { sessionId, signature: await key.sign(plan.body) } });
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
  assert.equal(enrolled.body.wallet.enrolled, true);
  assert.ok(enrolled.body.transactionIds.includes(enrolled.body.txId));
  assert.equal(enrolled.body.groupFeeMicroAlgos, "20000");
  const address = enrolled.body.wallet.address as string;
  expectError(await api("/v1/actions", { body: { sessionId, version: 1, operation: "0" } }), 409, "wallet_exists");

  // The dApp or user funds the wallet; then an ALGO transfer.
  const dispenser = await localnet.account.localNetDispenser();
  await localnet.send.payment({ sender: dispenser, receiver: address, amount: microAlgos(1_000_000) });
  const wallet = await api(`/v1/apps/${APP}/wallets/${address}`);
  assert.equal(wallet.status, 200);
  assert.equal(wallet.body.balanceMicroAlgos, String(BigInt(enrolled.body.wallet.balanceMicroAlgos) + 1_000_000n));
  assert.equal(wallet.body.walletId, enrolled.body.wallet.walletId);
  const recipient = localnet.account.random().addr.toString();
  // An opt-in's recipient is the wallet: another one is refused rather than replaced.
  expectError(await api("/v1/actions", { body: { sessionId, version: 1, operation: "2", recipient, assetId: "1", amount: "0" } }), 400, "bad_request");
  const transfer = await api("/v1/actions", { body: { sessionId, version: 1, operation: "1", recipient, assetId: "0", amount: "200000" } });
  assert.equal(transfer.status, 201, JSON.stringify(transfer.body));
  assert.equal(transfer.body.assetId, "0");
  assert.equal(transfer.body.nonce, "0");
  const signature = await key.sign(transfer.body);
  const sent = await api(`/v1/actions/${transfer.body.planId}/submit`, { body: { sessionId, signature } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.wallet.nonce, "1");
  assert.equal(BigInt(sent.body.wallet.balanceMicroAlgos), BigInt(wallet.body.balanceMicroAlgos) - 200_000n);
  assert.equal((await localnet.client.algod.accountInformation(recipient).do()).amount, 200_000n);

  // A plan is single use.
  expectError(await api(`/v1/actions/${transfer.body.planId}/submit`, { body: { sessionId, signature } }), 409, "replay");
  expectError(await api(`/v1/actions/${randomUUID()}/submit`, { body: { sessionId, signature } }), 404, "not_found");

  // Another origin is refused, for preflights and requests alike; the callback is exempt.
  const evil = "http://evil.example";
  expectError(await api(`/v1/sessions/${sessionId}`, { origin: evil }), 403, "origin_not_allowed");
  expectError(await api(`/v1/sessions/${sessionId}`, { origin: null }), 403, "origin_not_allowed");
  expectError(await api("/v1/actions", { origin: evil, body: { sessionId, version: 1, operation: "1", recipient, amount: "1" } }), 403, "origin_not_allowed");
  expectError(await api(`/v1/apps/${APP}/config`, { origin: evil }), 403, "origin_not_allowed");
  // A backend (no Origin) may read the public config, to pin its sign-in settings.
  assert.equal((await api(`/v1/apps/${APP}/config`, { origin: null })).status, 200);
  const badPreflight = await fetch(`${API}/v1/actions`, { method: "OPTIONS", headers: { origin: evil, "access-control-request-method": "POST" } });
  assert.equal(badPreflight.status, 403);
  assert.equal(badPreflight.headers.get("access-control-allow-origin"), null);
  const preflight = await fetch(`${API}/v1/actions`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(preflight.headers.get("access-control-allow-headers")!, /content-type/);

  // The daily sponsorship (two groups) is spent.
  const over = await api("/v1/actions", { body: { sessionId, version: 1, operation: "1", recipient, amount: "1000" } });
  expectError(over, 429, "quota_exceeded");
  assert.ok(Number(over.headers.get("retry-after")) > 0);

  // Browser proving: the private input goes only to the session's own origin.
  expectError(await api(`/v1/sessions/${sessionId}/circuit-input`, { method: "POST", origin: evil }), 403, "origin_not_allowed");
  const input = await api(`/v1/sessions/${sessionId}/circuit-input`, { method: "POST" });
  assert.equal(input.status, 200);
  assert.equal(input.body.identity.length, 2);
  expectError(await api(`/v1/sessions/${sessionId}/proof`, { method: "PUT", body: { proof: {}, publicSignals: job.publicSignals } }), 400, "bad_request");

  // Ending the session erases it.
  assert.equal((await api(`/v1/sessions/${sessionId}`, { method: "DELETE" })).status, 204);
  expectError(await api(`/v1/sessions/${sessionId}`), 401, "session_expired");
});

test("browser proving: the service checks an uploaded proof against the session", { timeout: 600_000 }, async () => {
  const { sessionId } = await signedInSession("bob");
  secrets.push(sessionId);
  const salt = b64(randomBytes(32));
  secrets.push(salt);
  assert.equal((await api(`/v1/sessions/${sessionId}/salt`, { body: { salt } })).status, 200);
  const input = await api(`/v1/sessions/${sessionId}/circuit-input`, { method: "POST" });
  assert.equal(input.status, 200);
  // Stands in for the browser's snarkjs: the same circuit input, proven out of band.
  const proved = await fetch(`http://127.0.0.1:${PROVER_PORT}/v1/prove`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${PROVER_TOKEN}` },
    body: JSON.stringify({ provider: "google", input: input.body }),
  });
  assert.equal(proved.status, 200);
  const { proof, publicSignals } = await proved.json();
  await tick();
  const tampered = [...publicSignals]; tampered[11] = String(BigInt(tampered[11]) - 1n);
  expectError(await api(`/v1/sessions/${sessionId}/proof`, { method: "PUT", body: { proof, publicSignals: tampered } }), 422, "proof_failed");
  const bad = { ...proof, pi_a: [proof.pi_b[0][0], proof.pi_a[1], proof.pi_a[2]] };
  expectError(await api(`/v1/sessions/${sessionId}/proof`, { method: "PUT", body: { proof: bad, publicSignals } }), 422, "proof_failed");
  const uploaded = await api(`/v1/sessions/${sessionId}/proof`, { method: "PUT", body: { proof, publicSignals } });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.stage, "ready");
  assert.equal(uploaded.body.measurement.prover, "browser");
  assert.equal((await api(`/v1/sessions/${sessionId}`)).body.proofReady, true);
  // The app's daily sponsorship was spent by the previous test.
  expectError(await api("/v1/actions", { body: { sessionId, version: 1, operation: "0" } }), 429, "quota_exceeded");
});

test("logins are single use; session creation is rate limited per client", async () => {
  const key = await browserKey();
  const started = await api("/v1/sessions", { body: { app: APP, sessionPublicKey: key.publicKey, randomness: b64(randomBytes(32)) } });
  assert.equal(started.status, 201);
  expectError(await api("/v1/sessions", { body: { app: APP, provider: "slack", sessionPublicKey: key.publicKey, randomness: b64(randomBytes(32)) } }), 400, "provider_unsupported");
  expectError(await api("/v1/sessions", { body: { app: APP, sessionPublicKey: "x", randomness: b64(randomBytes(32)) } }), 400, "bad_request");
  expectError(await api("/v1/sessions", { body: { app: "nope", sessionPublicKey: key.publicKey, randomness: b64(randomBytes(32)) } }), 404, "app_unknown");
  // The code flow returns tokens to the service, never through the page.
  expectError(await api(`/v1/sessions/${started.body.sessionId}/token`, { body: { idToken: "a.b.c" } }), 400, "bad_request");
  // A cancelled sign-in: the window shows a static page, the session records the failure.
  const state = new URL(started.body.authorizeUrl).searchParams.get("state")!;
  const cancelled = await fetch(`${API}/v1/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`);
  assert.equal(cancelled.status, 400);
  assert.doesNotMatch(await cancelled.text(), /access_denied/);
  const session = await api(`/v1/sessions/${started.body.sessionId}`);
  assert.equal(session.body.loggedIn, false);
  assert.equal(session.body.loginError, "token_invalid");
  // Attempts counted in this file: alice, bob, this one and the bad key; the limit is 6 per window.
  for (let i = 0; i < 2; i++) assert.equal((await api("/v1/sessions", { body: { app: APP, sessionPublicKey: key.publicKey, randomness: b64(randomBytes(32)) } })).status, 201);
  const limited = await api("/v1/sessions", { body: { app: APP, sessionPublicKey: key.publicKey, randomness: b64(randomBytes(32)) } });
  expectError(limited, 429, "rate_limited");
  assert.ok(Number(limited.body.error.retryAfter) > 0);
});

test("logs carry no session ids, salts or tokens", () => {
  assert.ok(logs.some((line) => line.includes('"route":"/v1/sessions/:id/proofs/:job"')));
  for (const line of logs) {
    for (const secret of secrets) assert.ok(!line.includes(secret), "a secret value was logged");
    assert.doesNotMatch(line, /eyJ[A-Za-z0-9_-]{10,}\./);
  }
});
