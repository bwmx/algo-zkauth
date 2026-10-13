import { mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchJwks } from "../src/phase3/id-token.mjs";
import { PROVIDERS } from "../src/phase3/oidc-providers.mjs";
import { openDemoChain } from "../upstream/snarkjs-algorand/src/phase6/chain.ts";
const root = new URL("../", import.meta.url).pathname;
for (const dir of [".local", ".local/phase6"]) { mkdirSync(`${root}${dir}`, { recursive: true, mode: 0o700 }); chmodSync(`${root}${dir}`, 0o700); }
// Records go to the published benchmarks/ unless DEMO_EVIDENCE_DIR redirects
// them, as the quickstart does so a clone's runs leave that evidence intact.
const evidence = resolve(root, process.env.DEMO_EVIDENCE_DIR ?? "benchmarks");
mkdirSync(evidence, { recursive: true });
// Each configured provider gets its own registry, key registry and demo ASA.
// Optional arguments (google, slack) limit the run to those providers.
const only = process.argv.slice(2);
if (only.some((p) => !["google", "slack"].includes(p))) throw new Error("Usage: deploy-demo.sh [google] [slack]");
const audiences = Object.entries({ google: process.env.GOOGLE_CLIENT_ID, slack: process.env.SLACK_CLIENT_ID })
  .filter(([provider, v]) => v && (!only.length || only.includes(provider)));
if (!process.env.TESTNET_MNEMONIC || !audiences.length) throw new Error("Set the local TestNet sponsor and a Google or Slack client in .env");
const records = { google: "phase6-deployment.testnet.json", slack: "slack-deployment.testnet.json" };
for (const [provider, audience] of audiences) {
  const chain = await openDemoChain({ root, mnemonic: process.env.TESTNET_MNEMONIC, audience, provider, deploy: true });
  try {
    await chain.ensureKeys(await fetchJwks(PROVIDERS[provider]));
    const record = { recordedAt: new Date().toISOString(), ...(provider === "google" ? {} : { provider }), ...chain.config(), developmentTrustedSetup: true, source: "Phase 4 immutable wallet contracts / TestNet", fundedDemoWallets: false };
    writeFileSync(`${evidence}/${records[provider]}`, JSON.stringify(record, null, 2) + "\n");
    console.log(JSON.stringify({ ready: true, provider, network: record.network, registryId: record.registryId, keyRegistryId: record.keyRegistryId, demoAssetId: record.demoAssetId }));
  } finally { await chain.close(); }
}
await globalThis.curve_bn128?.terminate();
