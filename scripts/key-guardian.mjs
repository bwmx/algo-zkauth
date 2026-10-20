// The key-registry guardian's view of a demo deployment, and its veto actions.
//
//   sh scripts/key-guardian.sh status [provider]                  list keys; exit 1 on an alert
//   sh scripts/key-guardian.sh revoke <fingerprint> [provider]    permanently revoke a key
//   sh scripts/key-guardian.sh cancel-renewal <fingerprint> [...] drop a pending extension
//   sh scripts/key-guardian.sh pause [provider]                   stop all keys until the administrator resumes
//
// The provider (google, slack, ...) defaults to google.
//
// status needs no secrets and suits a cron job: it alerts when a key that is or
// will become valid is missing from the provider's live JWKS, which is what an
// approval by a compromised administrator would look like. The actions sign with
// KEY_GUARDIAN_MNEMONIC. Fingerprints are base64url SHA-256 of the RSA modulus.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AlgorandClient } from "../upstream/snarkjs-algorand/node_modules/@algorandfoundation/algokit-utils/index.mjs";
import { KeyRegistryFactory } from "../upstream/snarkjs-algorand/contracts/clients/KeyRegistry.ts";
import { fetchJwks } from "../src/phase3/id-token.mjs";
import { DEFAULT_PROVIDER, PROVIDERS } from "../src/phase3/oidc-providers.mjs";

const root = new URL("../", import.meta.url).pathname;
const names = Object.keys(PROVIDERS).join("|");
const usage = `Usage: key-guardian.sh status|pause [${names}] | revoke|cancel-renewal <fingerprint> [${names}]`;
const [command, ...rest] = process.argv.slice(2);
const provider = rest.find(a => Object.hasOwn(PROVIDERS, a)) ?? DEFAULT_PROVIDER;
const fingerprint = ["revoke", "cancel-renewal"].includes(command) ? rest.find(a => a !== provider) : undefined;
if (!["status", "pause", "revoke", "cancel-renewal"].includes(command) || (fingerprint === undefined) !== !["revoke", "cancel-renewal"].includes(command)) {
  console.error(usage); process.exit(2);
}
const deployment = JSON.parse(readFileSync(`${root}${PROVIDERS[provider].deployment}`, "utf8"));
const algorand = AlgorandClient.testNet();
const appId = BigInt(deployment.keyRegistryId);
const factory = new KeyRegistryFactory({ algorand });

if (command === "status") {
  const keys = factory.getAppClientById({ appId });
  const state = await keys.state.global.getAll();
  if (state.guardian === undefined) throw new Error(`Key registry ${appId} predates the guardian and approval delay; redeploy to use it`);
  const status = await algorand.client.algod.status().do();
  const now = (await algorand.client.algod.block(status.lastRound).do()).block.header.timestamp;
  const live = new Set((await fetchJwks(PROVIDERS[provider])).keys.filter(k => k.kty === "RSA" && k.n)
    .map(k => createHash("sha256").update(Buffer.from(k.n, "base64url")).digest("base64url")));
  const time = t => new Date(Number(t) * 1000).toISOString().replace(".000", "");
  console.log(`${provider} key registry ${appId}: ${state.paused ? "PAUSED" : "running"}, bootstrap ${state.sealed ? "sealed" : "NOT SEALED (keys unusable)"}, guardian ${state.guardian}`);
  let alerts = 0;
  for (const { name } of (await algorand.client.algod.getApplicationBoxes(appId).do()).boxes) {
    const box = Buffer.from(name);
    if (!box.subarray(0, 3).equals(Buffer.from("gk:"))) continue;
    const id = box.subarray(3).toString("base64url");
    const v = Buffer.from((await algorand.client.algod.getApplicationBoxByName(appId, box).do()).value);
    let [validFrom, validUntil, revoked, renewedUntil, effectiveAt] = [v.readBigUInt64BE(0), v.readBigUInt64BE(8), (v[16] & 0x80) !== 0, v.readBigUInt64BE(17), v.readBigUInt64BE(25)];
    if (effectiveAt && now >= effectiveAt) [validUntil, renewedUntil, effectiveAt] = [renewedUntil, 0n, 0n];
    const state = revoked ? "revoked" : now >= validUntil && !effectiveAt ? "expired" : now < validFrom ? `PENDING, valid from ${time(validFrom)}` : now < validUntil ? "active" : "lapsed, renewal pending";
    const renewal = effectiveAt ? `; renewal to ${time(renewedUntil)} takes effect ${time(effectiveAt)}` : "";
    const alert = !revoked && (now < validUntil || effectiveAt) && !live.has(id);
    if (alert) alerts++;
    console.log(`${alert ? "ALERT " : "      "}${id}  ${state}, until ${time(validUntil)}${renewal}${live.has(id) ? "" : "; not in the provider's current JWKS"}`);
  }
  if (alerts) console.log(`\n${alerts} key(s) that are or will become valid are not published by ${provider}. If you did not expect this, revoke them or pause the registry before they take effect.`);
  process.exit(alerts ? 1 : 0);
}

if (!process.env.KEY_GUARDIAN_MNEMONIC) throw new Error("Set KEY_GUARDIAN_MNEMONIC to sign as the guardian");
const guardian = algorand.account.fromMnemonic(process.env.KEY_GUARDIAN_MNEMONIC);
const keys = factory.getAppClientById({ appId, defaultSender: guardian });
const keyHash = fingerprint && Buffer.from(fingerprint, "base64url");
if (keyHash && keyHash.length !== 32) throw new Error("A fingerprint is 32 bytes in base64url");
const boxReferences = keyHash ? [Buffer.concat([Buffer.from("gk:"), keyHash])] : [];
if (command === "pause") await keys.send.setPaused({ args: { paused: true } });
if (command === "revoke") await keys.send.revokeKey({ args: { keyHash }, boxReferences });
if (command === "cancel-renewal") await keys.send.cancelRenewal({ args: { keyHash }, boxReferences });
console.log(`${command} confirmed on ${provider} key registry ${appId}`);
