import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AlgorandClient, microAlgos } from "@algorandfoundation/algokit-utils";
import * as snarkjs from "snarkjs";
import {
  encodeGroth16Bn254Proof,
  Groth16Bn254AppVerifier,
  Groth16Bn254LsigVerifier,
} from "../src/groth16";
import { Groth16Bn254SignalsAndProofFactory } from "../contracts/clients/Groth16Bn254SignalsAndProof";

const fixture = resolve(process.cwd(), "../../fixtures/phase1");
const readJson = (name: string) =>
  JSON.parse(readFileSync(resolve(fixture, name), "utf8"));
const budget = 20_000 * 16 - 700;

describe("project Phase 1: custom BN254 Groth16 proof", () => {
  const algorand = AlgorandClient.defaultLocalNet();
  let curve: any;
  let app: Groth16Bn254AppVerifier;
  let proof: ReturnType<typeof encodeGroth16Bn254Proof>;
  let signals: bigint[];

  beforeAll(async () => {
    // @ts-expect-error snarkjs does not type curves
    curve = await snarkjs.curves.getCurveFromName("bn128");
    proof = encodeGroth16Bn254Proof(readJson("proof.json"), curve);
    signals = readJson("public.json").map((s: string) => BigInt(s));
    app = new Groth16Bn254AppVerifier({
      algorand,
      zKey: resolve(fixture, "square_chain_2.zkey"),
      wasmProver: resolve(fixture, "square_chain_2_js/square_chain_2.wasm"),
    });
    await app.deploy({
      appName: `poc-phase1-${Date.now()}`,
      defaultSender: await algorand.account.localNetDispenser(),
    });
  });

  afterAll(async () => {
    await curve?.terminate();
  });

  it("verifies independently with snarkjs and in AVM simulation", async () => {
    expect(
      await snarkjs.groth16.verify(
        readJson("verification_key.json"),
        readJson("public.json"),
        readJson("proof.json"),
      ),
    ).toBe(true);
    const result = await app.simulateVerificationWithProofAndSignals(
      { proof, signals },
      { extraOpcodeBudget: budget },
    );
    expect(result.simulateResponse.txnGroups[0]?.failedAt).toBeUndefined();
    expect(result.simulateResponse.txnGroups[0]?.appBudgetConsumed).toBeGreaterThan(0);
  });

  it("rejects an altered public signal", async () => {
    expect(
      await snarkjs.groth16.verify(
        readJson("verification_key.json"),
        [String(signals[0]! + 1n), String(signals[1])],
        readJson("proof.json"),
      ),
    ).toBe(false);
    await expect(
      app.simulateVerificationWithProofAndSignals(
        { proof, signals: [signals[0]! + 1n, signals[1]!] },
        { extraOpcodeBudget: budget },
      ),
    ).rejects.toThrow();
  });

  it("rejects a missing signal and a scalar outside BN254 Fr", async () => {
    await expect(
      app.simulateVerificationWithProofAndSignals(
        { proof, signals: signals.slice(0, 1) },
        { extraOpcodeBudget: budget },
      ),
    ).rejects.toThrow();
    const fr = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    await expect(
      app.simulateVerificationWithProofAndSignals(
        { proof, signals: [fr, signals[1]!] },
        { extraOpcodeBudget: budget },
      ),
    ).rejects.toThrow();
  });

  it("rejects a corrupted proof point", async () => {
    const corrupt = { ...proof, piA: new Uint8Array(proof.piA) };
    corrupt.piA[0] = corrupt.piA[0]! ^ 1;
    await expect(
      app.simulateVerificationWithProofAndSignals(
        { proof: corrupt, signals },
        { extraOpcodeBudget: budget },
      ),
    ).rejects.toThrow();
  });

  it("rejects a truncated proof point encoding", async () => {
    const malformed = { ...proof, piA: proof.piA.slice(0, 63) };
    await expect(
      app.simulateVerificationWithProofAndSignals(
        { proof: malformed, signals },
        { extraOpcodeBudget: budget },
      ),
    ).rejects.toThrow();
  });

  it("rejects the proof under a different setup for the same circuit", async () => {
    const other = new Groth16Bn254AppVerifier({
      algorand,
      zKey: resolve(fixture, "wrong_setup.zkey"),
      wasmProver: resolve(fixture, "square_chain_2_js/square_chain_2.wasm"),
    });
    await other.deploy({
      appName: `poc-phase1-wrong-vk-${Date.now()}`,
      defaultSender: await algorand.account.localNetDispenser(),
    });
    await expect(
      other.simulateVerificationWithProofAndSignals(
        { proof, signals },
        { extraOpcodeBudget: budget },
      ),
    ).rejects.toThrow();
  });

  it("confirms the custom proof in a real LocalNet transaction group", async () => {
    const sender = await algorand.account.localNetDispenser();
    const factory = new Groth16Bn254SignalsAndProofFactory({
      algorand,
      defaultSender: sender,
    });
    const { appClient } = await factory.deploy({ onUpdate: "append" });
    const verifier = new Groth16Bn254LsigVerifier({
      appOffset: 0,
      totalLsigs: 6,
      algorand,
      zKey: resolve(fixture, "square_chain_2.zkey"),
      wasmProver: resolve(fixture, "square_chain_2_js/square_chain_2.wasm"),
    });
    const group = appClient.newGroup();
    await verifier.verificationParams({
      proof,
      signals,
      composer: group,
      paramsCallback: async ({ lsigParams, args, lsigsFee }) => {
        group.signalsAndProof({ ...lsigParams, args });
        group.addTransaction(
          await algorand.createTransaction.payment({
            sender,
            receiver: sender,
            amount: microAlgos(0),
            extraFee: lsigsFee,
            note: `poc-phase1-${Date.now()}`,
          }),
        );
      },
    });
    const result = await group.send();
    expect(result.txIds.length).toBe(7);
  });
});
