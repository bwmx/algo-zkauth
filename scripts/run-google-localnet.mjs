import { spawn } from "node:child_process";
import { copyFileSync } from "node:fs";
import { AlgorandClient } from "../upstream/snarkjs-algorand/node_modules/@algorandfoundation/algokit-utils/index.mjs";
const root = new URL("../", import.meta.url).pathname;
const algorand = AlgorandClient.defaultLocalNet();
const params = await algorand.client.algod.getTransactionParams().do();
const status = await algorand.client.algod.status().do();
const block = await algorand.client.algod.block(status.lastRound).do();
const env = {
  ...process.env,
  SYNTHETIC_GENESIS_HASH: Buffer.from(params.genesisHash).toString("base64url"),
  SYNTHETIC_IAT: String(block.block.header.timestamp),
};
async function run(command, args, cwd = root) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Phase 3 LocalNet command exited ${code}`)),
    );
  });
}
await run(process.execPath, [
  "--max-old-space-size=6000",
  "--test",
  "tests/google-circuit-witness.test.mjs",
]);
await run(process.execPath, [
  "--max-old-space-size=6000",
  "scripts/prove-google-witness.mjs",
]);
copyFileSync(
  `${root}tests/google_authorization.test.ts`,
  `${root}upstream/snarkjs-algorand/__test__/google_authorization.test.ts`,
);
await run(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "__test__/google_authorization.test.ts",
    "--silent",
  ],
  `${root}upstream/snarkjs-algorand`,
);
