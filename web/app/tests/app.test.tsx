// The React page under jsdom with stubbed server, Google and indexer. This
// cannot establish TestNet acceptance; it checks the page's gates and that
// every action is signed by the tab's session key.
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import * as sdk from "algosdk";
import { actionDigest } from "../../../packages/protocol/src/action-node.mjs";
import { recoveryCommitment } from "../../../packages/protocol/src/recovery.mjs";
import { sessionNonce } from "../../../packages/protocol/src/session-nonce.mjs";
import { App } from "../src/App";
import { DemoController } from "../src/controller";
import { INDEXER } from "../src/indexer";

// "example" stands for any further code-flow provider: the page has no code for it.
type Provider = "google" | "slack" | "example";
const LABELS: Record<Provider, string> = { google: "Google", slack: "Slack", example: "Example" };
type Options = { provider?: Provider; changePlan?: boolean; wrongNonce?: boolean; wrongProofKey?: boolean; popupBlocked?: boolean; sessionSeconds?: number };
const AUTHORIZE_URL = "https://slack.com/openid/connect/authorize?stub";
let downloaded: Blob | undefined;

beforeEach(() => {
  downloaded = undefined;
  URL.createObjectURL = vi.fn((blob: Blob) => { downloaded = blob; return "blob:test"; });
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
});

function stubServer({ provider = "google", changePlan = false, wrongNonce = false, wrongProofKey = false, popupBlocked = false, sessionSeconds = 600 }: Options = {}) {
  const code = provider !== "google";
  const clientId = code ? "1234567890.9876543210" : "test.apps.googleusercontent.com";
  const config = {
    provider, label: LABELS[provider], loginFlow: code ? "code" : "in-page",
    providers: ["google", "slack", ...(provider === "example" ? ["example"] : [])], providerLabels: LABELS, network: "testnet-v1.0", genesisHash: randomBytes(32).toString("base64url"), audienceHash: createHash("sha256").update(clientId).digest("base64url"),
    registryId: "12", keyRegistryId: "11", demoAssetId: "90", sponsor: sdk.generateAccount().addr.toString(), enrollmentDeposit: "454800", groupFeeMicroAlgos: "20000",
    approvedKeys: [], clientId, latestTimestamp: "0",
  };
  const identity = code
    ? { issuer: "https://slack.com", audience: clientId, subject: "T0123ABC456/U0123ABCDEF" }
    : { issuer: "https://accounts.google.com", audience: clientId, subject: "123456789012345678901" };
  const opened: string[] = [];
  let statusPolls = 0;
  let wallet = { walletId: "0", address: null as string | null, nonce: "0", balanceMicroAlgos: "0", minBalanceMicroAlgos: "0", assets: [] as { id: string; amount: string }[], enrolled: false };
  const copy = () => structuredClone(wallet);
  const requests: { url: string; body: any }[] = [];
  const plans = new Map<string, any>();
  let context: any, commitment: string, proof: any, planCount = 0, callback: ((r: { credential: string }) => void) | undefined;
  const limbs = (b: Buffer) => [b.subarray(0, 16), b.subarray(16)].map(v => BigInt(`0x${v.toString("hex")}`).toString());
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    requests.push({ url, body });
    let value: any;
    if (url.startsWith(INDEXER)) value = url.includes("/assets/") ? { asset: { params: { "unit-name": "ZK6" } } } : { transactions: [] };
    else if (url === `/demo/config?provider=${provider}`) value = config;
    else if (url === "/demo/login-start") {
      expect(body.provider).toBe(provider);
      const expiresAt = Math.floor(Date.now() / 1000) + sessionSeconds;
      const nonce = sessionNonce({ genesisHash: Buffer.from(config.genesisHash, "base64url"), sessionPublicKey: Buffer.from(body.sessionPublicKey, "base64url"), expiresAt, randomness: Buffer.from(body.randomness, "base64url") });
      context = { ...body, sessionId: "session", nonce: wrongNonce ? nonce.replace(/^./, (c: string) => (c === "A" ? "B" : "A")) : nonce, expiresAt };
      value = { sessionId: context.sessionId, provider, nonce: context.nonce, expiresAt, ...(code ? { authorizeUrl: AUTHORIZE_URL } : {}) };
    } else if (url === "/demo/login" && provider === "google") value = { verified: true, identity, accountCase: "A", expiresAt: context.expiresAt };
    // The login window completes on the server; report it on the second poll.
    else if (url === "/demo/login-status" && code) value = opened.length && ++statusPolls >= 2 ? { verified: true, identity, accountCase: "A", expiresAt: context.expiresAt } : { verified: false };
    else if (url === "/demo/discover") {
      // A plain Uint8Array: jsdom's realm does not treat Node Buffers as its own.
      commitment = Buffer.from(await recoveryCommitment(identity, new Uint8Array(Buffer.from(body.salt, "base64url")))).toString("base64url");
      value = { wallet: copy(), commitment };
    } else if (url === "/demo/proof") {
      expect(body.backupVerified).toBe(true);
      const key = wrongProofKey ? randomBytes(32) : Buffer.from(context.sessionPublicKey, "base64url");
      proof = { publicSignals: [...limbs(Buffer.from(commitment, "base64url")), ...limbs(randomBytes(32)), ...limbs(Buffer.from(config.audienceHash, "base64url")), ...limbs(key), ...limbs(Buffer.from(config.genesisHash, "base64url")), String(context.expiresAt), String(context.expiresAt - 660)], ready: true, stage: "ready", elapsedMs: 1, measurement: { elapsedMs: 1, witnessMs: 1, proveMs: 1, peakRssBytes: 1024 } };
      value = { jobId: "job" };
    } else if (url.startsWith("/demo/proof/")) value = proof;
    else if (url === "/demo/prepare") {
      const p = { planId: String(planCount++), genesisHash: config.genesisHash, registryId: config.registryId, walletId: body.operation === "0" ? "0" : wallet.walletId, owner: commitment, operation: body.operation, recipient: body.recipient, recipientPublicKey: Buffer.from(sdk.decodeAddress(body.recipient).publicKey).toString("base64url"), assetId: body.assetId, amount: body.amount, nonce: body.operation === "0" ? "0" : wallet.nonce, sessionExpiresAt: String(context.expiresAt) };
      plans.set(p.planId, p);
      value = changePlan ? { ...p, amount: "9999" } : p;
    } else if (url === "/demo/submit") {
      const p = plans.get(body.planId);
      const digest = actionDigest({ ...p, genesisHash: Buffer.from(p.genesisHash, "base64url"), owner: Buffer.from(p.owner, "base64url"), recipient: sdk.decodeAddress(p.recipient).publicKey });
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: context.sessionPublicKey }, format: "jwk" });
      expect(verify(null, digest, key, Buffer.from(body.signature, "base64url"))).toBe(true);
      if (p.operation === "0") wallet = { ...wallet, enrolled: true, walletId: "34", address: sdk.getApplicationAddress(34n).toString(), balanceMicroAlgos: "100000", minBalanceMicroAlgos: "100000" };
      else {
        expect(p.nonce).toBe(wallet.nonce);
        wallet.nonce = String(BigInt(wallet.nonce) + 1n);
        if (p.operation === "1") wallet.balanceMicroAlgos = String(BigInt(wallet.balanceMicroAlgos) - BigInt(p.amount));
        if (p.operation === "2") { wallet.assets = [{ id: config.demoAssetId, amount: "0" }]; wallet.minBalanceMicroAlgos = "200000"; }
        if (p.operation === "3") wallet.assets[0].amount = String(BigInt(wallet.assets[0].amount) - BigInt(p.amount));
      }
      value = { wallet: copy(), measurement: { operation: p.operation, confirmedRound: "100", groupFeeMicroAlgos: "20000", transactionIds: Array.from({ length: 7 }, (_, i) => `TX${i}`), outerTransactions: 7, innerTransactions: 7 } };
    } else if (url === "/demo/fund") { wallet.balanceMicroAlgos = "1100000"; value = { wallet: copy() }; }
    else if (url === "/demo/seed") { wallet.assets[0].amount = "100"; value = { wallet: copy() }; }
    else if (url === "/demo/replay") value = { replayRejectedByNode: true, noncePreserved: true };
    else if (url === "/demo/isolation") value = { available: false };
    else if (url === "/demo/wallet-binding") value = { stage: "wallet", networkGenesisHash: config.genesisHash, registryAppId: config.registryId, walletAppId: wallet.walletId, walletAddress: wallet.address };
    else throw new Error(`Unexpected stub request ${url}`);
    return { ok: true, json: async () => value };
  }));
  vi.stubGlobal("google", provider === "google" ? { accounts: { id: { initialize: (o: any) => { callback = o.callback; }, renderButton: vi.fn() } } } : undefined);
  vi.spyOn(window, "open").mockImplementation(((url: string) => { opened.push(url); return popupBlocked ? null : ({} as Window); }) as typeof window.open);
  const part = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return {
    config, requests, opened, wallet: copy,
    loginReady: () => !!callback,
    login: () => code
      ? fireEvent.click(screen.getByRole("button", { name: `Sign in with ${LABELS[provider]}` }))
      : callback!({ credential: `${part({ alg: "RS256", kid: "k1", typ: "JWT" })}.${part({ iss: identity.issuer, aud: identity.audience, sub: identity.subject, nonce: context.nonce, iat: 1, exp: 2 })}.sig` }),
    submitted: () => requests.filter(r => r.url === "/demo/submit").length,
  };
}

const status = () => screen.getByTestId("status").textContent ?? "";
const waitStatus = (pattern: RegExp) => waitFor(() => expect(status()).toMatch(pattern));
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const click = (name: string | RegExp) => fireEvent.click(button(name));
const nextStep = () => document.querySelector(".next-step")?.textContent ?? "";

async function start(options: Options = {}) {
  const server = stubServer(options);
  render(<App controller={new DemoController({ provider: options.provider, pollMs: 0, loginPollMs: 0, historyRetryMs: 0 })} />);
  await waitStatus(/Sign in with (Google|Slack|Example) to prepare/);
  return server;
}

async function verifiedBackup(server: ReturnType<typeof stubServer>) {
  server.login();
  await waitStatus(/(Google|Slack|Example) identity verified/);
  click("Create new salt and backup");
  await waitStatus(/Backup created/);
  click("Download encrypted backup");
  await waitStatus(/Backup download started/);
  fireEvent.click(screen.getByRole("checkbox"));
  const text = await downloaded!.text();
  fireEvent.change(screen.getByLabelText("Import encrypted backup"), { target: { files: [new File([text], "backup.json", { type: "application/json" })] } });
  await waitStatus(/Package selected/);
  const secret = (document.getElementById("new-secret") as HTMLInputElement).value;
  fireEvent.change(screen.getByLabelText("Saved recovery secret"), { target: { value: secret } });
  click("Restore using secret");
  await waitStatus(/Backup verified/);
}

async function proven(options: Options = {}) {
  const server = await start(options);
  await verifiedBackup(server);
  click("Generate local proof");
  await waitStatus(/Proof verified/);
  return server;
}

test("full flow enforces the backup gate and signs every enrollment/ALGO/ASA action with the browser key", async () => {
  const server = await start();
  server.login();
  await waitStatus(/Google identity verified/);
  click("Create new salt and backup");
  await waitStatus(/Backup created/);
  expect(button("Run ALGO / ASA demo").disabled).toBe(true);
  expect(button("Generate local proof").disabled).toBe(true);
  click("Download encrypted backup");
  await waitStatus(/Backup download started/);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("Import encrypted backup"), { target: { files: [new File([await downloaded!.text()], "backup.json")] } });
  await waitStatus(/Package selected/);
  fireEvent.change(screen.getByLabelText("Saved recovery secret"), { target: { value: (document.getElementById("new-secret") as HTMLInputElement).value } });
  click("Restore using secret");
  await waitStatus(/Backup verified/);
  click("Generate local proof");
  await waitStatus(/Proof verified/);
  expect(screen.getByLabelText("Proof binding checks").textContent).toMatch(/Session key/);
  click("Run ALGO / ASA demo");
  await waitStatus(/demo passed/);
  expect(server.requests.filter(r => r.url === "/demo/prepare").map(r => r.body.operation)).toEqual(["0", "1", "2", "3"]);
  expect(server.wallet().nonce).toBe("3");
  expect(server.wallet().assets[0].amount).toBe("93");
  // The enrollment resealed the backup with the wallet binding.
  expect(button("Download wallet-bound backup").disabled).toBe(false);
});

test("a changed server plan is rejected before the browser sends any action signature", async () => {
  const server = await proven({ changePlan: true });
  click("Run ALGO / ASA demo");
  await waitStatus(/changed amount/);
  expect(server.submitted()).toBe(0);
});

test("a server nonce that does not bind this tab's key stops login before Google is offered", async () => {
  const server = stubServer({ wrongNonce: true });
  render(<App controller={new DemoController({ pollMs: 0 })} />);
  await waitStatus(/Server nonce does not bind/);
  expect(server.loginReady()).toBe(false);
});

test("a proof bound to another session key cannot unlock signing", async () => {
  const server = await start({ wrongProofKey: true });
  await verifiedBackup(server);
  click("Generate local proof");
  await waitStatus(/Proof public bindings differ/);
  expect(button("Run ALGO / ASA demo").disabled).toBe(true);
  expect(server.requests.some(r => r.url === "/demo/prepare")).toBe(false);
});

test("disabled proof generation explains the exact missing backup step", async () => {
  const server = await start();
  expect(nextStep()).toMatch(/Sign in with Google/);
  server.login();
  await waitStatus(/Google identity verified/);
  expect(nextStep()).toMatch(/create a recovery backup/);
  click("Create new salt and backup");
  await waitStatus(/Backup created/);
  expect(nextStep()).toMatch(/Download encrypted backup/);
  click("Download encrypted backup");
  await waitStatus(/Backup download started/);
  expect(nextStep()).toMatch(/tick the box/);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("Import encrypted backup"), { target: { files: [new File([await downloaded!.text()], "backup.json")] } });
  await waitStatus(/Package selected/);
  expect(nextStep()).toMatch(/click Restore using secret/);
  click("Restore using secret");
  await waitStatus(/Invalid recovery|secret/i);
  expect(button("Generate local proof").disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Saved recovery secret"), { target: { value: (document.getElementById("new-secret") as HTMLInputElement).value } });
  click("Restore using secret");
  await waitStatus(/Backup verified/);
  expect(nextStep()).toMatch(/Backup verified.*Generate local proof/);
});

test("a custom transfer is validated, reviewed and only then signed; cancelling submits nothing", async () => {
  const server = await proven();
  click("Enroll wallet");
  await waitStatus(/Wallet enrolled/);
  click("Fund test ALGO");
  await waitStatus(/funding is available/);
  const amount = screen.getByRole("textbox", { name: /Amount in ALGO/ });
  fireEvent.change(amount, { target: { value: "0.25" } });
  expect(screen.getByText("= 250,000 µALGO")).toBeTruthy();
  click("Review transfer");
  await waitStatus(/Review it/);
  const review = screen.getByRole("dialog", { name: "Review transfer" });
  expect(review.textContent).toMatch(/0\.25 ALGO/);
  expect(review.textContent).toMatch(/sponsor/);
  expect(server.submitted()).toBe(1);
  click("Cancel");
  await waitStatus(/cancelled before signing/);
  expect(server.submitted()).toBe(1);
  click("Review transfer");
  await waitStatus(/Review it/);
  click("Sign and submit");
  await waitStatus(/Transfer confirmed/);
  const submitted = server.requests.filter(r => r.url === "/demo/prepare").at(-1)!.body;
  expect(submitted).toMatchObject({ operation: "1", assetId: "0", amount: "250000", recipient: server.config.sponsor });
  expect(server.submitted()).toBe(2);
  expect(server.wallet().balanceMicroAlgos).toBe("850000");
});

test("an amount above the spendable balance is refused before any plan is requested", async () => {
  const server = await proven();
  click("Enroll wallet");
  await waitStatus(/Wallet enrolled/);
  click("Fund test ALGO");
  await waitStatus(/funding is available/);
  fireEvent.change(screen.getByRole("textbox", { name: /Amount in ALGO/ }), { target: { value: "5" } });
  const prepares = server.requests.filter(r => r.url === "/demo/prepare").length;
  click("Review transfer");
  await waitStatus(/exceeds the wallet's spendable/);
  expect(server.requests.filter(r => r.url === "/demo/prepare").length).toBe(prepares);
});

test("a Slack tab signs in through a login window, never receives the token, and runs the same wallet flow", async () => {
  const server = await start({ provider: "slack" });
  expect(nextStep()).toMatch(/Sign in with Slack/);
  expect(screen.getByText(/Slack → your Algorand wallet/)).toBeTruthy();
  expect((screen.getByRole("link", { name: "Use Google in a new tab" }) as HTMLAnchorElement).getAttribute("href")).toBe("/demo/?provider=google");
  await verifiedBackup(server);
  expect(server.opened).toEqual([AUTHORIZE_URL]);
  expect(server.requests.filter(r => r.url === "/demo/login-status").length).toBe(2);
  expect(server.requests.some(r => r.url === "/demo/login")).toBe(false);
  expect(screen.getByText("Not available in the browser for Slack.")).toBeTruthy();
  click("Generate local proof");
  await waitStatus(/Proof verified/);
  click("Run ALGO / ASA demo");
  await waitStatus(/demo passed/);
  expect(server.requests.filter(r => r.url === "/demo/prepare").map(r => r.body.operation)).toEqual(["0", "1", "2", "3"]);
});

test("another code-flow provider needs only server configuration: same login window and wallet flow", async () => {
  const server = await start({ provider: "example" });
  expect(nextStep()).toMatch(/Sign in with Example/);
  expect(screen.getByText(/Example → your Algorand wallet/)).toBeTruthy();
  expect((screen.getByRole("link", { name: "Use Slack in a new tab" }) as HTMLAnchorElement).getAttribute("href")).toBe("/demo/?provider=slack");
  await verifiedBackup(server);
  expect(server.opened).toEqual([AUTHORIZE_URL]);
  expect(server.requests.some(r => r.url === "/demo/login")).toBe(false);
  click("Generate local proof");
  await waitStatus(/Proof verified/);
});

test("a blocked Slack login window is reported without polling the server", async () => {
  const server = await start({ provider: "slack", popupBlocked: true });
  click("Sign in with Slack");
  await waitStatus(/Allow pop-ups/);
  expect(server.requests.some(r => r.url === "/demo/login-status")).toBe(false);
  expect(button("Sign in with Slack").disabled).toBe(false);
});

test("a Google tab offers Slack in a separate tab, since each provider has its own wallets", async () => {
  await start();
  expect((screen.getByRole("link", { name: "Use Slack in a new tab" }) as HTMLAnchorElement).getAttribute("href")).toBe("/demo/?provider=slack");
});

test("the full demo cannot start when too little session time is left, but single actions still can", async () => {
  const server = await start({ sessionSeconds: 80 });
  await verifiedBackup(server);
  click("Generate local proof");
  await waitStatus(/Proof verified/);
  expect(button("Run ALGO / ASA demo").disabled).toBe(true);
  expect(nextStep()).toMatch(/not enough to finish the full demo/);
  expect(screen.getByText(/the full demo needs about 90 seconds/)).toBeTruthy();
  expect(button("Enroll wallet").disabled).toBe(false);
  expect(server.requests.some(r => r.url === "/demo/prepare")).toBe(false);
});
