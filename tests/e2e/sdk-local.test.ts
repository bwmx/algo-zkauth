// End to end against the compose local stack (docker compose --profile local up):
// the real SDK, API, prover, keysync, dev issuer and a dev-mode algod. The browser
// parts are replaced by a fetch that sends the demo's Origin and a login handler
// that fills in the dev issuer's sign-in page, as a person would.
//
//   node --import ./upstream/snarkjs-algorand/node_modules/tsx/dist/loader.mjs --test tests/e2e/sdk-local.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createZkAuth, algo, type LoginHandler } from "../../packages/sdk/src/index.ts";
import { AlgorandClient, microAlgos } from "../../packages/chain/src/deps.ts";

const SERVICE = process.env.E2E_API_URL ?? "http://localhost:8780";
const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:8765";
const TOKEN = "a".repeat(64);
const algorand = AlgorandClient.fromConfig({
  algodConfig: { server: "http://localhost", port: Number(process.env.E2E_ALGOD_PORT ?? 4101), token: TOKEN },
  kmdConfig: { server: "http://localhost", port: Number(process.env.E2E_KMD_PORT ?? 4102), token: TOKEN },
});

const browserFetch: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("Origin", ORIGIN);
  return fetch(input, { ...init, headers });
};

/** Signs in at the dev issuer as `subject`: load its page, submit the form, follow the redirect to the service's callback. */
const devIssuerLogin = (subject: string): LoginHandler => async ({ authorizeUrl }) => {
  assert.ok(authorizeUrl, "the local stack uses the code flow");
  const page = await fetch(authorizeUrl);
  assert.equal(page.status, 200);
  const form = new URLSearchParams();
  for (const [, name, value] of (await page.text()).matchAll(/<input type="hidden" name="([a-z_]+)" value="([^"]*)">/g))
    form.set(name!, value!.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))));
  form.set("subject", subject);
  const posted = await fetch(new URL("/authorize", authorizeUrl), { method: "POST", body: form, redirect: "manual" });
  assert.equal(posted.status, 302);
  const callback = await fetch(posted.headers.get("location")!);
  assert.equal(callback.status, 200);
};

const client = (subject: string) =>
  createZkAuth({ service: SERVICE, app: "demo", network: "localnet", fetch: browserFetch, login: devIssuerLogin(subject), pollMs: 250 });

test("sign in, back up, enroll, transfer, then restore in a fresh client and transfer again", { timeout: 240_000 }, async () => {
  const dispenser = await algorand.account.localNetDispenser();
  const subject = `e2e-${Date.now()}`;

  const zk = client(subject);
  const session = await zk.signIn();
  assert.equal(session.identity.subject, subject);
  const { file, secret } = await session.backup.create();
  const wallet = await session.wallet();
  assert.equal(wallet.enrolled, false);

  const enrolled = await wallet.enroll();
  assert.ok(enrolled?.txId);
  assert.ok(wallet.address);
  await algorand.send.payment({ sender: dispenser.addr, receiver: wallet.address!, amount: microAlgos(2_000_000) });
  const sent = await wallet.sendAlgo({ to: dispenser.addr.toString(), amount: algo(0.25) });
  assert.ok(sent.txId && sent.confirmedRound > 0n);
  const before = await wallet.balance();
  assert.ok(before.microAlgos > 0n);

  // A fresh client (new session key) restores the same wallet from the backup file and secret.
  const zk2 = client(subject);
  const session2 = await zk2.signIn();
  const restored = await session2.backup.restore(await file.text(), { secret });
  assert.equal(restored.enrolled, true);
  const wallet2 = await session2.wallet();
  assert.equal(wallet2.address, wallet.address);
  const again = await wallet2.sendAlgo({ to: dispenser.addr.toString(), amount: algo(0.1) });
  assert.ok(again.txId);
  assert.notEqual(again.txId, sent.txId);

  // Another identity on the same app has its own, unenrolled wallet.
  const other = await client(`${subject}-other`).signIn();
  await other.backup.create();
  const otherWallet = await other.wallet();
  assert.equal(otherWallet.enrolled, false);
});
