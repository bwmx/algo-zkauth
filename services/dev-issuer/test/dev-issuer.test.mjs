// Run from services/dev-issuer (npm test) or the repository root:
//   node --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs --test services/dev-issuer/test/*.test.mjs
// Port 8890 is the dev issuer's 8790 with the +100 test offset. No LocalNet.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "../../../src/phase3/oidc-providers.mjs";
import { verifyIdToken } from "../../../src/phase3/id-token.mjs";
import { oidcCircuitInput } from "../../../src/phase3/circuit-input.mjs";
import { sessionNonce } from "../../../src/phase3/session-nonce.mjs";
import { exchangeCode } from "../../../src/phase6/code-login.mjs";
import { loadConfig, startDevIssuer, KID } from "../src/server.ts";
import { withDevIssuer } from "../src/override.ts";

const PORT = 8890;
const URL_BASE = `http://127.0.0.1:${PORT}`;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const stateDir = mkdtempSync(join(tmpdir(), "dev-issuer-test-"));
test.after(() => rmSync(stateDir, { recursive: true, force: true }));

const env = (extra = {}) => ({ ZKAUTH_NETWORK: "localnet", DEV_ISSUER_PORT: String(PORT), DEV_ISSUER_URL: URL_BASE, ZKAUTH_STATE_DIR: stateDir, ...extra });

async function withIssuer(extra, fn, options = {}) {
  const issuer = await startDevIssuer(loadConfig(env(extra)), options);
  try { return await fn(issuer); } finally { await issuer.close(); }
}

const audience = "dev-client.apps.googleusercontent.com";
const redirect = "http://localhost:8765/demo/google/callback";

// A session context and the nonce it binds, as the browser would build it.
function session(expiresIn = 590) {
  const context = { genesisHash: randomBytes(32), sessionPublicKey: randomBytes(32), randomness: randomBytes(32), salt: randomBytes(32), expiresAt: Math.floor(Date.now() / 1000) + expiresIn };
  return { ...context, nonce: sessionNonce(context) };
}

// The browser step: open /authorize, submit the sign-in form, read the code from the redirect.
async function signIn(base, { clientId = audience, redirectUri = redirect, nonce, state = "state-1", subject = "alice", extra = {} }) {
  const query = new URLSearchParams({ response_type: "code", scope: "openid", client_id: clientId, redirect_uri: redirectUri, state, nonce });
  const page = await fetch(`${base}/authorize?${query}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /alice/);
  const response = await fetch(`${base}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, nonce, state, subject, ...extra }),
  });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  return { location, code: location.searchParams.get("code"), state: location.searchParams.get("state") };
}

const exchange = (provider, code, over = {}) => exchangeCode(provider, { clientId: audience, clientSecret: "unused-dev-secret", code, redirectUri: redirect, ...over });
const payload = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());

async function witnessFor(provider, input) {
  const dir = `${root}${provider.circuit.directory}/${provider.circuit.name}_js`;
  const { default: witnessBuilder } = await import(`${dir}/witness_calculator.js`);
  const calculator = await witnessBuilder(readFileSync(`${dir}/${provider.circuit.name}.wasm`));
  return calculator.calculateWitness(input, true);
}

test("refuses to start unless ZKAUTH_NETWORK=localnet", () => {
  for (const network of [undefined, "", "testnet", "mainnet"]) {
    assert.throws(() => loadConfig({ ...env(), ZKAUTH_NETWORK: network }), /LocalNet/);
  }
  const run = spawnSync(process.execPath, ["--import", join(root, "upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs"), join(root, "services/dev-issuer/src/server.ts")], { env: { ...process.env, ...env(), ZKAUTH_NETWORK: "testnet" }, encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /LocalNet/);
  assert.equal(run.stdout, "");
});

test("defaults: port 8790, google, state dir under .local/service", () => {
  const config = loadConfig({ ZKAUTH_NETWORK: "localnet" });
  assert.equal(config.port, 8790);
  assert.equal(config.baseUrl, "http://localhost:8790");
  assert.equal(config.provider.id, "google");
  assert.equal(config.stateDir, join(root, ".local/service"));
  assert.throws(() => loadConfig({ ZKAUTH_NETWORK: "localnet", DEV_ISSUER_PROVIDER: "nobody" }), /Unsupported login provider/);
});

test("discovery, JWKS and health; the key persists with mode 0600 across restarts", async () => {
  const first = await withIssuer({}, async (issuer) => {
    const discovery = await (await fetch(`${URL_BASE}/.well-known/openid-configuration`)).json();
    assert.equal(discovery.issuer, PROVIDERS.google.issuer);
    assert.equal(discovery.authorization_endpoint, `${URL_BASE}/authorize`);
    assert.equal(discovery.token_endpoint, `${URL_BASE}/token`);
    assert.equal(discovery.jwks_uri, `${URL_BASE}/jwks`);
    const jwks = await (await fetch(`${URL_BASE}/jwks`)).json();
    assert.equal(jwks.keys.length, 1);
    assert.deepEqual([jwks.keys[0].kid, jwks.keys[0].kty, jwks.keys[0].alg, jwks.keys[0].use, jwks.keys[0].e], [KID, "RSA", "RS256", "sig", "AQAB"]);
    assert.equal(Buffer.from(jwks.keys[0].n, "base64url").length, 256);
    assert.equal(jwks.keys[0].d, undefined);
    assert.deepEqual(await (await fetch(`${URL_BASE}/v1/health`)).json(), { ok: true, provider: "google", issuer: PROVIDERS.google.issuer, kid: "dev-1" });
    assert.equal((await fetch(`${URL_BASE}/nope`)).status, 404);
    assert.equal((await fetch(`${URL_BASE}/token`)).status, 405);
    return jwks;
  });
  const file = join(stateDir, "dev-issuer", "signing-key.pem");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(readFileSync(file, "utf8"), /^-----BEGIN PRIVATE KEY-----/);
  await withIssuer({}, async () => assert.deepEqual(await (await fetch(`${URL_BASE}/jwks`)).json(), first));
});

test("authorize, code, token with the real exchangeCode; the token verifies, builds circuit input and a Google witness", async () => {
  await withIssuer({}, async () => {
    const provider = withDevIssuer(PROVIDERS.google, URL_BASE);
    assert.equal(provider.issuer, PROVIDERS.google.issuer);
    assert.deepEqual({ ...provider.login }, { flow: "code", authorizeUrl: `${URL_BASE}/authorize`, tokenUrl: `${URL_BASE}/token`, pkce: "never" });
    assert.equal(provider.jwksUrl, `${URL_BASE}/jwks`);
    assert.equal(PROVIDERS.google.login.flow, "in-page", "the base provider is not modified");

    const ctx = session();
    const { location, code, state } = await signIn(URL_BASE, { nonce: ctx.nonce, state: "login-state", subject: "bob" });
    assert.equal(location.origin + location.pathname, redirect);
    assert.equal(state, "login-state");
    const idToken = await exchange(provider, code);

    const jwks = await (await fetch(provider.jwksUrl)).json();
    const verified = verifyIdToken(idToken, { provider: PROVIDERS.google, audience, nonce: ctx.nonce, jwks });
    assert.equal(verified.subject, "bob");
    assert.equal(verified.keyId, "dev-1");
    assert.equal(verified.issuer, "https://accounts.google.com");
    assert.deepEqual(Object.keys(payload(idToken)).sort(), ["aud", "exp", "iat", "iss", "nonce", "sub"]);
    assert.throws(() => verifyIdToken(idToken, { provider: PROVIDERS.google, audience: "other", nonce: ctx.nonce, jwks }), /audience/);

    const input = oidcCircuitInput({ provider: PROVIDERS.google, token: idToken, jwks, audience, nonce: ctx.nonce, genesisHash: ctx.genesisHash, sessionPublicKey: ctx.sessionPublicKey, expiresAt: ctx.expiresAt, randomness: ctx.randomness, salt: ctx.salt, nowSeconds: Math.floor(Date.now() / 1000) });
    const witness = await witnessFor(PROVIDERS.google, input);
    const expected = [...input.identity, ...input.keyHash, ...input.audienceHash, ...input.sessionKey, ...input.genesisHash, input.sessionExpiresAt, input.notBefore].map(BigInt);
    assert.deepEqual(witness.slice(1, 13), expected);
  });
});

test("a code is single use, bound to client and redirect, and expires after 60 seconds", async () => {
  let clock = Date.now();
  await withIssuer({}, async () => {
    const provider = withDevIssuer(PROVIDERS.google, URL_BASE);
    const ctx = session();
    const used = (await signIn(URL_BASE, { nonce: ctx.nonce })).code;
    assert.equal(payload(await exchange(provider, used)).nonce, ctx.nonce);
    await assert.rejects(exchange(provider, used), /HTTP 400/);

    // A failed attempt consumes the code too.
    const wrongClient = (await signIn(URL_BASE, { nonce: ctx.nonce })).code;
    await assert.rejects(exchange(provider, wrongClient, { clientId: "someone-else" }), /HTTP 400/);
    await assert.rejects(exchange(provider, wrongClient), /HTTP 400/);
    const wrongRedirect = (await signIn(URL_BASE, { nonce: ctx.nonce })).code;
    await assert.rejects(exchange(provider, wrongRedirect, { redirectUri: "http://localhost:9/other" }), /HTTP 400/);

    const fresh = (await signIn(URL_BASE, { nonce: ctx.nonce })).code;
    clock += 59_000;
    assert.equal(payload(await exchange(provider, fresh)).aud, audience);
    const stale = (await signIn(URL_BASE, { nonce: ctx.nonce })).code;
    clock += 61_000;
    await assert.rejects(exchange(provider, stale), /HTTP 400/);
    assert.equal((await fetch(`${URL_BASE}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: "nonsense" }) })).status, 400);
  }, { now: () => clock });
});

test("authorize rejects non-http(s) redirects and missing nonce, and a PKCE challenge is enforced when sent", async () => {
  await withIssuer({}, async () => {
    const ask = (over) => fetch(`${URL_BASE}/authorize?${new URLSearchParams({ client_id: audience, redirect_uri: redirect, state: "s", nonce: "n1", ...over })}`, { headers: { Accept: "application/json" } });
    assert.equal((await ask({})).status, 200);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://localhost/x", "not a url", "http://localhost/cb#frag", ""]) {
      assert.equal((await ask({ redirect_uri: bad })).status, 400, bad);
    }
    assert.equal((await ask({ nonce: "" })).status, 400);
    assert.equal((await ask({ nonce: 'a"b' })).status, 400);
    assert.equal((await ask({ client_id: "a b" })).status, 400);
    assert.equal((await ask({ response_type: "token" })).status, 400);
    // The page escapes what it echoes.
    const page = await (await fetch(`${URL_BASE}/authorize?${new URLSearchParams({ client_id: audience, redirect_uri: "http://localhost/cb?x=\"><b>", nonce: "n1", state: '"><script>' })}`)).text();
    assert.equal(page.includes("<script>"), false);
    assert.equal(page.includes("<b>"), false);
    // The redirect keeps the redirect URI's own query and echoes state.
    const kept = await signIn(URL_BASE, { nonce: "n1", redirectUri: "http://localhost:8765/cb?app=1", state: "a b&c" });
    assert.equal(kept.location.searchParams.get("app"), "1");
    assert.equal(kept.state, "a b&c");
    // PKCE is optional (pkce "never") but checked if the client sent a challenge.
    const verifier = randomBytes(32).toString("base64url");
    const challenge = (await import("node:crypto")).createHash("sha256").update(verifier).digest("base64url");
    const provider = withDevIssuer(PROVIDERS.google, URL_BASE);
    const withChallenge = (await signIn(URL_BASE, { nonce: "n1", extra: { code_challenge: challenge, code_challenge_method: "S256" } })).code;
    await assert.rejects(exchange(provider, withChallenge), /HTTP 400/);
    const again = (await signIn(URL_BASE, { nonce: "n1", extra: { code_challenge: challenge, code_challenge_method: "S256" } })).code;
    assert.ok(await exchange(provider, again, { codeVerifier: verifier }));
  });
});

test("POST /token accepts JSON and form bodies and answers in the shape code-login parses", async () => {
  await withIssuer({}, async () => {
    for (const encode of [(o) => ({ type: "application/json", body: JSON.stringify(o) }), (o) => ({ type: "application/x-www-form-urlencoded", body: new URLSearchParams(o).toString() })]) {
      const { code } = await signIn(URL_BASE, { nonce: "n-shape" });
      const { type, body } = encode({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: audience });
      const response = await fetch(`${URL_BASE}/token`, { method: "POST", headers: { "Content-Type": type }, body });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control"), /no-store/);
      const reply = await response.json();
      assert.equal(typeof reply.id_token, "string");
      assert.notEqual(reply.ok, false);
      assert.equal(reply.access_token, undefined);
    }
    const failure = await fetch(`${URL_BASE}/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    assert.equal(failure.status, 400);
    assert.deepEqual(await failure.json(), { error: "invalid_request" });
  });
});

test("POST /test/token issues a token for headless tests and validates its input", async () => {
  await withIssuer({}, async () => {
    const ctx = session();
    const post = (body) => fetch(`${URL_BASE}/test/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const response = await post({ audience, nonce: ctx.nonce, subject: "alice" });
    assert.equal(response.status, 200);
    const { id_token: idToken } = await response.json();
    const jwks = await (await fetch(`${URL_BASE}/jwks`)).json();
    assert.equal(verifyIdToken(idToken, { provider: PROVIDERS.google, audience, nonce: ctx.nonce, jwks }).subject, "alice");
    for (const bad of [{ nonce: "n", subject: "a" }, { audience, subject: "a" }, { audience, nonce: "n" }, { audience, nonce: "n", subject: "a/b" }, { audience, nonce: "n", subject: "x".repeat(65) }]) {
      assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    }
  });
});

test("Slack: the token has Slack's issuer and team scope, verifies, builds circuit input and a witness", async () => {
  await withIssuer({ DEV_ISSUER_PROVIDER: "slack" }, async (issuer) => {
    const slackAudience = "1234567890.9876543210";
    const provider = withDevIssuer(PROVIDERS.slack, URL_BASE);
    assert.equal(provider.subjectScope, PROVIDERS.slack.subjectScope);
    const discovery = await (await fetch(`${URL_BASE}/.well-known/openid-configuration`)).json();
    assert.equal(discovery.issuer, "https://slack.com");

    // The sign-in page asks for the team; an invalid one is refused.
    const ctx = session();
    const query = new URLSearchParams({ client_id: slackAudience, redirect_uri: redirect, state: "s", nonce: ctx.nonce });
    assert.match(await (await fetch(`${URL_BASE}/authorize?${query}`)).text(), /team_id/);
    const form = (scope) => fetch(`${URL_BASE}/authorize`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: slackAudience, redirect_uri: redirect, nonce: ctx.nonce, state: "s", subject: "alice", subject_scope: scope }) });
    assert.equal((await form("T/1")).status, 400);
    assert.equal((await form("T 1")).status, 400);
    const { code } = await signIn(URL_BASE, { clientId: slackAudience, nonce: ctx.nonce, subject: "U0ALICE", extra: { subject_scope: "T0TEAM1" } });
    const idToken = await exchange(provider, code, { clientId: slackAudience });

    const claims = payload(idToken);
    assert.equal(claims.iss, "https://slack.com");
    assert.equal(claims["https://slack.com/team_id"], "T0TEAM1");
    assert.equal(claims.exp - claims.iat, 300);
    const jwks = await (await fetch(provider.jwksUrl)).json();
    const verified = verifyIdToken(idToken, { provider: PROVIDERS.slack, audience: slackAudience, nonce: ctx.nonce, jwks });
    assert.equal(verified.subject, "T0TEAM1/U0ALICE");
    const input = oidcCircuitInput({ provider: PROVIDERS.slack, token: idToken, jwks, audience: slackAudience, nonce: ctx.nonce, genesisHash: ctx.genesisHash, sessionPublicKey: ctx.sessionPublicKey, expiresAt: ctx.expiresAt, randomness: ctx.randomness, salt: ctx.salt, nowSeconds: Math.floor(Date.now() / 1000) });
    const witness = await witnessFor(PROVIDERS.slack, input);
    assert.deepEqual(witness.slice(1, 3), input.identity.map(BigInt));
    assert.equal(issuer.provider.id, "slack");
  });
});
