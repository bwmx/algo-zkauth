// Development fixtures only: synthetic RSA JWTs through the complete Phase 3
// circuit. No genuine Google credential or persistent wallet salt is touched.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { AlgorandClient, microAlgos } from "../upstream/snarkjs-algorand/node_modules/@algorandfoundation/algokit-utils/index.mjs";
import * as snarkjs from "../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";
import witnessBuilder from "../fixtures/phase3/google_jwt_js/witness_calculator.js";
import { googleCircuitInput } from "../src/phase3/google-circuit-input.mjs";
import { sessionNonce } from "../src/phase3/session-nonce.mjs";

const root = new URL("../", import.meta.url).pathname;
const dir = `${root}.local/phase4`;
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const algorand = AlgorandClient.defaultLocalNet();
const controlledClock = process.argv.includes("--controlled-clock");
const params = await algorand.client.algod.getTransactionParams().do();
const genesisHash = Buffer.from(params.genesisHash);
async function nodeTime() {
  const status = await algorand.client.algod.status().do();
  return Number((await algorand.client.algod.block(status.lastRound).do()).block.header.timestamp);
}
if (process.argv.includes("--reuse")) {
  try {
    const now = await nodeTime();
    const cached = ["alice", "bob"].map((name) => JSON.parse(readFileSync(`${dir}/${name}-session.json`, "utf8")));
    if (cached.every((s) => Number(s.signals[10]) > now + 180 && Number(s.signals[10]) <= now + 600 && s.genesisHash === genesisHash.toString("base64url"))
      && (!controlledClock || Number(cached[1].signals[10]) > Number(cached[0].signals[10]))) {
      console.log("Reusing two unexpired LocalNet development proofs.");
      process.exit(0);
    }
  } catch { /* Generate fresh development fixtures. */ }
}
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "phase4-localnet", alg: "RS256", use: "sig" }] };
const audience = "synthetic-circuit-client.apps.googleusercontent.com";
const calculator = await witnessBuilder(readFileSync(`${root}fixtures/phase3/google_jwt_js/google_jwt.wasm`));
const vk = JSON.parse(readFileSync(`${root}fixtures/phase3/verification_key.json`, "utf8"));
const records = [];
try {
  for (const [index, name] of ["alice", "bob"].entries()) {
    if (controlledClock && index === 1) {
      // Separate expiries by one ledger second, without changing the test window.
      await algorand.client.algod.setBlockOffsetTimestamp(1).do();
      const payer = await algorand.account.localNetDispenser();
      await algorand.send.payment({ sender: payer, receiver: payer, amount: microAlgos(0), note: "phase4-second-session-clock" });
      await algorand.client.algod.setBlockOffsetTimestamp(0).do();
    }
    const started = performance.now();
    const issuedAt = await nodeTime();
    const session = generateKeyPairSync("ed25519");
    const context = {
      genesisHash,
      sessionPublicKey: Buffer.from(session.publicKey.export({ format: "jwk" }).x, "base64url"),
      randomness: randomBytes(32), salt: randomBytes(32), expiresAt: issuedAt + 600,
    };
    const nonce = sessionNonce(context);
    const header = { alg: "RS256", kid: "phase4-localnet", typ: "JWT" };
    const claims = { iss: "https://accounts.google.com", aud: audience, sub: `12345678901234567890${index}`, nonce, iat: issuedAt, exp: issuedAt + 3600 };
    const message = [header, claims].map((v) => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
    const token = `${message}.${sign("RSA-SHA256", Buffer.from(message), rsa.privateKey).toString("base64url")}`;
    const input = googleCircuitInput({ token, jwks, audience, nonce, ...context, nowSeconds: issuedAt + 1 });
    const witness = Buffer.from(await calculator.calculateWTNSBin(input, true));
    writeFileSync(`${dir}/${name}.wtns`, witness, { mode: 0o600 });
    const witnessMs = Math.round(performance.now() - started);
    console.log(`Identity ${index + 1}: full-circuit witness ready; generating Groth16 proof.`);
    const proofStarted = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.prove(`${root}fixtures/phase3/google_jwt.zkey`, `${dir}/${name}.wtns`, undefined, { singleThread: true });
    if (!(await snarkjs.groth16.verify(vk, publicSignals, proof))) throw new Error("Development proof verification failed");
    const expected = [...input.identity, ...input.keyHash, ...input.audienceHash, ...input.sessionKey, ...input.genesisHash, input.sessionExpiresAt, input.notBefore].map(String);
    if (JSON.stringify(expected) !== JSON.stringify(publicSignals)) throw new Error("Unexpected proof binding");
    writeFileSync(`${dir}/${name}-session.json`, JSON.stringify({ proof, signals: publicSignals, privateKey: session.privateKey.export({ format: "jwk" }), genesisHash: genesisHash.toString("base64url") }), { mode: 0o600 });
    records.push({ witnessMs, proveMs: Math.round(performance.now() - proofStarted), verified: true });
    console.log(`Identity ${index + 1}: development proof verified.`);
  }
  writeFileSync(`${root}benchmarks/phase4-proofs.localnet.json`, JSON.stringify({ recordedAt: new Date().toISOString(), genuineGoogleTokens: false, circuit: "full Google JWT / 12 signals", identities: records }, null, 2) + "\n");
} finally {
  await globalThis.curve_bn128?.terminate();
}
