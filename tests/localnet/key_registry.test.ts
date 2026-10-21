import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AlgorandClient, microAlgos } from "@algorandfoundation/algokit-utils";
import {
  KeyRegistryFactory,
  type KeyRegistryClient,
} from "../contracts/clients/KeyRegistry";

const rejection =
  /assert|logic eval|rejected|Administrator|Invalid key interval|Key already|Key inactive|Session expired|Session outlives|Session not yet active|Session exceeds maximum duration|Cannot extend|Key revoked|Rekey forbidden|approval delay|Guardian|guardian|Renewal must extend/i;
const root = resolve(process.cwd(), "../..");
const DELAY = 86400n;
const hash = (n: number) => new Uint8Array(32).fill(n);
const boxes = (keyHash: Uint8Array) => [
  Buffer.concat([Buffer.from("gk:"), keyHash]),
];

describe.sequential("Key registry execution policy", () => {
  const algorand = AlgorandClient.defaultLocalNet();
  let client: KeyRegistryClient;
  let factory: KeyRegistryFactory;
  let administrator: Awaited<
    ReturnType<typeof algorand.account.localNetDispenser>
  >;
  let outsider: ReturnType<typeof algorand.account.random>;
  let guardian: ReturnType<typeof algorand.account.random>;
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
    guardian = algorand.account.random();
    for (const account of [outsider, guardian])
      await algorand.account.ensureFunded(
        account,
        administrator,
        microAlgos(1_000_000),
      );
    factory = new KeyRegistryFactory({
      algorand,
      defaultSender: administrator,
    });
    ({ appClient: client } = await factory.send.create.createApplication({
      args: { guardian: guardian.addr.toString() },
    }));
    await algorand.send.payment({
      sender: administrator,
      receiver: client.appAddress,
      amount: microAlgos(1_000_000),
    });
    now = await nodeTime();
  });

  it("requires a guardian distinct from the administrator", async () => {
    await expect(
      factory.send.create.createApplication({
        args: { guardian: administrator.addr.toString() },
      }),
    ).rejects.toThrow(/Guardian must differ/);
    await expect(
      factory.send.create.createApplication({
        args: { guardian: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ" },
      }),
    ).rejects.toThrow(/Guardian required/);
    expect(await client.state.global.guardian()).toBe(guardian.addr.toString());
    passedPolicyChecks++;
  });

  it("rejects absent keys, unauthorized updates, and malformed intervals", async () => {
    expect(await valid(hash(1))).toBe(false);
    for (const sender of [outsider, guardian])
      await expect(
        client.send.registerKey({
          sender,
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

  it("registers immediately during bootstrap but accepts no key until sealed", async () => {
    for (const n of [1, 2, 4]) {
      await client.send.registerKey({
        args: { keyHash: hash(n), validFrom: now, validUntil: now + 3600n },
        boxReferences: boxes(hash(n)),
      });
      expect(await valid(hash(n))).toBe(false);
    }
    await client.send.registerKey({
      args: {
        keyHash: hash(3),
        validFrom: now + 1800n,
        validUntil: now + 3600n,
      },
      boxReferences: boxes(hash(3)),
    });
    for (const sender of [outsider, guardian])
      await expect(client.send.sealBootstrap({ sender })).rejects.toThrow(
        rejection,
      );
    await client.send.sealBootstrap();
    expect(await client.state.global.sealed()).toBe(1n);
    passedPolicyChecks++;
  });

  it("allows overlapping rotation windows and rejects future activation", async () => {
    expect(await valid(hash(1))).toBe(true);
    expect(await valid(hash(2))).toBe(true);
    expect(await valid(hash(3))).toBe(false);
    await expect(
      client.send.registerKey({
        args: { keyHash: hash(1), validFrom: now + DELAY + 60n, validUntil: now + DELAY + 7200n },
        boxReferences: boxes(hash(1)),
      }),
    ).rejects.toThrow(/Key already registered/);
    passedPolicyChecks++;
  });

  it("delays new keys and renewals after sealing, and lets the guardian veto them", async () => {
    const current = await nodeTime();
    await expect(
      client.send.registerKey({
        args: { keyHash: hash(5), validFrom: current, validUntil: current + DELAY * 2n },
        boxReferences: boxes(hash(5)),
      }),
    ).rejects.toThrow(/Key activation inside approval delay/);
    for (const n of [5, 6])
      await client.send.registerKey({
        args: { keyHash: hash(n), validFrom: current + DELAY + 60n, validUntil: current + DELAY * 8n },
        boxReferences: boxes(hash(n)),
      });
    expect(await valid(hash(5))).toBe(false);
    await expect(
      client.send.assertKeyValid({
        args: { keyHash: hash(5), sessionExpiresAt: current + 600n },
        boxReferences: boxes(hash(5)),
      }),
    ).rejects.toThrow(/Key inactive/);
    // A pending registration is vetoed by permanent revocation.
    await expect(
      client.send.revokeKey({ sender: outsider, args: { keyHash: hash(6) }, boxReferences: boxes(hash(6)) }),
    ).rejects.toThrow(/Administrator or guardian required/);
    await client.send.revokeKey({ sender: guardian, args: { keyHash: hash(6) }, boxReferences: boxes(hash(6)) });
    expect((await client.state.box.keys.value(hash(6)))?.revoked).toBe(true);

    // A renewal is pending: the old interval still bounds sessions.
    for (const sender of [outsider, guardian])
      await expect(
        client.send.renewKey({ sender, args: { keyHash: hash(4), validUntil: now + DELAY * 3n }, boxReferences: boxes(hash(4)) }),
      ).rejects.toThrow(rejection);
    await expect(
      client.send.renewKey({ args: { keyHash: hash(4), validUntil: now + 3600n }, boxReferences: boxes(hash(4)) }),
    ).rejects.toThrow(/Renewal must extend key interval/);
    await client.send.renewKey({ args: { keyHash: hash(4), validUntil: now + DELAY * 3n }, boxReferences: boxes(hash(4)) });
    const pending = await client.state.box.keys.value(hash(4));
    expect(pending?.validUntil).toBe(now + 3600n);
    expect(pending?.renewedUntil).toBe(now + DELAY * 3n);
    expect(pending!.renewalEffectiveAt).toBeGreaterThanOrEqual(current + DELAY);
    expect(await valid(hash(4))).toBe(true);
    await expect(
      client.send.renewKey({ args: { keyHash: hash(6), validUntil: now + DELAY * 9n }, boxReferences: boxes(hash(6)) }),
    ).rejects.toThrow(/Key revoked/);
    await expect(
      client.send.cancelRenewal({ sender: outsider, args: { keyHash: hash(4) }, boxReferences: boxes(hash(4)) }),
    ).rejects.toThrow(rejection);
    await client.send.cancelRenewal({ sender: guardian, args: { keyHash: hash(4) }, boxReferences: boxes(hash(4)) });
    const cancelled = await client.state.box.keys.value(hash(4));
    expect([cancelled?.renewedUntil, cancelled?.renewalEffectiveAt]).toEqual([0n, 0n]);
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
    await expect(
      client.send.retireKey({
        sender: guardian,
        args: { keyHash: hash(1), validUntil: now },
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
        args: { keyHash: hash(2), validFrom: now + DELAY + 60n, validUntil: now + DELAY * 2n },
        boxReferences: boxes(hash(2)),
      }),
    ).rejects.toThrow(/Key already registered/);
    await expect(
      client.send.retireKey({
        args: { keyHash: hash(2), validUntil: now + 1800n },
        boxReferences: boxes(hash(2)),
      }),
    ).rejects.toThrow(rejection);
    passedPolicyChecks++;
  });

  it("lets either role pause but only the administrator resume", async () => {
    await expect(
      client.send.setPaused({ sender: outsider, args: { paused: true } }),
    ).rejects.toThrow(rejection);
    await client.send.setPaused({ sender: guardian, args: { paused: true } });
    expect(await valid(hash(4))).toBe(false);
    await expect(
      client.send.assertKeyValid({
        args: { keyHash: hash(4), sessionExpiresAt: now + 600n },
        boxReferences: boxes(hash(4)),
      }),
    ).rejects.toThrow(rejection);
    await expect(
      client.send.setPaused({ sender: guardian, args: { paused: false } }),
    ).rejects.toThrow(/Administrator required/);
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
          "contracts/out/KeyRegistry.approval.teal",
          "utf8",
        ),
        clearStateProgram: readFileSync(
          "contracts/out/KeyRegistry.clear.teal",
          "utf8",
        ),
      }),
    ).rejects.toThrow(rejection);
    await expect(
      client.send.setPaused({ args: { paused: true }, rekeyTo: outsider.addr }),
    ).rejects.toThrow(rejection);
    await expect(
      client.send.setPaused({ sender: guardian, args: { paused: true }, rekeyTo: outsider.addr }),
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
    expect(passedPolicyChecks).toBe(11);
    const app = await algorand.client.algod
      .getApplicationByID(client.appId)
      .do();
    const account = await algorand.client.algod
      .accountInformation(client.appAddress)
      .do();
    expect(account.minBalance).toBe(100_000n + 6n * (2500n + 400n * 68n));
    writeFileSync(
      resolve(root, "benchmarks/phase3-key-registry.localnet.json"),
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          appId: String(client.appId),
          approvalBytes: app.params.approvalProgram.length,
          clearBytes: app.params.clearStateProgram.length,
          keyCount: 6,
          boxNameBytes: 35,
          boxValueBytes: 33,
          appMinimumBalanceMicroAlgos: String(account.minBalance),
          approvalDelaySeconds: Number(DELAY),
          policyTestsPassedBeforeRecord: 11,
          delayElapsedTested: false,
          contractCompiler: "puya-ts 1.2.0-beta.26 / puya 5.8.0",
          proofIntegrationTested: false,
        },
        null,
        2,
      ) + "\n",
    );
  });
});
