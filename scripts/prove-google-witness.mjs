import { readFileSync, writeFileSync, statSync } from "node:fs";
import * as snarkjs from "../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";

const genuine = process.argv.includes("--google");
const name = genuine ? "google" : "synthetic";
const path = (relative) => new URL(`../${relative}`, import.meta.url).pathname;
const input = JSON.parse(
  readFileSync(path(`.local/phase3/${name}-input.json`), "utf8"),
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
    "The captured Google session expired; obtain a fresh capture before proving",
  );
const key = JSON.parse(
  readFileSync(path("fixtures/phase3/verification_key.json"), "utf8"),
);
const started = performance.now();
let peakRss = process.memoryUsage().rss;
const monitor = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 1000);
try {
  const { proof, publicSignals } = await snarkjs.groth16.prove(
    path("fixtures/phase3/google_jwt.zkey"),
    path(`.local/phase3/${name}.wtns`),
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
    path(`.local/phase3/${name}-proof.json`),
    JSON.stringify(proof, null, 2) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    path(`.local/phase3/${name}-public.json`),
    JSON.stringify(publicSignals, null, 2) + "\n",
    { mode: 0o600 },
  );
  const record = {
    recordedAt: new Date().toISOString(),
    genuineGoogleToken: genuine,
    publicSignals: 12,
    proveMs,
    peakRssBytes: peakRss,
    zkeyBytes: statSync(path("fixtures/phase3/google_jwt.zkey")).size,
    independentVerificationPassed: true,
    alteredPublicSignalRejected: true,
    sessionStillActive: genuine
      ? input.sessionExpiresAt > Math.floor(Date.now() / 1000)
      : null,
    acceptedOnChain: false,
  };
  writeFileSync(
    path(`benchmarks/phase3-proof.${name}.json`),
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log(JSON.stringify(record, null, 2));
} finally {
  clearInterval(monitor);
  await globalThis.curve_bn128?.terminate();
}
