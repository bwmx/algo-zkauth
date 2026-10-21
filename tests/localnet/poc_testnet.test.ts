import { expect, it } from "vitest";
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
const dir = resolve(root, "fixtures/benchmark/7");
const readJson = (name: string) =>
  JSON.parse(readFileSync(resolve(dir, name), "utf8"));

it.skipIf(!process.env.TESTNET_MNEMONIC)(
  "confirms the seven-signal proof on TestNet",
  async () => {
    const algorand = AlgorandClient.testNet();
    const mnemonic = process.env.TESTNET_MNEMONIC!.trim();
    if (mnemonic.split(/\s+/).length !== 25) {
      throw new Error(
        "This TestNet runner requires a 25-word Algo25 account mnemonic; 24-word xHD wallets need a wallet-specific account derivation path and signer",
      );
    }
    const sender = algorand.account.fromMnemonic(mnemonic);
    const node = await algorand.client.algod.getTransactionParams().do();
    expect(node.genesisID).toBe("testnet-v1.0");
    const account = await algorand.client.algod
      .accountInformation(sender.addr)
      .do();
    if (account.amount - account.minBalance < 300_000n) {
      throw new Error(
        "The TestNet account needs at least 300,000 µALGO spendable for two app deployments and proof fees",
      );
    }
    const zKey = resolve(dir, "bench_7.zkey");
    const wasmProver = resolve(dir, "bench_7_js/bench_7.wasm");
    const rawProof = readJson("proof.json");
    const rawSignals = readJson("public.json");
    expect(rawSignals).toHaveLength(7);
    expect(
      await snarkjs.groth16.verify(
        readJson("verification_key.json"),
        rawSignals,
        rawProof,
      ),
    ).toBe(true);

    // @ts-expect-error snarkjs does not type curves
    const curve = await snarkjs.curves.getCurveFromName("bn128");
    try {
      const proof = encodeGroth16Bn254Proof(rawProof, curve);
      const signals = rawSignals.map((value: string) => BigInt(value));
      const app = new Groth16Bn254AppVerifier({
        algorand,
        zKey,
        wasmProver,
      });
      await app.deploy({
        appName: `poc-testnet-7-${Date.now()}`,
        defaultSender: sender,
      });
      const simulation = await app.simulateVerificationWithProofAndSignals(
        { proof, signals },
        { extraOpcodeBudget: 20_000 * 16 - 700 },
      );
      const groupResult = simulation.simulateResponse.txnGroups[0]!;
      expect(groupResult.failedAt).toBeUndefined();
      await expect(
        app.simulateVerificationWithProofAndSignals(
          { proof, signals: [signals[0]! + 1n, ...signals.slice(1)] },
          { extraOpcodeBudget: 20_000 * 16 - 700 },
        ),
      ).rejects.toThrow();

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
        wasmProver,
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
              note: `poc-testnet-7-${Date.now()}`,
            }),
          );
        },
      });
      const built = await (await group.composer()).build();
      const signed = await built.atc.gatherSignatures();
      const started = performance.now();
      const confirmed = await group.send();
      const confirmationMs = Math.round(performance.now() - started);
      expect(confirmed.txIds).toHaveLength(7);
      const onChainConfirmation = await algorand.client.algod
        .pendingTransactionInformation(confirmed.txIds[0]!)
        .do();
      expect(onChainConfirmation.confirmedRound).toBeGreaterThan(0n);

      const invalidGroup = appClient.newGroup();
      await verifier.verificationParams({
        proof,
        signals: [signals[0]! + 1n, ...signals.slice(1)],
        composer: invalidGroup,
        paramsCallback: async ({ lsigParams, args, lsigsFee }) => {
          invalidGroup.signalsAndProof({ ...lsigParams, args });
          invalidGroup.addTransaction(
            await algorand.createTransaction.payment({
              sender,
              receiver: sender,
              amount: microAlgos(0),
              extraFee: lsigsFee,
              note: `poc-testnet-invalid-7-${Date.now()}`,
            }),
          );
        },
      });
      const invalidBuilt = await (await invalidGroup.composer()).build();
      const invalidSigned = await invalidBuilt.atc.gatherSignatures();
      let invalidNodeRejection = false;
      try {
        await algorand.client.algod.sendRawTransaction(invalidSigned).do();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toMatch(
          /logic eval error|rejected by logic|assert failed/i,
        );
        invalidNodeRejection = true;
      }
      expect(invalidNodeRejection).toBe(true);

      const transactions = built.transactions.map(({ txn }) => txn);
      const result = {
        recordedAt: new Date().toISOString(),
        genesisId: node.genesisID,
        consensusVersion: node.consensusVersion,
        publicSignals: 7,
        verifierAppId: String(app.appClient!.appId),
        proofCarryingAppId: String(appClient.appId),
        transactionIds: confirmed.txIds,
        confirmedRound: String(onChainConfirmation.confirmedRound),
        appBudgetConsumed: groupResult.appBudgetConsumed,
        alteredSignalRejectedInSimulation: true,
        alteredSignalRejectedByTestNetNode: invalidNodeRejection,
        groupSignedBytes: signed.reduce((sum, txn) => sum + txn.length, 0),
        groupTransactionCount: transactions.length,
        groupFeeMicroAlgos: String(
          transactions.reduce((sum, txn) => sum + txn.fee, 0n),
        ),
        confirmationMs,
      };
      mkdirSync(resolve(root, "benchmarks"), { recursive: true });
      writeFileSync(
        resolve(root, "benchmarks/results.testnet.json"),
        JSON.stringify(result, null, 2) + "\n",
      );
    } finally {
      await curve.terminate();
    }
  },
  180_000,
);
