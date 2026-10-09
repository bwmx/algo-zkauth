import { mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { fetchGoogleJwks } from "../src/phase3/google-id-token.mjs";
import { openDemoChain } from "../upstream/snarkjs-algorand/src/phase6/chain.ts";
const root = new URL("../", import.meta.url).pathname;
for (const dir of [".local", ".local/phase6"]) { mkdirSync(`${root}${dir}`, { recursive: true, mode: 0o700 }); chmodSync(`${root}${dir}`, 0o700); }
if (!process.env.TESTNET_MNEMONIC || !process.env.GOOGLE_CLIENT_ID) throw new Error("Set the local TestNet sponsor and Google client in .env");
const chain = await openDemoChain({ root, mnemonic: process.env.TESTNET_MNEMONIC, audience: process.env.GOOGLE_CLIENT_ID, deploy: true });
try {
  await chain.ensureGoogleKeys(await fetchGoogleJwks());
  const record = { recordedAt: new Date().toISOString(), ...chain.config(), developmentTrustedSetup: true, source: "Phase 4 immutable wallet contracts / TestNet", fundedDemoWallets: false };
  writeFileSync(`${root}benchmarks/phase6-deployment.testnet.json`, JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify({ ready: true, network: record.network, registryId: record.registryId, keyRegistryId: record.keyRegistryId, demoAssetId: record.demoAssetId }));
} finally { await chain.close(); await globalThis.curve_bn128?.terminate(); }
