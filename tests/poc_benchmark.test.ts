import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import algosdk from "algosdk";
import { AlgorandClient, microAlgos } from "@algorandfoundation/algokit-utils";
import * as snarkjs from "snarkjs";
import {
  encodeGroth16Bn254Proof,
  Groth16Bn254AppVerifier,
  Groth16Bn254LsigVerifier,
} from "../src/groth16";
import { Groth16Bn254SignalsAndProofFactory } from "../contracts/clients/Groth16Bn254SignalsAndProof";

const root = resolve(process.cwd(), "../..");
const scenarios = [
  { count: 1, dir: resolve(root, "fixtures/benchmark/1"), stem: "bench_1" },
  { count: 2, dir: resolve(root, "fixtures/phase1"), stem: "square_chain_2" },
  { count: 7, dir: resolve(root, "fixtures/benchmark/7"), stem: "bench_7" },
] as const;
const readJson = (dir: string, name: string) =>
  JSON.parse(readFileSync(resolve(dir, name), "utf8"));

describe("Phase 2: LocalNet verifier benchmark", () => {
  const algorand = AlgorandClient.defaultLocalNet();
  let curve: any;

  beforeAll(async () => {
    // @ts-expect-error snarkjs does not type curves
    curve = await snarkjs.curves.getCurveFromName("bn128");
  });

  afterAll(async () => {
    await curve?.terminate();
  });

  it("measures and confirms one, two, and seven public signals", async () => {
    const sender = await algorand.account.localNetDispenser();
    const node = await algorand.client.algod.getTransactionParams().do();
    const results = [];

    for (const scenario of scenarios) {
      const zKey = resolve(scenario.dir, `${scenario.stem}.zkey`);
      const wasm = resolve(
        scenario.dir,
        `${scenario.stem}_js/${scenario.stem}.wasm`,
      );
      const rawProof = readJson(scenario.dir, "proof.json");
      const rawSignals = readJson(scenario.dir, "public.json");
      expect(rawSignals).toHaveLength(scenario.count);
      expect(
        await snarkjs.groth16.verify(
          readJson(scenario.dir, "verification_key.json"),
          rawSignals,
          rawProof,
        ),
      ).toBe(true);
      const proof = encodeGroth16Bn254Proof(rawProof, curve);
      const signals = rawSignals.map((s: string) => BigInt(s));

      const app = new Groth16Bn254AppVerifier({
        algorand,
        zKey,
        wasmProver: wasm,
      });
      const beforeDeploy = await algorand.client.algod
        .accountInformation(sender.addr)
        .do();
      await app.deploy({
        appName: `poc-bench-${scenario.count}-${Date.now()}`,
        defaultSender: sender,
      });
      const afterDeploy = await algorand.client.algod
        .accountInformation(sender.addr)
        .do();
      const appId = app.appClient!.appId;
      const onChainApp = await algorand.client.algod.getApplicationByID(appId).do();
      const simulated = await app.simulateVerificationWithProofAndSignals(
        { proof, signals },
        { extraOpcodeBudget: 20_000 * 16 - 700 },
      );
      const simulation = simulated.simulateResponse.txnGroups[0]!;
      expect(simulation.failedAt).toBeUndefined();

      const factory = new Groth16Bn254SignalsAndProofFactory({
        algorand,
        defaultSender: sender,
      });
      const { appClient } = await factory.deploy({ onUpdate: "append" });
      const verifier = new Groth16Bn254LsigVerifier({
        appOffset: 0,
        totalLsigs: 6,
        algorand,
        zKey,
        wasmProver: wasm,
      });
      const verifierLogicSig = await verifier.lsigAccount();
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
              note: `poc-benchmark-${scenario.count}-${Date.now()}`,
            }),
          );
        },
      });
      const built = await (await group.composer()).build();
      const signed = await built.atc.gatherSignatures();
      const groupSimulation = await group.simulate();
      expect(groupSimulation.simulateResponse.txnGroups[0]?.failedAt).toBeUndefined();
      const started = performance.now();
      const confirmed = await group.send();
      const confirmationMs = Math.round(performance.now() - started);
      expect(confirmed.txIds).toHaveLength(7);

      const transactions = built.transactions.map(({ txn }) => txn);
      const appTxn = transactions.find((txn) => txn.applicationCall?.appArgs?.length);
      expect(appTxn).toBeDefined();
      results.push({
        publicSignals: scenario.count,
        appId: String(appId),
        confirmationTxIds: confirmed.txIds,
        circuit: scenario.stem,
        appBudgetConsumed: simulation.appBudgetConsumed,
        appBudgetAddedForSimulation: simulation.appBudgetAdded,
        confirmedGroupBudgetConsumed:
          groupSimulation.simulateResponse.txnGroups[0]?.appBudgetConsumed,
        logicSigBudgetConsumed:
          groupSimulation.simulateResponse.txnGroups[0]?.txnResults?.map(
            (txn) => txn.logicSigBudgetConsumed ?? 0,
          ),
        verifierApprovalProgramBytes: onChainApp.params.approvalProgram.length,
        verifierClearProgramBytes: onChainApp.params.clearStateProgram.length,
        verifierLogicSigProgramBytes: verifierLogicSig.account.lsig.logic.length,
        creatorMinimumBalanceIncreaseMicroAlgos: String(
          afterDeploy.minBalance - beforeDeploy.minBalance,
        ),
        verificationKeyJsonBytes: readFileSync(
          resolve(scenario.dir, "verification_key.json"),
        ).length,
        proofJsonBytes: readFileSync(resolve(scenario.dir, "proof.json")).length,
        appArgumentBytes: appTxn!.applicationCall!.appArgs.map((arg) => arg.length),
        appBoxReferenceCount: appTxn!.applicationCall!.boxes?.length ?? 0,
        confirmedInnerTransactionCount: confirmed.confirmations.reduce(
          (sum, confirmation) => sum + (confirmation.innerTxns?.length ?? 0),
          0,
        ),
        transactionCount: transactions.length,
        unsignedGroupBytes: transactions.reduce(
          (sum, txn) => sum + algosdk.encodeUnsignedTransaction(txn).length,
          0,
        ),
        signedGroupBytes: signed.reduce((sum, txn) => sum + txn.length, 0),
        totalFeeMicroAlgos: String(
          transactions.reduce((sum, txn) => sum + txn.fee, 0n),
        ),
        confirmationMs,
      });
    }

    const output = resolve(root, "benchmarks/results.localnet.json");
    mkdirSync(resolve(root, "benchmarks"), { recursive: true });
    writeFileSync(
      output,
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          upstreamCommit: "3a970c7fb47efadd60c0b09a3200e8428ac47df2",
          network: "LocalNet",
          genesisId: node.genesisID,
          consensusVersion: node.consensusVersion,
          minimumFeeMicroAlgos: String(node.minFee),
          note: "Standalone verifier benchmarks; no wallet or registry calls.",
          results,
        },
        null,
        2,
      ) + "\n",
    );
    expect(results).toHaveLength(3);
  });
});
