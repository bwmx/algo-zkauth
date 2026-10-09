import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AlgorandClient } from "../upstream/snarkjs-algorand/node_modules/@algorandfoundation/algokit-utils/index.mjs";

const root = new URL("../", import.meta.url).pathname;
const algorand = AlgorandClient.defaultLocalNet();
const params = await algorand.client.algod.getTransactionParams().do();
if (!/^(dockernet-v1|devnet(?:-|$))/.test(params.genesisID)) throw new Error("Phase 4 runner requires LocalNet");
const run = async (command, args, cwd = root, capture = false) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  let output = "";
  child.stdout?.on("data", (data) => { output += data.toString(); });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`Phase 4 command failed (${command}, exit ${code})`)));
});
let originalOffset;
try { originalOffset = (await algorand.client.algod.getBlockOffsetTimestamp().do()).offset; }
catch (error) { if (error.status !== 404) throw error; }
let container;
if (originalOffset === undefined) {
  const listing = await run("docker", ["ps", "--format", "{{json .}}"], root, true);
  const candidates = listing.trim().split("\n").map((line) => JSON.parse(line))
    .filter((item) => /:4001->/.test(item.Ports) && /^algokit.*algod$/.test(item.Names));
  if (candidates.length !== 1) throw new Error("Cannot identify the existing LocalNet algod container for clock restoration");
  container = candidates[0].Names;
}
let completed = false;
try {
  await algorand.client.algod.setBlockOffsetTimestamp(0).do();
  await run(process.execPath, ["--max-old-space-size=6000", "scripts/prepare-wallet-proofs.mjs", "--controlled-clock", "--reuse"]);
  copyFileSync(`${root}tests/wallets.test.ts`, `${root}upstream/snarkjs-algorand/__test__/wallets.test.ts`);
  mkdirSync(`${root}upstream/snarkjs-algorand/src/phase4`, { recursive: true });
  copyFileSync(`${root}src/phase4/action.mjs`, `${root}upstream/snarkjs-algorand/src/phase4/action.mjs`);
  await run("pnpm", ["exec", "vitest", "run", "__test__/wallets.test.ts", "--silent"], `${root}upstream/snarkjs-algorand`);
  completed = true;
} finally {
  if (originalOffset !== undefined) {
    await algorand.client.algod.setBlockOffsetTimestamp(originalOffset).do();
  } else {
    // The API has no unset operation. Restart the same algod container (without
    // resetting its ledger) to restore the original real-clock configuration.
    await run("docker", ["restart", container]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await algorand.client.algod.status().do(); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
    }
    if (!ready) {
      // The sandbox's shell startup can exit immediately after a Docker restart.
      // AlgoKit's normal start recovers the same stopped container and ledger.
      await run("algokit", ["localnet", "start"]);
      await algorand.client.algod.status().do();
    }
    try {
      await algorand.client.algod.getBlockOffsetTimestamp().do();
      throw new Error("LocalNet clock override unexpectedly survived restart");
    } catch (error) { if (error.status !== 404) throw error; }
  }
  console.log("LocalNet clock restored; existing ledger retained.");
  if (completed) {
    const path = `${root}benchmarks/phase4-wallets.localnet.json`;
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.controlledLocalNetClock = true;
    record.originalClockRestored = true;
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  }
}
