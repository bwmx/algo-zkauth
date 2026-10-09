import { expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { AlgorandClient, microAlgos } from "@algorandfoundation/algokit-utils";
import * as snarkjs from "snarkjs";
import {
  encodeGroth16Bn254Proof,
  Groth16Bn254LsigVerifier,
} from "../src/groth16";
import { GoogleKeyRegistryFactory } from "../contracts/clients/GoogleKeyRegistry";
import { GoogleJwtAuthorizationFactory } from "../contracts/clients/GoogleJwtAuthorization";

const root = resolve(process.cwd(), "../..");
const network =
  process.env.GOOGLE_PROOF_NETWORK === "testnet" ? "testnet" : "localnet";
const genuine = process.env.GOOGLE_PROOF_SOURCE === "google";
const stem = genuine ? "google" : "synthetic";
const read = (file: string) =>
  JSON.parse(readFileSync(resolve(root, file), "utf8"));
const digest = (signals: bigint[], index: number) =>
  Buffer.from(
    signals
      .slice(index, index + 2)
      .map((s) => s.toString(16).padStart(32, "0"))
      .join(""),
    "hex",
  );

it(`accepts the ${stem} Google circuit proof and enforces policy on ${network}`, async () => {
  const algorand =
    network === "testnet"
      ? AlgorandClient.testNet()
      : AlgorandClient.defaultLocalNet();
  if (network === "testnet" && (!genuine || !process.env.TESTNET_MNEMONIC))
    throw new Error(
      "TestNet requires a genuine Google proof and the local test account",
    );
  const sender =
    network === "testnet"
      ? algorand.account.fromMnemonic(process.env.TESTNET_MNEMONIC!)
      : await algorand.account.localNetDispenser();
  const node = await algorand.client.algod.getTransactionParams().do();
  expect(node.genesisID).toMatch(
    network === "testnet" ? /^testnet-v1\.0$/ : /^(dockernet-v1|devnet(?:-|$))/,
  );
  const status = await algorand.client.algod.status().do();
  const block = await algorand.client.algod.block(status.lastRound).do();
  const now = block.block.header.timestamp;
  const rawProof = read(`.local/phase3/${stem}-proof.json`);
  const rawSignals = read(`.local/phase3/${stem}-public.json`);
  const signals = rawSignals.map(BigInt) as bigint[];
  expect(signals).toHaveLength(12);
  expect(digest(signals, 8)).toEqual(Buffer.from(node.genesisHash!));
  expect(signals[10]).toBeGreaterThan(now + 30n);
  expect(signals[11]).toBeLessThanOrEqual(now);
  if (genuine)
    expect(digest(signals, 4)).toEqual(
      createHash("sha256")
        .update(process.env.GOOGLE_CLIENT_ID!, "ascii")
        .digest(),
    );
  expect(
    await snarkjs.groth16.verify(
      read("fixtures/phase3/verification_key.json"),
      rawSignals,
      rawProof,
    ),
  ).toBe(true);
  const account = await algorand.client.algod
    .accountInformation(sender.addr)
    .do();
  if (account.amount - account.minBalance < 600_000n)
    throw new Error(
      "At least 600,000 µALGO spendable test funds are required for policy deployment and fees",
    );
  // @ts-expect-error snarkjs does not type curves
  const curve = await snarkjs.curves.getCurveFromName("bn128");
  try {
    const proof = encodeGroth16Bn254Proof(rawProof, curve);
    const verifier = new Groth16Bn254LsigVerifier({
      algorand,
      appOffset: 0,
      totalLsigs: 6,
      zKey: resolve(root, "fixtures/phase3/google_jwt.zkey"),
      wasmProver: resolve(
        root,
        "fixtures/phase3/google_jwt_js/google_jwt.wasm",
      ),
    });
    const lsig = await verifier.lsigAccount();
    const registryFactory = new GoogleKeyRegistryFactory({
      algorand,
      defaultSender: sender,
    });
    const { appClient: registry } =
      await registryFactory.send.create.createApplication({ args: {} });
    await algorand.send.payment({
      sender,
      receiver: registry.appAddress,
      amount: microAlgos(125_000),
    });
    const keyHash = digest(signals, 2);
    const boxName = Buffer.concat([Buffer.from("gk:"), keyHash]);
    await registry.send.registerKey({
      args: { keyHash, validFrom: now, validUntil: now + 7200n },
      boxReferences: [boxName],
    });
    const gateFactory = new GoogleJwtAuthorizationFactory({
      algorand,
      defaultSender: sender,
    });
    const { appClient: gate } = await gateFactory.send.create.createApplication(
      {
        args: {
          verifier: lsig.addr.toString(),
          keyRegistry: registry.appId,
          audience: digest(signals, 4),
        },
        appReferences: [registry.appId],
      },
    );
    await expect(
      gate.send.verifySession({ args: { signals, proof } }),
    ).rejects.toThrow(/Proof verifier required/);
    let counter = 0;
    const buildGroup = async (publicSignals: bigint[]) => {
      const group = gate.newGroup();
      await verifier.verificationParams({
        proof,
        signals: publicSignals,
        composer: group,
        paramsCallback: async ({ lsigParams, args }) => {
          group.verifySession({
            ...lsigParams,
            args,
            appReferences: [registry.appId],
            boxReferences: [{ appId: registry.appId, name: boxName }],
          });
          group.addTransaction(
            await algorand.createTransaction.payment({
              sender,
              receiver: sender,
              amount: microAlgos(0),
              extraFee: microAlgos(7000),
              note: `phase3-${network}-${Date.now()}-${counter++}`,
            }),
          );
        },
      });
      return group;
    };
    const group = await buildGroup(signals);
    const built = await (await group.composer()).build();
    const signed = await built.atc.gatherSignatures();
    const simulation = await group.simulate();
    const sim = simulation.simulateResponse.txnGroups[0]!;
    expect(sim.failedAt).toBeUndefined();
    const started = performance.now();
    const confirmed = await group.send();
    const confirmationMs = Math.round(performance.now() - started);
    const confirmation = await algorand.client.algod
      .pendingTransactionInformation(confirmed.txIds[0]!)
      .do();
    expect(confirmation.confirmedRound).toBeGreaterThan(0n);
    const rejectAtNode = async (
      candidate: Awaited<ReturnType<typeof buildGroup>>,
      pattern: RegExp,
    ) => {
      const invalidBuilt = await (await candidate.composer()).build();
      const invalidSigned = await invalidBuilt.atc.gatherSignatures();
      await expect(
        algorand.client.algod.sendRawTransaction(invalidSigned).do(),
      ).rejects.toThrow(pattern);
    };
    await rejectAtNode(
      await buildGroup([signals[0]! + 1n, ...signals.slice(1)]),
      /logic eval error|rejected by logic|assert/i,
    );
    await registry.send.revokeKey({
      args: { keyHash },
      boxReferences: [boxName],
    });
    await rejectAtNode(
      await buildGroup(signals),
      /Google key inactive|logic eval error|assert/i,
    );
    const transactions = built.transactions.map(({ txn }) => txn);
    const appTransaction = transactions.find(
      (txn) => txn.applicationCall?.appArgs?.length,
    )!;
    const onChainGate = await algorand.client.algod
      .getApplicationByID(gate.appId)
      .do();
    const record = {
      recordedAt: new Date().toISOString(),
      network,
      genuineGoogleToken: genuine,
      publicSignals: 12,
      keyRegistryAppId: String(registry.appId),
      authorizationAppId: String(gate.appId),
      verifierLogicSig: lsig.addr.toString(),
      confirmedRound: String(confirmation.confirmedRound),
      transactionIds: confirmed.txIds,
      confirmationMs,
      groupTransactionCount: transactions.length,
      innerTransactionCount: 1,
      groupFeeMicroAlgos: String(
        transactions.reduce((sum, t) => sum + t.fee, 0n),
      ),
      groupSignedBytes: signed.reduce((sum, t) => sum + t.length, 0),
      authorizationApprovalBytes: onChainGate.params.approvalProgram.length,
      verifierLogicSigProgramBytes: lsig.account.lsig.logic.length,
      appArgumentBytes: appTransaction.applicationCall!.appArgs.map(
        (arg) => arg.length,
      ),
      appBoxReferenceCount: appTransaction.applicationCall!.boxes.length,
      verificationKeySha256: createHash("sha256")
        .update(
          readFileSync(resolve(root, "fixtures/phase3/verification_key.json")),
        )
        .digest("hex"),
      appBudgetConsumed: sim.appBudgetConsumed,
      logicSigBudgetConsumed: sim.txnResults.reduce(
        (sum, result) => sum + (result.logicSigBudgetConsumed ?? 0),
        0,
      ),
      modifiedSignalRejectedByNode: true,
      validProofRejectedAfterRevocation: true,
      normalSenderBypassRejected: true,
      transfersImplemented: false,
    };
    writeFileSync(
      resolve(root, `benchmarks/phase3-authorization.${network}.json`),
      JSON.stringify(record, null, 2) + "\n",
    );
  } finally {
    await curve.terminate();
  }
}, 180_000);
