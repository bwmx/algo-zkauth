// @vitest-environment node
// Re-verifies real recorded TestNet transactions (saved indexer responses) with
// the same code the showcase runs in the browser, including the Groth16 proof.
import { afterAll, describe, expect, test } from "vitest";
import run from "../src/site/recorded-run.json";
import { decodeAuthorization, verifyAuthorization, type IndexerAppCall } from "../src/site/verify";
import execute from "./fixtures/tx-execute-NBD33Q2T.json";
import enroll from "./fixtures/tx-enroll-VGE5NAB5.json";
import walletApp from "./fixtures/app-773944646.json";

const deployment = run.deployment;
const walletA = run.wallets.find(w => w.accountCase === "A")!;
const tx = (fixture: { transaction: unknown }) => structuredClone(fixture.transaction) as IndexerAppCall;
const ok = (checks: { ok: boolean }[]) => checks.every(c => c.ok);

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
