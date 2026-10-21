import { readFileSync, writeFileSync, statSync } from "node:fs";
import * as snarkjs from "../../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";
import { DEFAULT_PROVIDER, providerById } from "../../packages/protocol/src/oidc-providers.mjs";

// Proves the witness from prepare-witness.mjs (--genuine) or the provider's
// synthetic circuit test. Usage: prove-witness.mjs [provider] [--genuine]
const provider = providerById(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? DEFAULT_PROVIDER);
const { directory, name: circuit } = provider.circuit;
const genuine = process.argv.includes("--genuine");
const name = genuine ? provider.id : "synthetic";
const path = (relative) => new URL(`../../${relative}`, import.meta.url).pathname;
const input = JSON.parse(
  readFileSync(path(`${provider.local}/${name}-input.json`), "utf8"),
);
const expected = [
  ...input.identity,
  ...input.keyHash,
  ...input.audienceHash,
  ...input.sessionKey,
  ...input.genesisHash,
  input.sessionExpiresAt,
  input.notBefore,
].map(String);
if (genuine && input.sessionExpiresAt <= Math.floor(Date.now() / 1000))
  throw new Error(
    `The captured ${provider.label} session expired; obtain a fresh capture before proving`,
  );
const key = JSON.parse(
  readFileSync(path(`${directory}/verification_key.json`), "utf8"),
);
const started = performance.now();
let peakRss = process.memoryUsage().rss;
const monitor = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 1000);
try {
  const { proof, publicSignals } = await snarkjs.groth16.prove(
    path(`${directory}/${circuit}.zkey`),
    path(`${provider.local}/${name}.wtns`),
    undefined,
    { singleThread: true },
  );
  const proveMs = Math.round(performance.now() - started);
  if (JSON.stringify(publicSignals) !== JSON.stringify(expected))
    throw new Error("Proof has unexpected public signals");
  if (!(await snarkjs.groth16.verify(key, publicSignals, proof)))
    throw new Error("Independent Groth16 verification failed");
  const altered = [
    (BigInt(publicSignals[0]) + 1n).toString(),
    ...publicSignals.slice(1),
  ];
  if (await snarkjs.groth16.verify(key, altered, proof))
    throw new Error("Altered public signal was accepted");
  writeFileSync(
    path(`${provider.local}/${name}-proof.json`),
    JSON.stringify(proof, null, 2) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path(`${provider.local}/${name}-public.json`),
    JSON.stringify(publicSignals, null, 2) + "\n",
    { mode: 0o600 },
  );
  const record = {
    recordedAt: new Date().toISOString(),
    [`genuine${provider.label}Token`]: genuine,
    publicSignals: 12,
    proveMs,
    peakRssBytes: peakRss,
    zkeyBytes: statSync(path(`${directory}/${circuit}.zkey`)).size,
    independentVerificationPassed: true,
    alteredPublicSignalRejected: true,
    sessionStillActive: genuine
      ? input.sessionExpiresAt > Math.floor(Date.now() / 1000)
      : null,
    acceptedOnChain: false,
  };
  writeFileSync(
    path(`benchmarks/${genuine ? provider.records.proof : provider.records.syntheticProof}`),
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log(JSON.stringify(record, null, 2));
} finally {
  clearInterval(monitor);
  await globalThis.curve_bn128?.terminate();
}
