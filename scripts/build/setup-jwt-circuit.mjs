import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  mkdirSync,
  statSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import * as snarkjs from "../../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";
import { DEFAULT_PROVIDER, providerById } from "../../packages/protocol/src/oidc-providers.mjs";

const path = (relative) => new URL(`../../${relative}`, import.meta.url).pathname;
// Usage: setup-jwt-circuit.mjs [provider]. Each provider's circuit gets its
// own development key in its fixtures directory (oidc-providers.mjs).
const provider = providerById(process.argv[2] ?? DEFAULT_PROVIDER);
const layout = { fixtures: provider.circuit.directory, name: provider.circuit.name, local: provider.local, record: `benchmarks/${provider.records.setup}` };
const r1cs = path(`${layout.fixtures}/${layout.name}.r1cs`);
const ptau = path(
  "upstream/snarkjs-algorand/circuit/powersOfTau28_hez_final_22.ptau",
);
const expected =
  "0d64f63dba1a6f11139df765cb690da69d9b2f469a1ddd0de5e4aa628abb28f787f04c6a5fb84a235ec5ea7f41d0548746653ecab0559add658a83502d1cb21b";
async function hashOf(file, algorithm) {
  const hash = createHash(algorithm);
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest("hex");
}
if ((await hashOf(ptau, "blake2b512")) !== expected)
  throw new Error("Powers-of-tau digest does not match the published value");
mkdirSync(path(layout.local), { recursive: true, mode: 0o700 });
const initial = path(`${layout.local}/${layout.name}.initial.zkey`);
const contributed = path(`${layout.local}/${layout.name}.contributed.zkey`);
const final = path(`${layout.fixtures}/${layout.name}.zkey`);
let peakRss = process.memoryUsage().rss;
const monitor = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  if (peakRss > 10 * 1024 ** 3) {
    console.error(
      "Development setup exceeded the 10 GiB RSS limit on this 16 GiB machine",
    );
    process.exit(2);
  }
}, 2000);
const logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
  debug: () => {},
};
const started = performance.now();
try {
  console.log("Starting circuit-specific development setup");
  const result = await snarkjs.zKey.newZKey(r1cs, ptau, initial, logger);
  if (result === -1) throw new Error("Circuit-specific setup failed");
  console.log(
    "Applying a development contribution with unlogged OS randomness",
  );
  await snarkjs.zKey.contribute(
    initial,
    contributed,
    "Local development contribution",
    randomBytes(64).toString("hex"),
    logger,
  );
  const vkey = await snarkjs.zKey.exportVerificationKey(contributed, logger);
  if (vkey.nPublic !== 12) throw new Error("Unexpected public-input count");
  renameSync(contributed, final);
  writeFileSync(
    path(`${layout.fixtures}/verification_key.json`),
    JSON.stringify(vkey, null, 2) + "\n",
  );
  unlinkSync(initial);
  const record = {
    recordedAt: new Date().toISOString(),
    circuit: layout.name,
    developmentOnly: true,
    productionCeremony: false,
    phase2Contributions: 1,
    ptauPower: 22,
    ptauBlake2b512: expected,
    r1csSha256: await hashOf(r1cs, "sha256"),
    zkeySha256: await hashOf(final, "sha256"),
    zkeyBytes: statSync(final).size,
    setupMs: Math.round(performance.now() - started),
    peakRssBytes: peakRss,
    publicSignals: 12,
  };
  writeFileSync(
    path(layout.record),
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log(JSON.stringify(record, null, 2));
} finally {
  clearInterval(monitor);
  await globalThis.curve_bn128?.terminate();
}
