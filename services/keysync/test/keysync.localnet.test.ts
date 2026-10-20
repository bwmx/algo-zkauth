// keysync against LocalNet (localhost:4001/4002), in process. Needs the google
// proving artifacts (the setup deploys a provider through zkauth) and the pinned
// upstream checkout. Ports: 9282 (keysync health), 9290 (dev issuer); the webhook
// receiver takes an ephemeral loopback port. Never resets LocalNet or moves its clock.
//
//   npm test -w @algozkauth/keysync
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openChain } from "../../../packages/chain/src/index.ts";
import { signerFromMnemonic } from "../../../packages/config/src/index.ts";
import { loadConfig, startDevIssuer, type DevIssuer } from "../../dev-issuer/src/server.ts";
import { startKeysync, loadKeysyncConfig, type Keysync } from "../src/main.ts";
import { fingerprintOf } from "../src/sync.ts";
import { parseEnvFile } from "../../../tools/cli/src/lib.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const ISSUER_URL = "http://localhost:9290";
const HEALTH_PORT = 9282;
const stateDir = mkdtempSync(join(tmpdir(), "keysync-test-"));
let issuer: DevIssuer;
let webhook: Server;
let webhookUrl = "";
const posts: any[] = [];
const logs: Record<string, any>[] = [];
let secrets: Record<string, string>;
let keysync: Keysync | undefined;

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("ZKAUTH_") && !k.startsWith("KEYSYNC_") && k !== "TESTNET_MNEMONIC")) as Record<string, string>;
const zkauth = async (...args: string[]) =>
  promisify(execFile)(join(root, "tools/cli/zkauth"), args, { cwd: root, env: { ...cleanEnv(), ZKAUTH_NETWORK: "localnet", ZKAUTH_STATE_DIR: stateDir, ZKAUTH_DEV_ISSUER_URL: ISSUER_URL } });
const record = () => JSON.parse(readFileSync(join(stateDir, "deployments/localnet/providers/google.json"), "utf8"));
const health = async () => (await fetch(`http://127.0.0.1:${HEALTH_PORT}/v1/health`)).json() as Promise<any>;

before(async () => {
  issuer = await startDevIssuer(loadConfig({ ZKAUTH_NETWORK: "localnet", DEV_ISSUER_PORT: "9290", DEV_ISSUER_URL: ISSUER_URL, ZKAUTH_STATE_DIR: stateDir }));
  webhook = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { posts.push({ method: request.method, type: request.headers["content-type"], body: JSON.parse(body) }); response.writeHead(204).end(); });
  });
  await new Promise<void>((done) => webhook.listen(0, "127.0.0.1", done));
  webhookUrl = `http://127.0.0.1:${(webhook.address() as { port: number }).port}/hook?secret=do-not-log`;
  await zkauth("init");
  await zkauth("deploy", "provider", "google");
  secrets = parseEnvFile(readFileSync(join(stateDir, "secrets.env"), "utf8"));
});
after(async () => {
  await keysync?.close();
  await issuer?.close();
  await new Promise<void>((done) => { webhook?.close(() => done()); webhook?.closeAllConnections(); });
  rmSync(stateDir, { recursive: true, force: true });
});

const serviceEnv = (extra: Record<string, string> = {}) => ({
  ...cleanEnv(), ZKAUTH_NETWORK: "localnet", ZKAUTH_STATE_DIR: stateDir, ZKAUTH_DEV_ISSUER_URL: ISSUER_URL,
  ZKAUTH_ADMIN_MNEMONIC: secrets.ZKAUTH_ADMIN_MNEMONIC!, KEYSYNC_PORT: String(HEALTH_PORT),
  KEYSYNC_ALERT_WEBHOOK: webhookUrl, KEYSYNC_INTERVAL_SECONDS: "3600", ...extra,
});

test("configuration is validated, and the administrator key is required", async () => {
  assert.deepEqual(loadKeysyncConfig({}), { port: 8782, bind: "127.0.0.1", intervalSeconds: 900, repeatSeconds: 21600 });
  assert.throws(() => loadKeysyncConfig({ KEYSYNC_INTERVAL_SECONDS: "0" }), /KEYSYNC_INTERVAL_SECONDS/);
  assert.throws(() => loadKeysyncConfig({ KEYSYNC_ALERT_WEBHOOK: "ftp://secret@host/" }), (e: Error) => /http or https/.test(e.message) && !/secret/.test(e.message));
  await assert.rejects(startKeysync({ env: { ...serviceEnv(), ZKAUTH_ADMIN_MNEMONIC: "", KEYSYNC_PORT: "0" }, log: () => {} }), /ZKAUTH_ADMIN_MNEMONIC/);
});

test("the first cycle registers and seals the dev key; health reports it", async () => {
  keysync = await startKeysync({ env: serviceEnv(), log: (line) => logs.push(line) });
  await keysync.ready;
  const body = await health();
  assert.equal(body.ok, true);
  assert.equal(body.network, "localnet");
  const run = body.providers.google.lastRun;
  assert.deepEqual(run.registered, [fingerprintOf(issuer.jwks.keys[0]!.n as string)]);
  assert.equal(run.sealed, true);
  assert.deepEqual([run.renewed, run.alerts, run.error], [[], [], null]);
  assert.ok(Date.now() - Date.parse(run.at) < 60_000);
  const sync = logs.find((l) => l.event === "sync")!;
  assert.deepEqual([sync.provider, sync.registered, sync.sealed, sync.alerts, sync.error], ["google", 1, true, 0, null]);
  assert.equal(posts.length, 0);
});

test("a second cycle changes nothing", async () => {
  const [run] = await keysync!.runOnce();
  assert.deepEqual([run!.registered, run!.renewed, run!.sealed, run!.alerts, run!.error], [[], [], false, [], null]);
});

test("a key the provider does not publish alerts once on the webhook, and clears when revoked", async () => {
  const stray = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" });
  const fingerprint = fingerprintOf(stray.n as string);
  const chain = await openChain({ network: "localnet", root });
  try {
    // After sealing, the administrator's approval is pending under the 24-hour delay.
    await chain.keys(record()).ensureKeys({ jwks: { keys: [{ ...stray, kid: "stray", alg: "RS256", use: "sig" }] }, administrator: signerFromMnemonic(secrets.ZKAUTH_ADMIN_MNEMONIC!) });

    const [run] = await keysync!.runOnce();
    assert.equal(run!.error, null);
    assert.deepEqual(run!.alerts.map((a) => [a.fingerprint, a.state, a.inJwks]), [[fingerprint, "pending", false]]);
    const line = logs.filter((l) => l.event === "guardian_alert").at(-1)!;
    assert.equal(line.level, "alert");
    assert.equal(line.alerts[0].fingerprint, fingerprint);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].method, "POST");
    assert.equal(posts[0].type, "application/json");
    assert.deepEqual([posts[0].body.event, posts[0].body.provider, posts[0].body.keyRegistryId, posts[0].body.alerts[0].fingerprint], ["guardian_alert", "google", record().keyRegistryId, fingerprint]);
    assert.equal((await health()).providers.google.lastRun.alerts.length, 1);

    // The same standing alert is logged again but not re-sent within the repeat window.
    await keysync!.runOnce();
    assert.equal(posts.length, 1);

    await chain.keys(record()).revoke({ fingerprint, signer: signerFromMnemonic(secrets.ZKAUTH_GUARDIAN_MNEMONIC!) });
    const [cleared] = await keysync!.runOnce();
    assert.deepEqual(cleared!.alerts, []);
    assert.ok(logs.some((l) => l.event === "guardian_alert_cleared"));
    assert.equal((await health()).providers.google.lastRun.alerts.length, 0);
  } finally { await chain.close(); }
});

test("nothing logged carries a mnemonic or the webhook URL", () => {
  const text = JSON.stringify(logs);
  for (const name of ["ZKAUTH_ADMIN_MNEMONIC", "ZKAUTH_SPONSOR_MNEMONIC", "ZKAUTH_GUARDIAN_MNEMONIC"]) assert.ok(!text.includes(secrets[name]!), name);
  assert.ok(!text.includes("do-not-log"));
});

test("an unreachable JWKS is reported as a code, not an exception", async () => {
  const other = await startKeysync({ env: serviceEnv({ KEYSYNC_PORT: "0", ZKAUTH_DEV_ISSUER_URL: "http://127.0.0.1:1", KEYSYNC_ALERT_WEBHOOK: "" }), log: () => {} });
  try {
    await other.ready;
    const body = other.health() as any;
    assert.equal(body.ok, false);
    assert.equal(body.providers.google.lastRun.error, "jwks_unavailable");
    const response = await fetch(`${other.url}/v1/health`);
    assert.equal(response.status, 200);
    assert.equal((await fetch(`${other.url}/nope`)).status, 404);
  } finally { await other.close(); }
});
