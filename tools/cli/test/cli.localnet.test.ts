// zkauth against LocalNet (localhost:4001/4002). Needs the proving artifacts for
// google (fixtures/phase3, see zkauth artifacts fetch) and the pinned upstream
// checkout (scripts/setup.sh). Port 9290 is the in-process dev issuer.
// It deploys its own apps, never resets LocalNet and never moves its block clock.
//
//   npm test -w @algozkauth/cli
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openChain } from "../../../packages/chain/src/index.ts";
import { fingerprintOf } from "../../../services/keysync/src/sync.ts";
import { signerFromMnemonic } from "../../../packages/config/src/index.ts";
import { startDevIssuer, loadConfig, type DevIssuer } from "../../../services/dev-issuer/src/server.ts";
import { parseEnvFile } from "../src/lib.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const zkauth = join(root, "tools/cli/zkauth");
const ISSUER_URL = "http://localhost:9290";
const stateDir = mkdtempSync(join(tmpdir(), "zkauth-cli-test-"));
const upDir = mkdtempSync(join(tmpdir(), "zkauth-cli-up-"));
const testnetDir = mkdtempSync(join(tmpdir(), "zkauth-cli-testnet-"));
let issuer: DevIssuer;

before(async () => {
  issuer = await startDevIssuer(loadConfig({ ZKAUTH_NETWORK: "localnet", DEV_ISSUER_PORT: "9290", DEV_ISSUER_URL: ISSUER_URL, ZKAUTH_STATE_DIR: stateDir }));
});
after(async () => {
  await issuer?.close();
  for (const dir of [stateDir, upDir, testnetDir]) rmSync(dir, { recursive: true, force: true });
});

function baseEnv(dir: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !name.startsWith("ZKAUTH_") && name !== "TESTNET_MNEMONIC" && !name.startsWith("KEY_GUARDIAN")) env[name] = value;
  return { ...env, ZKAUTH_NETWORK: "localnet", ZKAUTH_STATE_DIR: dir, ZKAUTH_DEV_ISSUER_URL: ISSUER_URL, ...extra };
}
type Result = { code: number; stdout: string; stderr: string };
const run = (args: string[], dir = stateDir, extra: Record<string, string> = {}) =>
  new Promise<Result>((resolve) => {
    execFile(zkauth, args, { cwd: root, env: baseEnv(dir, extra), maxBuffer: 8 << 20 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }));
  });
const ok = async (args: string[], dir = stateDir, extra: Record<string, string> = {}) => {
  const result = await run(args, dir, extra);
  assert.equal(result.code, 0, `${args.join(" ")} failed: ${result.stdout}${result.stderr}`);
  return result;
};
const secrets = (dir = stateDir) => parseEnvFile(readFileSync(join(dir, "secrets.env"), "utf8"));
const noMnemonics = (dir: string, result: Result) => {
  for (const name of ["ZKAUTH_ADMIN_MNEMONIC", "ZKAUTH_SPONSOR_MNEMONIC", "ZKAUTH_GUARDIAN_MNEMONIC"])
    assert.ok(!(result.stdout + result.stderr).includes(secrets(dir)[name]!), `${name} was printed`);
};

test("help", async () => {
  const top = await ok(["--help"]);
  assert.match(top.stdout, /guardian status/);
  assert.match((await ok(["deploy", "--help"])).stdout, /deploy provider/);
  const unknown = await run(["nonsense"]);
  assert.equal(unknown.code, 2);
});

test("init (localnet) creates and funds accounts, and is idempotent", async () => {
  const first = await ok(["init"]);
  const file = join(stateDir, "secrets.env");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const values = secrets();
  for (const name of ["ZKAUTH_ADMIN_MNEMONIC", "ZKAUTH_SPONSOR_MNEMONIC", "ZKAUTH_GUARDIAN_MNEMONIC", "ZKAUTH_GUARDIAN_ADDRESS", "ZKAUTH_PROVER_TOKEN"]) assert.ok(values[name], name);
  assert.equal(signerFromMnemonic(values.ZKAUTH_GUARDIAN_MNEMONIC!).addr, values.ZKAUTH_GUARDIAN_ADDRESS);
  assert.match(values.ZKAUTH_PROVER_TOKEN!, /^[0-9a-f]{64}$/);
  assert.match(first.stdout, /secrets\.env/);
  noMnemonics(stateDir, first);
  const before = readFileSync(file, "utf8");
  const second = await ok(["init"]);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.match(second.stdout, /nothing to create/);
  noMnemonics(stateDir, second);
});

test("apps add and list", async () => {
  const bad = await run(["apps", "add", "x", "--provider", "google", "--client-id", "c"]);
  assert.equal(bad.code, 2);
  assert.equal((await run(["apps", "add", "x", "--provider", "nope", "--client-id", "c", "--origin", "http://localhost:1"])).code, 1);
  await ok(["apps", "add", "demo", "--provider", "google", "--client-id", "dev-client", "--origin", "http://localhost:8765"]);
  const again = await ok(["apps", "add", "demo", "--provider", "google", "--client-id", "dev-client", "--origin", "http://localhost:8765"]);
  assert.match(again.stdout, /unchanged/);
  const conflict = await run(["apps", "add", "demo", "--provider", "google", "--client-id", "other", "--origin", "http://localhost:8765"]);
  assert.equal(conflict.code, 1);
  await ok(["apps", "add", "extra", "--provider", "slack", "--client-id", "s1", "--origin", "http://localhost:8765", "--origin", "http://localhost:8775", "--shared", "--client-secret-env", "EXTRA_SECRET"]);
  const list = await ok(["apps", "list"]);
  assert.match(list.stdout, /demo {2}provider google {2}client dev-client {2}not deployed/);
  assert.match(list.stdout, /extra .*shared/);
  assert.match(list.stdout, /http:\/\/localhost:8765, http:\/\/localhost:8775/);
  await ok(["apps", "remove", "extra"]);
  assert.doesNotMatch((await ok(["apps", "list"])).stdout, /extra/);
});

test("deploy provider and app write records and are idempotent", async () => {
  const providerRecord = join(stateDir, "deployments/localnet/providers/google.json");
  const appRecord = join(stateDir, "deployments/localnet/apps/demo.json");
  const first = await ok(["deploy", "provider", "google"]);
  assert.match(first.stdout, /deployed key registry/);
  const record = JSON.parse(readFileSync(providerRecord, "utf8"));
  assert.equal(record.guardian, secrets().ZKAUTH_GUARDIAN_ADDRESS);
  assert.equal(record.administrator, signerFromMnemonic(secrets().ZKAUTH_ADMIN_MNEMONIC!).addr);
  const bytes = readFileSync(providerRecord, "utf8");
  const second = await ok(["deploy", "provider", "google"]);
  assert.match(second.stdout, /verified key registry/);
  assert.equal(readFileSync(providerRecord, "utf8"), bytes);

  assert.match((await ok(["deploy", "app", "demo"])).stdout, /deployed wallet registry/);
  assert.equal(JSON.parse(readFileSync(appRecord, "utf8")).audience, "dev-client");
  const appBytes = readFileSync(appRecord, "utf8");
  assert.match((await ok(["deploy", "app", "demo"])).stdout, /verified wallet registry/);
  assert.equal(readFileSync(appRecord, "utf8"), appBytes);
  assert.equal((await run(["deploy", "app", "missing"])).code, 1);
  noMnemonics(stateDir, first);
});

test("keys sync registers the dev key and seals; guardian status is clean", async () => {
  const sync = await ok(["keys", "sync"]);
  assert.match(sync.stdout, /google: registered 1, renewed 0, sealed the bootstrap/);
  const fingerprint = fingerprintOf(issuer.jwks.keys[0]!.n as string);
  assert.match((await ok(["keys", "list", "google"])).stdout, new RegExp(`${fingerprint}  active`));
  assert.match((await ok(["keys", "sync"])).stdout, /registered 0, renewed 0/);
  const status = await run(["guardian", "status"]);
  assert.equal(status.code, 0, status.stdout + status.stderr);
  assert.match(status.stdout, /bootstrap sealed/);
  assert.doesNotMatch(status.stdout, /ALERT/);
});

test("a key missing from the JWKS raises a guardian alert, and revoke clears it", async () => {
  // The administrator approves a key the provider does not publish. The registry is
  // sealed, so it is pending under the 24-hour delay: exactly what the guardian must catch.
  const stray = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" });
  const jwk = { ...stray, kid: "stray", alg: "RS256", use: "sig" };
  const fingerprint = fingerprintOf(jwk.n as string);
  const service = JSON.parse(readFileSync(join(stateDir, "deployments/localnet/providers/google.json"), "utf8"));
  const chain = await openChain({ network: "localnet", root });
  try {
    const done = await chain.keys(service).ensureKeys({ jwks: { keys: [jwk] }, administrator: signerFromMnemonic(secrets().ZKAUTH_ADMIN_MNEMONIC!) });
    assert.deepEqual(done.registered, [fingerprint]);
  } finally { await chain.close(); }

  const alert = await run(["guardian", "status", "google"]);
  assert.equal(alert.code, 1, alert.stdout + alert.stderr);
  assert.match(alert.stdout, new RegExp(`ALERT ${fingerprint}  PENDING`));
  assert.match(alert.stdout, /not in the provider's current JWKS/);

  // Without the guardian's mnemonic the action is refused.
  const refused = await run(["guardian", "revoke", fingerprint], stateDir, { ZKAUTH_GUARDIAN_MNEMONIC: secrets().ZKAUTH_ADMIN_MNEMONIC! });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /not the guardian/);

  const revoked = await ok(["guardian", "revoke", fingerprint]);
  assert.match(revoked.stdout, /revoke confirmed/);
  noMnemonics(stateDir, revoked);
  const after = await run(["guardian", "status"]);
  assert.equal(after.code, 0, after.stdout + after.stderr);
  assert.match(after.stdout, new RegExp(`${fingerprint}  revoked`));
});

test("up --local from empty state, twice", async () => {
  const first = await ok(["up", "--local"], upDir);
  assert.match(first.stdout, /deployed key registry/);
  assert.match(first.stdout, /registered 1|registered 0/); // 1 unless this dev key was approved by an earlier run
  assert.ok(existsSync(join(upDir, "deployments/localnet/apps/demo.json")));
  const app = JSON.parse(readFileSync(join(upDir, "apps.json"), "utf8")).apps[0];
  assert.deepEqual([app.id, app.provider, app.clientId, app.allowedOrigins], ["demo", "google", "dev-client", ["http://localhost:8765"]]);
  const second = await ok(["up", "--local"], upDir);
  assert.match(second.stdout, /verified key registry/);
  assert.match(second.stdout, /google: registered 0, renewed 0/);
  assert.equal((await run(["guardian", "status"], upDir)).code, 0);
  noMnemonics(upDir, first);
  // Without the dev issuer URL the command refuses rather than registering Google's real keys.
  const noIssuer = await run(["up", "--local"], upDir, { ZKAUTH_DEV_ISSUER_URL: "" });
  assert.equal(noIssuer.code, 1);
});

test("init (testnet) writes secrets without any network call", async () => {
  // An unreachable node: init must not touch it unless --wait is given.
  const env = { ZKAUTH_NETWORK: "testnet", ZKAUTH_DEV_ISSUER_URL: "", ZKAUTH_ALGOD_URL: "http://127.0.0.1:1" };
  const dry = await ok(["init", "--dry-run"], testnetDir, env);
  assert.match(dry.stdout, /dry run/);
  assert.ok(!existsSync(join(testnetDir, "secrets.env")));
  const real = await ok(["init"], testnetDir, env);
  assert.match(real.stdout, /Fund these TestNet accounts/);
  assert.match(real.stdout, /admin: at least 5\.00 ALGO/);
  assert.equal(statSync(join(testnetDir, "secrets.env")).mode & 0o777, 0o600);
  const before = readFileSync(join(testnetDir, "secrets.env"), "utf8");
  await ok(["init"], testnetDir, env);
  assert.equal(readFileSync(join(testnetDir, "secrets.env"), "utf8"), before);
  noMnemonics(testnetDir, real);
});
