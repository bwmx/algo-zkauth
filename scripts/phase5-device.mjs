// Two isolated client processes, not a claim of testing two physical devices.
import { generateKeyPairSync, randomBytes, createPrivateKey, sign } from "node:crypto";
import { mkdirSync, chmodSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { AlgorandClient } from "../upstream/snarkjs-algorand/node_modules/@algorandfoundation/algokit-utils/index.mjs";
import * as snarkjs from "../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";
import witnessBuilder from "../fixtures/phase3/google_jwt_js/witness_calculator.js";
import { googleCircuitInput } from "../src/phase3/google-circuit-input.mjs";
import { sessionNonce } from "../src/phase3/session-nonce.mjs";
import { generateWalletSalt, restoreRecoveryPackage, toBase64Url } from "../src/phase5/recovery.mjs";
const root = new URL("../", import.meta.url).pathname;
const runDir = process.env.PHASE5_RUN_DIR;
if (!runDir || !resolve(runDir).startsWith(resolve(root, ".local/phase5") + "/")) throw new Error("Expected an isolated Phase 5 test directory");
const mode = process.argv[2];
if (!["original", "restored"].includes(mode)) throw new Error("Expected original/restored mode");
const read = p => JSON.parse(readFileSync(`${runDir}/${p}`, "utf8"));
const write = (p, value) => writeFileSync(`${runDir}/${p}`, JSON.stringify(value), { mode: 0o600 });
const privateDir = p => { mkdirSync(`${runDir}/${p}`, { recursive: true, mode: 0o700 }); chmodSync(`${runDir}/${p}`, 0o700); };
const algorand = AlgorandClient.defaultLocalNet();
const params = await algorand.client.algod.getTransactionParams().do();
const genesisHash = Buffer.from(params.genesisHash);
const status = await algorand.client.algod.status().do();
const issuedAt = Number((await algorand.client.algod.block(status.lastRound).do()).block.header.timestamp);
let salt;
let authority;
if (mode === "original") {
  privateDir("issuer"); privateDir("original-device");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  authority = { privateKey: rsa.privateKey.export({ format: "jwk" }), jwks: { keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "phase5-localnet", alg: "RS256", use: "sig" }] }, identity: { issuer: "https://accounts.google.com", audience: "synthetic-circuit-client.apps.googleusercontent.com", subject: "123456789012345678909" } };
  write("issuer/authority.json", authority);
  salt = generateWalletSalt();
  write("original-device/identity.json", { identity: authority.identity, salt: toBase64Url(salt) });
} else {
  if (existsSync(`${runDir}/original-device`)) throw new Error("Original client state must be deleted before the restore process starts");
  privateDir("restored-device");
  authority = read("issuer/authority.json"); // Synthetic identity provider, never original client state.
  const binding = read("external/wallet-binding.json");
  const recovered = await restoreRecoveryPackage({ packageText: readFileSync(`${runDir}/external/backup.json`, "utf8"), recoverySecret: readFileSync(`${runDir}/external-secret/recovery-secret.txt`, "utf8").trim(), identity: authority.identity, expectedBinding: binding });
  salt = recovered.salt;
  write("restored-device/identity.json", { identity: authority.identity, salt: toBase64Url(salt), commitment: toBase64Url(recovered.commitment) });
}
const session = generateKeyPairSync("ed25519");
const context = { genesisHash, salt, sessionPublicKey: Buffer.from(session.publicKey.export({ format: "jwk" }).x, "base64url"), randomness: randomBytes(32), expiresAt: issuedAt + 600 };
const nonce = sessionNonce(context);
const header = { alg: "RS256", kid: "phase5-localnet", typ: "JWT" };
const claims = { iss: authority.identity.issuer, aud: authority.identity.audience, sub: authority.identity.subject, nonce, iat: issuedAt, exp: issuedAt + 3600 };
const message = [header, claims].map(v => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
const token = `${message}.${sign("RSA-SHA256", Buffer.from(message), createPrivateKey({ key: authority.privateKey, format: "jwk" })).toString("base64url")}`;
const input = googleCircuitInput({ token, jwks: authority.jwks, audience: claims.aud, nonce, ...context, nowSeconds: issuedAt + 1 });
const dir = mode === "original" ? "original-device" : "restored-device";
const started = performance.now();
try {
  const calculator = await witnessBuilder(readFileSync(`${root}fixtures/phase3/google_jwt_js/google_jwt.wasm`));
  const witness = Buffer.from(await calculator.calculateWTNSBin(input, true));
  writeFileSync(`${runDir}/${dir}/proof.wtns`, witness, { mode: 0o600 });
  const witnessMs = Math.round(performance.now() - started);
  console.log(`${mode} process: full-circuit witness ready; generating proof.`);
  const proofStarted = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.prove(`${root}fixtures/phase3/google_jwt.zkey`, `${runDir}/${dir}/proof.wtns`, undefined, { singleThread: true });
  const vk = JSON.parse(readFileSync(`${root}fixtures/phase3/verification_key.json`, "utf8"));
  if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error("Independent development proof verification failed");
  const expected = [...input.identity, ...input.keyHash, ...input.audienceHash, ...input.sessionKey, ...input.genesisHash, input.sessionExpiresAt, input.notBefore].map(String);
  if (JSON.stringify(expected) !== JSON.stringify(publicSignals)) throw new Error("Unexpected full-circuit public signals");
  write(`${dir}/session.json`, { proof, signals: publicSignals, privateKey: session.privateKey.export({ format: "jwk" }) });
  write(`${dir}/measurements.json`, { mode, processId: process.pid, witnessMs, proveMs: Math.round(performance.now() - proofStarted), verified: true, originalClientStateAbsent: !existsSync(`${runDir}/original-device`), genuineGoogleToken: false });
  console.log(`${mode} process: development proof verified.`);
} finally { salt.fill(0); await globalThis.curve_bn128?.terminate(); }
