import { mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchJwks } from "../src/phase3/id-token.mjs";
import { PROVIDERS, configuredAudiences, providerEnvName } from "../src/phase3/oidc-providers.mjs";
import { mnemonicToSecretKey } from "../upstream/snarkjs-algorand/node_modules/algosdk/dist/esm/index.js";
import { openDemoChain } from "../upstream/snarkjs-algorand/src/phase6/chain.ts";
const root = new URL("../", import.meta.url).pathname;
for (const dir of [".local", ".local/phase6"]) { mkdirSync(`${root}${dir}`, { recursive: true, mode: 0o700 }); chmodSync(`${root}${dir}`, 0o700); }
// Records go to the published benchmarks/ unless DEMO_EVIDENCE_DIR redirects
// them, as the quickstart does so a clone's runs leave that evidence intact.
const evidence = resolve(root, process.env.DEMO_EVIDENCE_DIR ?? "benchmarks");
mkdirSync(evidence, { recursive: true });
// Each configured provider gets its own registry, key registry and demo ASA.
// Optional provider arguments (e.g. google slack) limit the run to those providers.
const only = process.argv.slice(2);
if (only.some((p) => !Object.hasOwn(PROVIDERS, p))) throw new Error(`Usage: deploy-demo.sh [${Object.keys(PROVIDERS).join("] [")}]`);
const audiences = Object.entries(configuredAudiences(process.env, only));
if (!process.env.TESTNET_MNEMONIC || !audiences.length) throw new Error(`Set the local TestNet sponsor and a login client (${Object.values(PROVIDERS).map((p) => providerEnvName(p, "CLIENT_ID")).join(" or ")}) in .env`);
// The guardian can revoke a key, cancel a pending renewal or pause during the
// approval delay. KEY_GUARDIAN_ADDRESS names one held elsewhere; otherwise the
// quickstart's KEY_GUARDIAN_MNEMONIC account in .env is used.
const guardian = process.env.KEY_GUARDIAN_ADDRESS || (process.env.KEY_GUARDIAN_MNEMONIC && mnemonicToSecretKey(process.env.KEY_GUARDIAN_MNEMONIC).addr.toString());
for (const [provider, audience] of audiences) {
  const chain = await openDemoChain({ root, mnemonic: process.env.TESTNET_MNEMONIC, audience, provider: PROVIDERS[provider], deploy: true, guardian });
  try {
    await chain.ensureKeys(await fetchJwks(PROVIDERS[provider]));
    const record = { recordedAt: new Date().toISOString(), provider, ...chain.config(), developmentTrustedSetup: true, source: "Phase 4 immutable wallet contracts / TestNet", fundedDemoWallets: false };
    writeFileSync(`${evidence}/${PROVIDERS[provider].records.deployment}`, JSON.stringify(record, null, 2) + "\n");
    console.log(JSON.stringify({ ready: true, provider, network: record.network, registryId: record.registryId, keyRegistryId: record.keyRegistryId, demoAssetId: record.demoAssetId }));
  } finally { await chain.close(); }
}
await globalThis.curve_bn128?.terminate();
