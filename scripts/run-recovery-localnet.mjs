import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AlgorandClient } from "../upstream/snarkjs-algorand/node_modules/@algorandfoundation/algokit-utils/index.mjs";
const root = new URL("../", import.meta.url).pathname;
const algorand = AlgorandClient.defaultLocalNet();
if (!/^(dockernet-v1|devnet(?:-|$))/.test((await algorand.client.algod.getTransactionParams().do()).genesisID)) throw new Error("Recovery runner requires LocalNet");
const runDir = `${root}.local/phase5/${randomUUID()}`;
mkdirSync(runDir, { recursive: true, mode: 0o700 });
chmodSync(`${root}.local`, 0o700); chmodSync(`${root}.local/phase5`, 0o700);
const env = { ...process.env, PHASE5_RUN_DIR: runDir };
const run = async (command, args, cwd = root, capture = false) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  let output = "";
  child.stdout?.on("data", data => output += data.toString());
  child.once("error", reject); child.once("exit", code => code === 0 ? resolve(output) : reject(new Error(`Recovery command failed (${command}, exit ${code})`)));
});
let originalOffset;
try { originalOffset = (await algorand.client.algod.getBlockOffsetTimestamp().do()).offset; }
catch (error) { if (error.status !== 404) throw error; }
let container;
if (originalOffset === undefined) {
  const listing = await run("docker", ["ps", "--format", "{{json .}}"], root, true);
  const candidates = listing.trim().split("\n").map(line => JSON.parse(line)).filter(item => /:4001->/.test(item.Ports) && /^algokit.*algod$/.test(item.Names));
  if (candidates.length !== 1) throw new Error("Cannot identify the existing LocalNet algod container for clock restoration");
  container = candidates[0].Names;
}
let completed = false;
try {
  await algorand.client.algod.setBlockOffsetTimestamp(0).do();
  await run(process.execPath, ["--max-old-space-size=6000", "scripts/phase5-device.mjs", "original"]);
  copyFileSync(`${root}tests/recovery-wallet.test.ts`, `${root}upstream/snarkjs-algorand/__test__/recovery-wallet.test.ts`);
  for (const phase of ["phase4", "phase5"]) mkdirSync(`${root}upstream/snarkjs-algorand/src/${phase}`, { recursive: true });
  copyFileSync(`${root}src/phase4/action.mjs`, `${root}upstream/snarkjs-algorand/src/phase4/action.mjs`);
  copyFileSync(`${root}src/phase5/recovery.mjs`, `${root}upstream/snarkjs-algorand/src/phase5/recovery.mjs`);
  await run("pnpm", ["exec", "vitest", "run", "__test__/recovery-wallet.test.ts", "--silent"], `${root}upstream/snarkjs-algorand`);
  completed = true;
} finally {
  if (originalOffset !== undefined) await algorand.client.algod.setBlockOffsetTimestamp(originalOffset).do();
  else {
    // Graceful stop clears daemon PID files before Docker reuses process IDs.
    // An abrupt restart can leave stale PIDs that terminate the startup shell.
    await run("docker", ["exec", "--user", "algorand", container, "goal", "network", "stop", "-r", "/algod"]);
    // Restore the exact existing node's in-memory clock option, retaining ledger.
    await run("docker", ["restart", container]);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { await algorand.client.algod.status().do(); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (!ready) { await run("algokit", ["localnet", "start"]); await algorand.client.algod.status().do(); }
    try { await algorand.client.algod.getBlockOffsetTimestamp().do(); throw new Error("LocalNet clock override survived restart"); }
    catch (error) { if (error.status !== 404) throw error; }
  }
  console.log("LocalNet clock restored; existing ledger retained.");
  if (completed) {
    const path = `${root}benchmarks/phase5-recovery.localnet.json`;
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.controlledLocalNetClock = true; record.originalClockRestored = true;
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  }
}
