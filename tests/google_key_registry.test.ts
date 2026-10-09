import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AlgorandClient, microAlgos } from "@algorandfoundation/algokit-utils";
import {
  GoogleKeyRegistryFactory,
  type GoogleKeyRegistryClient,
} from "../contracts/clients/GoogleKeyRegistry";

const rejection =
  /assert|logic eval|rejected|Administrator|Invalid key interval|Key already|Google key inactive|Session expired|Session outlives|Session not yet active|Session exceeds maximum duration|Cannot extend|Key revoked|Rekey forbidden/i;
const root = resolve(process.cwd(), "../..");
const hash = (n: number) => new Uint8Array(32).fill(n);
const boxes = (keyHash: Uint8Array) => [
  Buffer.concat([Buffer.from("gk:"), keyHash]),
];

describe.sequential("Google key registry execution policy", () => {
  const algorand = AlgorandClient.defaultLocalNet();
  let client: GoogleKeyRegistryClient;
  let administrator: Awaited<
    ReturnType<typeof algorand.account.localNetDispenser>
  >;
  let outsider: ReturnType<typeof algorand.account.random>;
  let now: bigint;
  let passedPolicyChecks = 0;

  const nodeTime = async () => {
    const status = await algorand.client.algod.status().do();
    const block = await algorand.client.algod.block(status.lastRound).do();
    return block.block.header.timestamp;
  };
  const valid = async (keyHash: Uint8Array) =>
    (
      await client.send.isKeyValid({
        args: { keyHash },
        boxReferences: boxes(keyHash),
      })
    ).return;

  beforeAll(async () => {
    administrator = await algorand.account.localNetDispenser();
    outsider = algorand.account.random();
    await algorand.account.ensureFunded(
      outsider,
      administrator,
      microAlgos(1_000_000),
    );
    const factory = new GoogleKeyRegistryFactory({
      algorand,
      defaultSender: administrator,
    });
    ({ appClient: client } = await factory.send.create.createApplication({
      args: {},
    }));
    await algorand.send.payment({
      sender: administrator,
      receiver: client.appAddress,
      amount: microAlgos(1_000_000),
    });
    now = await nodeTime();
  });

  it("rejects absent keys, unauthorized updates, and malformed intervals", async () => {
    expect(await valid(hash(1))).toBe(false);
    await expect(
      client.send.registerKey({
        sender: outsider,
        args: { keyHash: hash(1), validFrom: now, validUntil: now + 3600n },
        boxReferences: boxes(hash(1)),
      }),
    ).rejects.toThrow(rejection);
    await expect(
      client.send.registerKey({
        args: { keyHash: hash(1), validFrom: now + 10n, validUntil: now + 10n },
        boxReferences: boxes(hash(1)),
      }),
    ).rejects.toThrow(rejection);
    await expect(
      client.send.registerKey({
        args: { keyHash: hash(1), validFrom: 0n, validUntil: now },
        boxReferences: boxes(hash(1)),
      }),
    ).rejects.toThrow(rejection);
    passedPolicyChecks++;
  });

  it("allows overlapping rotation windows and rejects future activation", async () => {
    for (const n of [1, 2]) {
      await client.send.registerKey({
        args: { keyHash: hash(n), validFrom: now, validUntil: now + 3600n },
        boxReferences: boxes(hash(n)),
      });
      expect(await valid(hash(n))).toBe(true);
    }
    await client.send.registerKey({
      args: {
        keyHash: hash(3),
        validFrom: now + 1800n,
        validUntil: now + 3600n,
      },
      boxReferences: boxes(hash(3)),
    });
    expect(await valid(hash(3))).toBe(false);
    await expect(
      client.send.registerKey({
        args: { keyHash: hash(1), validFrom: now, validUntil: now + 7200n },
        boxReferences: boxes(hash(1)),
      }),
    ).rejects.toThrow(rejection);
    passedPolicyChecks++;
  });

  it("checks session expiry against execution time and key retirement", async () => {
    await client.send.assertKeyValid({
      args: { keyHash: hash(1), sessionExpiresAt: now + 600n },
      boxReferences: boxes(hash(1)),
    });
    const current = await nodeTime();
    await expect(
      client.send.assertKeyValid({
        args: { keyHash: hash(1), sessionExpiresAt: current },
        boxReferences: boxes(hash(1)),
      }),
    ).rejects.toThrow(rejection);
    await expect(
      client.send.assertKeyValid({
        args: { keyHash: hash(1), sessionExpiresAt: now + 3601n },
        boxReferences: boxes(hash(1)),
      }),
    ).rejects.toThrow(rejection);
    await expect(
      client.send.assertKeyValid({
        args: { keyHash: hash(3), sessionExpiresAt: now + 600n },
        boxReferences: boxes(hash(3)),
      }),
    ).rejects.toThrow(rejection);
    passedPolicyChecks++;
  });

  it("shortens retirement without extending or changing other keys", async () => {
    await expect(
      client.send.retireKey({
        args: { keyHash: hash(1), validUntil: now + 7200n },
        boxReferences: boxes(hash(1)),
      }),
    ).rejects.toThrow(rejection);
    await client.send.retireKey({
      args: { keyHash: hash(1), validUntil: now },
      boxReferences: boxes(hash(1)),
    });
    expect(await valid(hash(1))).toBe(false);
    expect(await valid(hash(2))).toBe(true);
    await expect(
      client.send.assertKeyValid({
        args: { keyHash: hash(1), sessionExpiresAt: now + 600n },
        boxReferences: boxes(hash(1)),
      }),
    ).rejects.toThrow(rejection);
    passedPolicyChecks++;
  });

  it("permanently revokes a key and rejects reuse of an earlier session", async () => {
    await client.send.revokeKey({
      args: { keyHash: hash(2) },
      boxReferences: boxes(hash(2)),
    });
    expect(await valid(hash(2))).toBe(false);
    await expect(
      client.send.assertKeyValid({
        args: { keyHash: hash(2), sessionExpiresAt: now + 600n },
        boxReferences: boxes(hash(2)),
      }),
    ).rejects.toThrow(rejection);
    await expect(
      client.send.registerKey({
        args: { keyHash: hash(2), validFrom: now, validUntil: now + 7200n },
        boxReferences: boxes(hash(2)),
      }),
    ).rejects.toThrow(rejection);
    await expect(
      client.send.retireKey({
        args: { keyHash: hash(2), validUntil: now + 1800n },
        boxReferences: boxes(hash(2)),
      }),
    ).rejects.toThrow(rejection);
    passedPolicyChecks++;
  });

  it("supports administrator emergency pause and resume", async () => {
    await client.send.registerKey({
      args: { keyHash: hash(4), validFrom: now, validUntil: now + 3600n },
      boxReferences: boxes(hash(4)),
    });
    await expect(
      client.send.setPaused({ sender: outsider, args: { paused: true } }),
    ).rejects.toThrow(rejection);
    await client.send.setPaused({ args: { paused: true } });
    expect(await valid(hash(4))).toBe(false);
    await expect(
      client.send.assertKeyValid({
        args: { keyHash: hash(4), sessionExpiresAt: now + 600n },
        boxReferences: boxes(hash(4)),
      }),
    ).rejects.toThrow(rejection);
    await client.send.setPaused({ args: { paused: false } });
    expect(await valid(hash(4))).toBe(true);
    expect(await valid(hash(2))).toBe(false);
    passedPolicyChecks++;
  });

  it("rejects update, delete, and rekey routes even for the creator", async () => {
    await expect(
      algorand.send.appDelete({ sender: administrator, appId: client.appId }),
    ).rejects.toThrow(rejection);
    await expect(
      algorand.send.appUpdate({
        sender: administrator,
        appId: client.appId,
        approvalProgram: readFileSync(
          "contracts/out/GoogleKeyRegistry.approval.teal",
          "utf8",
        ),
        clearStateProgram: readFileSync(
          "contracts/out/GoogleKeyRegistry.clear.teal",
          "utf8",
        ),
      }),
    ).rejects.toThrow(rejection);
    await expect(
      client.send.setPaused({ args: { paused: true }, rekeyTo: outsider.addr }),
    ).rejects.toThrow(rejection);
    expect(await valid(hash(4))).toBe(true);
    passedPolicyChecks++;
  });

  it("checks the circuit's not-before bound and maximum session duration", async () => {
    const current = await nodeTime();
    await client.send.assertAuthorizationWindow({
      args: {
        keyHash: hash(4),
        notBefore: current,
        sessionExpiresAt: current + 300n,
      },
      boxReferences: boxes(hash(4)),
    });
    await expect(
      client.send.assertAuthorizationWindow({
        args: {
          keyHash: hash(4),
          notBefore: current + 60n,
          sessionExpiresAt: current + 300n,
        },
        boxReferences: boxes(hash(4)),
      }),
    ).rejects.toThrow(/Session not yet active/);
    await expect(
      client.send.assertAuthorizationWindow({
        args: {
          keyHash: hash(4),
          notBefore: current,
          sessionExpiresAt: current + 700n,
        },
        boxReferences: boxes(hash(4)),
      }),
    ).rejects.toThrow(/Session exceeds maximum duration/);
    passedPolicyChecks++;
  });

  it("records compiled size and box minimum balance", async () => {
    expect(passedPolicyChecks).toBe(8);
    const app = await algorand.client.algod
      .getApplicationByID(client.appId)
      .do();
    const account = await algorand.client.algod
      .accountInformation(client.appAddress)
      .do();
    expect(account.minBalance).toBe(100_000n + 4n * (2500n + 400n * 52n));
    writeFileSync(
      resolve(root, "benchmarks/phase3-key-registry.localnet.json"),
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          appId: String(client.appId),
          approvalBytes: app.params.approvalProgram.length,
          clearBytes: app.params.clearStateProgram.length,
          keyCount: 4,
          boxNameBytes: 35,
          boxValueBytes: 17,
          appMinimumBalanceMicroAlgos: String(account.minBalance),
          policyTestsPassedBeforeRecord: 8,
          contractCompiler: "puya-ts 1.2.0-beta.26 / puya 5.8.0",
          proofIntegrationTested: false,
        },
        null,
        2,
      ) + "\n",
    );
  });
});
