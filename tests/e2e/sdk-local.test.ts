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
import { readFileSync } from "node:fs";
import { SignInError, createNonce, createVerifier, fetchAppSettings } from "../../packages/verify/src/index.ts";

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

test("a backend verifies a sign-in against the chain, and refuses every tampered or misdirected one", { timeout: 240_000 }, async () => {
  const verifier = createVerifier({
    algodUrl: `http://localhost:${process.env.E2E_ALGOD_PORT ?? 4101}`, algodToken: TOKEN,
    apps: await fetchAppSettings(SERVICE, "demo"),
    verificationKeys: { google: readFileSync(new URL("../../fixtures/phase3/verification_key.json", import.meta.url)) },
    clockToleranceSeconds: 600,                                   // dev-mode algod's clock stands still between transactions
  });
  const refused = async (signIn: unknown, code: string, expected = { origin: ORIGIN, nonce }) => {
    await assert.rejects(verifier.verify(signIn, expected), (e: unknown) => e instanceof SignInError && e.code === code, code);
  };

  const subject = `e2e-signin-${Date.now()}`;
  const session = await client(subject).signIn();
  await session.backup.create();
  let nonce = createNonce();

  // Before enrollment: a stable subject, no address yet.
  const early = await session.createSignIn({ nonce, origin: ORIGIN, statement: "Sign in to the demo" });
  const first = await verifier.verify(early, { origin: ORIGIN, nonce });
  assert.equal(first.address, null);
  assert.equal(first.app, "demo");
  assert.equal(first.statement, "Sign in to the demo");

  const wallet = await session.wallet();
  await wallet.enroll();
  nonce = createNonce();
  const signIn = await session.createSignIn({ nonce, origin: ORIGIN });
  const who = await verifier.verify(signIn, { origin: ORIGIN, nonce });
  assert.equal(who.address, wallet.address);
  assert.equal(who.walletId, wallet.id);
  assert.equal(who.subject, first.subject);                       // the same user, before and after enrollment

  // The challenge and the site must be the backend's own.
  await refused(signIn, "wrong_nonce", { origin: ORIGIN, nonce: createNonce() });
  await refused(signIn, "wrong_origin", { origin: "https://evil.example", nonce });
  // Any change to the message breaks the session key's signature.
  await refused({ ...signIn, fields: { ...signIn.fields, statement: "Send me everything" } }, "bad_signature");
  await refused({ ...signIn, fields: { ...signIn.fields, expiresAt: signIn.fields.expiresAt - 1 } }, "bad_signature");
  await refused({ ...signIn, signature: early.signature }, "bad_signature");
  // The message cannot name another wallet: the address is signed, and checked against the registry.
  await refused({ ...signIn, fields: { ...signIn.fields, address: null } }, "bad_signature");
  // The proof must be this session's: another session's proof names another key.
  const other = await client(`${subject}-other`).signIn();
  await other.backup.create();
  const otherSignIn = await other.createSignIn({ nonce, origin: ORIGIN });
  await refused({ ...signIn, proof: otherSignIn.proof }, "bad_signature");
  // A forged proof for the same signals fails the Groth16 check.
  const forged = structuredClone(signIn.proof);
  forged.proof.pi_a = otherSignIn.proof.proof.pi_a;
  await refused({ ...signIn, proof: forged }, "invalid_proof");
  // Changed public signals: another network, another app's audience, another key.
  const signals = (i: number) => ({ ...signIn, proof: { ...signIn.proof, publicSignals: signIn.proof.publicSignals.map((s, j) => (j === i ? String(BigInt(s) ^ 1n) : s)) } });
  await refused(signals(9), "wrong_network");
  await refused(signals(5), "wrong_audience");
  await refused(signals(7), "bad_signature");
  await refused(signals(0), "invalid_proof");
  // Another app's sign-ins are not accepted by a backend that pins only this one.
  const exampleOnly = createVerifier({
    algodUrl: `http://localhost:${process.env.E2E_ALGOD_PORT ?? 4101}`, algodToken: TOKEN,
    apps: await fetchAppSettings(SERVICE, "example"),
    verificationKeys: { google: readFileSync(new URL("../../fixtures/phase3/verification_key.json", import.meta.url)) },
    clockToleranceSeconds: 600,                                   // dev-mode algod's clock stands still between transactions
  });
  await assert.rejects(exampleOnly.verify(signIn, { origin: ORIGIN, nonce }), (e: unknown) => e instanceof SignInError && e.code === "unknown_app");
  // Garbage.
  await refused(null, "malformed");
  await refused({ ...signIn, signature: "x" }, "malformed");
});
