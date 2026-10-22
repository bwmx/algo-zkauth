// @vitest-environment node
// Re-verifies real recorded TestNet transactions (saved indexer responses) with
// the same code the showcase runs in the browser, including the Groth16 proof.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, test } from "vitest";
import providers from "../src/data/providers.json";
import run from "../src/data/recorded-run.json";
import stack from "../src/data/service-stack-run.json";
import { decodeAuthorization, loadVerificationKey, verifyAuthorization, VERIFICATION_KEYS, type IndexerAppCall } from "../src/verify";
import execute from "./fixtures/tx-execute-NBD33Q2T.json";
import enroll from "./fixtures/tx-enroll-VGE5NAB5.json";
import walletApp from "./fixtures/app-773944646.json";
import stackExecute from "./fixtures/tx-execute-L5UCQ4C4.json";
import stackEnroll from "./fixtures/tx-enroll-X6LUZFCP.json";
import stackWalletApp from "./fixtures/app-774683272.json";
import exampleWalletApp from "./fixtures/app-774683485.json";

const deployment = { ...run.deployment, provider: "google" };
const walletA = run.wallets.find(w => w.accountCase === "A")!;
const tx = (fixture: { transaction: unknown }) => structuredClone(fixture.transaction) as IndexerAppCall;
const ok = (checks: { ok: boolean }[]) => checks.every(c => c.ok);
const ownerOf = (fixture: { application: { params: { "global-state": { key: string; value: { bytes: string } }[] } } }) =>
  Buffer.from(fixture.application.params["global-state"].find(s => s.key === btoa("owner"))!.value.bytes, "base64").toString("base64url");

afterAll(async () => { await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate(); });

describe("a recorded ALGO transfer from wallet A after its restore", () => {
  test("decodes to the signed action and passes every check, including the proof", async () => {
    const auth = decodeAuthorization(tx(execute), deployment);
    expect(auth.method).toBe("execute");
    expect(auth.plan).toMatchObject({ walletId: walletA.walletId, operation: "1", amount: "10000", assetId: "0", recipient: deployment.sponsor, nonce: "3" });
    expect(auth.signals.commitment).toBe(walletA.ownerCommitment);
    const checks = await verifyAuthorization(auth, deployment, walletA.ownerCommitment);
    expect(checks.filter(c => !c.ok).map(c => c.label)).toEqual([]);
  });

  test("the owner read from the wallet's on-chain state matches the recorded commitment", () => {
    const owner = walletApp.application.params["global-state"].find(s => s.key === btoa("owner"))!;
    expect(Buffer.from(owner.value.bytes, "base64").toString("base64url")).toBe(walletA.ownerCommitment);
  });

  test("a different amount breaks the signature, and a different signal breaks the proof", async () => {
    const auth = decodeAuthorization(tx(execute), deployment);
    const changed = await verifyAuthorization({ ...auth, plan: { ...auth.plan, amount: "10001" } }, deployment, walletA.ownerCommitment);
    expect(changed.find(c => c.label.startsWith("Session key"))!.ok).toBe(false);
    const signals = [...auth.publicSignals];
    signals[10] = String(BigInt(signals[10]) + 1n);
    const forged = await verifyAuthorization({ ...auth, publicSignals: signals }, deployment, walletA.ownerCommitment);
    expect(forged.find(c => c.label.startsWith("Zero-knowledge"))!.ok).toBe(false);
  });

  test("another wallet's owner and a different verifier are reported", async () => {
    const auth = decodeAuthorization(tx(execute), deployment);
    const checks = await verifyAuthorization(auth, { ...deployment, verifier: deployment.sponsor }, run.wallets[1].ownerCommitment, async () => true);
    expect(checks.filter(c => !c.ok).map(c => c.label)).toEqual(["Signed by the verifier LogicSig", "Owner is this wallet's identity commitment"]);
  });
});

test("wallet A's recorded enrollment verifies with the deposit as its signed amount", async () => {
  const auth = decodeAuthorization(tx(enroll), deployment);
  expect(auth.method).toBe("enroll");
  expect(auth.plan).toMatchObject({ walletId: "0", operation: "0", amount: deployment.enrollmentDeposit, recipient: deployment.sponsor, nonce: "0" });
  expect(ok(await verifyAuthorization(auth, deployment, walletA.ownerCommitment))).toBe(true);
});

test("a call that is not an enrollment or execution is refused", () => {
  const other = tx(execute);
  other["application-transaction"]["application-args"] = [btoa("x")];
  expect(() => decodeAuthorization(other, deployment)).toThrow(/Not a wallet/);
});

describe("the service stack's recorded run", () => {
  const appOf = (name: string) => stack.apps.find(a => a.app === name)!;
  const deploymentOf = (name: string) => ({ ...appOf(name).deployment, genesisHash: stack.genesisHash });

  test("is on the same network as the original run, with a known provider for every app", () => {
    expect(stack.genesisHash).toBe(run.deployment.genesisHash);
    for (const app of stack.apps) expect(Object.keys(providers)).toContain(app.deployment.provider);
  });

  test("a self-transfer from the demo app's wallet passes every check against that app's deployment", async () => {
    const action = appOf("demo").actions.find(a => a.txId === stackExecute.transaction.id)!;
    expect(action).toMatchObject({ operation: "send ALGO", selfTransfer: true });
    const auth = decodeAuthorization(tx(stackExecute), deploymentOf("demo"));
    expect(auth.plan).toMatchObject({ walletId: action.walletId, operation: "1", amount: action.amount, assetId: "0", recipient: action.recipient, nonce: action.nonce });
    const checks = await verifyAuthorization(auth, deploymentOf("demo"), ownerOf(stackWalletApp));
    expect(checks.filter(c => !c.ok).map(c => c.label)).toEqual([]);
    expect(checks.map(c => c.label)).toContain("Bound to this app's Google client");
  });

  test("the example app's enrollment verifies with its wallet's on-chain owner", async () => {
    const action = appOf("example").actions[0];
    expect(action.txId).toBe(stackEnroll.transaction.id);
    const auth = decodeAuthorization(tx(stackEnroll), deploymentOf("example"));
    expect(auth.method).toBe("enroll");
    expect(ok(await verifyAuthorization(auth, deploymentOf("example"), ownerOf(exampleWalletApp)))).toBe(true);
  });

  test("another app's registry breaks the signature", async () => {
    const auth = decodeAuthorization(tx(stackExecute), deploymentOf("example"));
    const checks = await verifyAuthorization(auth, deploymentOf("example"), ownerOf(stackWalletApp), async () => true);
    expect(checks.filter(c => !c.ok).map(c => c.label)).toEqual(["Session key signed exactly this action"]);
  });
});

test("every provider's committed verification key is bundled and loads byte for byte", async () => {
  for (const [id, provider] of Object.entries(providers)) {
    expect(Object.keys(VERIFICATION_KEYS)).toContain(provider.verificationKey);
    expect(await loadVerificationKey(id)).toEqual(JSON.parse(readFileSync(new URL(`../../../${provider.verificationKey}`, import.meta.url), "utf8")));
  }
  await expect(loadVerificationKey("unknown")).rejects.toThrow(/Unknown login provider/);
});
