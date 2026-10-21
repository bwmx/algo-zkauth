// Moves LocalNet's block clock forward past the approval delay. Block time cannot
// move back, so run this last (scripts/run-key-delay-localnet.sh) and reset
// LocalNet before other LocalNet suites.
import { expect, it } from "vitest";
import { AlgorandClient, microAlgos } from "@algorandfoundation/algokit-utils";
import { KeyRegistryFactory } from "../contracts/clients/KeyRegistry";

const DELAY = 86400n;
const hash = (n: number) => new Uint8Array(32).fill(n);
const boxes = (keyHash: Uint8Array) => [Buffer.concat([Buffer.from("gk:"), keyHash])];

it("applies a delayed registration and renewal once the approval delay has passed", async () => {
  const algorand = AlgorandClient.defaultLocalNet();
  const administrator = await algorand.account.localNetDispenser();
  const guardian = algorand.account.random();
  const time = async () => {
    const status = await algorand.client.algod.status().do();
    return (await algorand.client.algod.block(status.lastRound).do()).block.header.timestamp;
  };
  const offset = async (seconds: bigint) => {
    const response = await fetch(`http://localhost:4001/v2/devmode/blocks/offset/${seconds}`, { method: "POST", headers: { "X-Algo-API-Token": "a".repeat(64) } });
    expect(response.status).toBe(200);
  };
  const { appClient: keys } = await new KeyRegistryFactory({ algorand, defaultSender: administrator })
    .send.create.createApplication({ args: { guardian: guardian.addr.toString() } });
  await algorand.send.payment({ sender: administrator, receiver: keys.appAddress, amount: microAlgos(1_000_000) });
  const valid = async (n: number) => (await keys.send.isKeyValid({ args: { keyHash: hash(n) }, boxReferences: boxes(hash(n)), note: `${n}-${Math.random()}` })).return;
  const now = await time();
  await keys.send.registerKey({ args: { keyHash: hash(1), validFrom: now, validUntil: now + 3600n }, boxReferences: boxes(hash(1)) });
  await keys.send.sealBootstrap();
  await keys.send.registerKey({ args: { keyHash: hash(2), validFrom: now + DELAY + 60n, validUntil: now + DELAY * 8n }, boxReferences: boxes(hash(2)) });
  await keys.send.renewKey({ args: { keyHash: hash(1), validUntil: now + DELAY * 3n }, boxReferences: boxes(hash(1)) });
  expect([await valid(1), await valid(2)]).toEqual([true, false]);

  await offset(DELAY + 600n);
  await algorand.send.payment({ sender: administrator, receiver: administrator, amount: microAlgos(0), note: "advance" });
  await offset(0n);
  const later = await time();
  expect(later).toBeGreaterThan(now + 3600n);
  // The pending key is now active and the renewal has replaced key 1's old end.
  expect([await valid(1), await valid(2)]).toEqual([true, true]);
  await keys.send.assertKeyValid({ args: { keyHash: hash(1), sessionExpiresAt: later + 300n }, boxReferences: boxes(hash(1)) });
  await keys.send.assertKeyValid({ args: { keyHash: hash(2), sessionExpiresAt: later + 300n }, boxReferences: boxes(hash(2)) });
});
