import { createServer } from "node:http";
import {
  chmodSync,
  createReadStream,
  readFileSync,
  renameSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import {
  fetchGoogleJwks,
  verifyGoogleIdToken,
} from "../src/phase3/google-id-token.mjs";
import { sessionNonce } from "../src/phase3/session-nonce.mjs";
import { googleCircuitInput } from "../src/phase3/google-circuit-input.mjs";
import { localWalletSalt } from "../src/phase3/local-salt.mjs";
import * as snarkjs from "../upstream/snarkjs-algorand/node_modules/snarkjs/main.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = 8765;
const origin = `http://localhost:${port}`;
const clientId = process.env.GOOGLE_CLIENT_ID;
if (
  !clientId ||
  !/^[\x21-\x7e]+\.apps\.googleusercontent\.com$/.test(clientId)
) {
  throw new Error(
    "Set GOOGLE_CLIENT_ID to a Web application client ID in the root .env",
  );
}

const paramsResponse = await fetch(
  "https://testnet-api.algonode.cloud/v2/transactions/params",
  {
    signal: AbortSignal.timeout(10_000),
  },
);
if (!paramsResponse.ok)
  throw new Error("Could not obtain Algorand TestNet genesis hash");
const params = await paramsResponse.json();
if (params["genesis-id"] !== "testnet-v1.0")
  throw new Error("Algod endpoint is not TestNet");
const genesisHash = Buffer.from(params["genesis-hash"], "base64");
if (genesisHash.length !== 32) throw new Error("Invalid TestNet genesis hash");
let currentCapture;
const proverRuns = new Map();
const recoveryLogins = new Map();
const proverStages = new Set([
  "worker-start",
  "library-load",
  "input-load",
  "witness",
  "key-load",
  "proof",
  "server-verification",
  "complete",
]);
const proverErrors = new Set([
  "memory-allocation",
  "resource-load",
  "prover-error",
  "worker-startup",
  "user-cancelled",
]);

function saveBrowserFailure(body) {
  if (
    !proverStages.has(body.stage) ||
    !proverErrors.has(body.errorCode) ||
    body.mode !== "single-thread" ||
    !["synthetic", "google"].includes(body.source)
  )
    throw new Error("Invalid browser failure metadata");
  const file = resolve(root, "benchmarks/phase3-browser-failures.json");
  let records = [];
  try {
    records = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  records.push({
    recordedAt: new Date().toISOString(),
    reportedByBrowser: true,
    outcome: "failed",
    requestedTokenSource: body.source,
    mode: body.mode,
    stage: body.stage,
    errorCode: body.errorCode,
    userAgent:
      typeof body.userAgent === "string" ? body.userAgent.slice(0, 256) : null,
    independentServerVerificationPassed: false,
    acceptedOnChain: false,
  });
  writeFileSync(file, JSON.stringify(records.slice(-20), null, 2) + "\n");
  if (typeof body.runId === "string") proverRuns.delete(body.runId);
}

const publicFiles = new Map([
  ["/recovery/", ["web/phase5-recovery/index.html", "text/html; charset=utf-8"]],
  ["/recovery/client.mjs", ["web/phase5-recovery/client.mjs", "text/javascript; charset=utf-8"]],
  ["/recovery/recovery.mjs", ["src/phase5/recovery.mjs", "text/javascript; charset=utf-8"]],
  ["/recovery/passkey-prf.mjs", ["src/phase5/passkey-prf.mjs", "text/javascript; charset=utf-8"]],
  ["/prover/", ["web/phase3-prover/index.html", "text/html; charset=utf-8"]],
  [
    "/prover/client.mjs",
    ["web/phase3-prover/client.mjs", "text/javascript; charset=utf-8"],
  ],
  [
    "/prover/worker.js",
    ["web/phase3-prover/worker.js", "text/javascript; charset=utf-8"],
  ],
  [
    "/prover/snarkjs.min.js",
    [
      "upstream/snarkjs-algorand/node_modules/snarkjs/build/snarkjs.min.js",
      "text/javascript; charset=utf-8",
    ],
  ],
  [
    "/prover/google_jwt.wasm",
    ["fixtures/phase3/google_jwt_js/google_jwt.wasm", "application/wasm"],
  ],
  [
    "/prover/google_jwt.zkey",
    ["fixtures/phase3/google_jwt.zkey", "application/octet-stream"],
  ],
  [
    "/prover/verification_key.json",
    ["fixtures/phase3/verification_key.json", "application/json"],
  ],
]);

async function circuitInput(source) {
  if (source === "synthetic")
    return JSON.parse(
      readFileSync(resolve(root, ".local/phase3/synthetic-input.json"), "utf8"),
    );
  if (source !== "google" || !currentCapture)
    throw new Error(
      "Capture a fresh Google token in this server session first",
    );
  if (currentCapture.expiresAt <= Math.floor(Date.now() / 1000))
    throw new Error("The captured session expired; sign in again");
  return googleCircuitInput({
    ...currentCapture,
    genesisHash,
    salt: localWalletSalt(),
    jwks: await fetchGoogleJwks(),
    audience: clientId,
  });
}

function respond(
  response,
  status,
  data,
  type = "application/json; charset=utf-8",
) {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer-when-downgrade",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(
    type.startsWith("application/json") ? JSON.stringify(data) : data,
  );
}

function localBytes(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error(`Invalid ${name}`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value)
    throw new Error(`Invalid ${name}`);
  return bytes;
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 20_000) throw new Error("Request body is too large");
  }
  return JSON.parse(body);
}

function saveLocalEnv(values) {
  const path = resolve(root, ".env");
  const temporary = resolve(root, `.env.tmp-${process.pid}`);
  const existing = readFileSync(path, "utf8").split(/\r?\n/);
  const lines = existing.filter(
    (line) => !Object.keys(values).some((key) => line.startsWith(`${key}=`)),
  );
  while (lines.at(-1) === "") lines.pop();
  for (const [key, value] of Object.entries(values))
    lines.push(`${key}=${value}`);
  writeFileSync(temporary, `${lines.join("\n")}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

const server = createServer(async (request, response) => {
  try {
    if (
      ["GET", "HEAD"].includes(request.method) &&
      publicFiles.has(request.url)
    ) {
      const [relative, type] = publicFiles.get(request.url);
      const path = resolve(root, relative);
      response.writeHead(200, {
        "Content-Type": type,
        "Content-Length": statSync(path).size,
        "Cache-Control": "no-store",
        ...(request.url.startsWith("/recovery/")
          ? { "Cross-Origin-Opener-Policy": "same-origin-allow-popups" }
          : { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" }),
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") return response.end();
      const stream = createReadStream(path);
      response.on("close", () => stream.destroy());
      stream.on("error", () => response.destroy());
      stream.pipe(response);
      return;
    }
    if (request.method === "GET" && request.url === "/recovery/config") {
      for (const [id, login] of recoveryLogins) if (login.expiresAt < Date.now()) recoveryLogins.delete(id);
      if (recoveryLogins.size >= 20) recoveryLogins.delete(recoveryLogins.keys().next().value);
      const challengeId = randomUUID();
      const nonce = randomBytes(32).toString("base64url");
      recoveryLogins.set(challengeId, { nonce, expiresAt: Date.now() + 600_000 });
      return respond(response, 200, { clientId, genesisHash: genesisHash.toString("base64url"), challengeId, nonce });
    }
    if (request.method === "POST" && request.url.startsWith("/recovery/")) {
      if (request.headers.origin !== origin || request.headers["content-type"] !== "application/json")
        return respond(response, 403, { error: "Invalid local request origin or content type" });
      const body = await readBody(request);
      if (request.url === "/recovery/identity") {
        const login = recoveryLogins.get(body.challengeId);
        recoveryLogins.delete(body.challengeId);
        if (!login || login.expiresAt < Date.now()) throw new Error("Google recovery login expired; reload and sign in again");
        const verified = verifyGoogleIdToken(body.token, { audience: clientId, nonce: login.nonce, jwks: await fetchGoogleJwks(), nowSeconds: Math.floor(Date.now() / 1000) });
        // Only verified claims return to this same-origin tab. Neither salt,
        // PRF output nor recovery secret is ever accepted by these endpoints.
        return respond(response, 200, { identity: { issuer: "https://accounts.google.com", audience: clientId, subject: verified.subject } });
      }
      if (request.url === "/recovery/result") {
        const outcomes = new Set(["setup-verified", "restore-secret", "restore-passkey", "prf-unavailable", "prf-cancelled", "prf-ready"]);
        if (Object.keys(body).some(k => !["outcome", "userAgent"].includes(k)) || !outcomes.has(body.outcome) || typeof body.userAgent !== "string") throw new Error("Invalid recovery test metadata");
        const path = resolve(root, "benchmarks/phase5-browser.json");
        let records = [];
        try { records = JSON.parse(readFileSync(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
        records.push({ recordedAt: new Date().toISOString(), reportedByBrowser: true, browserExecuted: true, userAgent: body.userAgent.slice(0, 256), outcome: body.outcome, scope: "pre-enrollment Google identity / browser-memory salt", physicalSecondDeviceVerified: false, onChainTransferVerified: false });
        writeFileSync(path, JSON.stringify(records.slice(-40), null, 2) + "\n");
        return respond(response, 200, { recorded: true });
      }
    }
    if (request.method === "POST" && request.url.startsWith("/prover/")) {
      if (
        request.headers.origin !== origin ||
        request.headers["content-type"] !== "application/json"
      )
        return respond(response, 403, {
          error: "Invalid local request origin or content type",
        });
      const body = await readBody(request);
      if (request.url === "/prover/input") {
        const input = await circuitInput(body.source);
        const now = Date.now();
        for (const [id, run] of proverRuns)
          if (now - run.startedAt > 3_600_000) proverRuns.delete(id);
        if (proverRuns.size >= 20)
          proverRuns.delete(proverRuns.keys().next().value);
        const keyText = readFileSync(
          resolve(root, "fixtures/phase3/verification_key.json"),
          "utf8",
        );
        const id = randomUUID();
        proverRuns.set(id, {
          source: body.source,
          startedAt: now,
          sessionExpiresAt: input.sessionExpiresAt,
          expected: [
            ...input.identity,
            ...input.keyHash,
            ...input.audienceHash,
            ...input.sessionKey,
            ...input.genesisHash,
            input.sessionExpiresAt,
            input.notBefore,
          ].map(String),
          key: JSON.parse(keyText),
          verificationKeySha256: createHash("sha256")
            .update(keyText)
            .digest("hex"),
        });
        response.setHeader("X-Prover-Run-Id", id);
        return respond(response, 200, input);
      }
      if (request.url === "/prover/failure") {
        saveBrowserFailure(body);
        return respond(response, 200, { recorded: true });
      }
      if (request.url === "/prover/result") {
        const run = proverRuns.get(body.runId);
        if (
          !run ||
          run.source !== body.source ||
          Date.now() - run.startedAt > 3_600_000
        )
          throw new Error("Unknown or expired browser benchmark run");
        if (body.mode !== "single-thread")
          throw new Error("Unexpected prover mode");
        if (JSON.stringify(body.publicSignals) !== JSON.stringify(run.expected))
          throw new Error("Unexpected browser proof public signals");
        if (
          !(await snarkjs.groth16.verify(
            run.key,
            body.publicSignals,
            body.proof,
          ))
        )
          throw new Error("Independent browser proof verification failed");
        if (
          !Number.isFinite(body.elapsedMs) ||
          body.elapsedMs < 0 ||
          body.elapsedMs > 3_600_000
        )
          throw new Error("Invalid benchmark time");
        for (const name of ["witnessMs", "keyLoadMs", "proveMs"])
          if (
            !Number.isFinite(body[name]) ||
            body[name] < 0 ||
            body[name] > body.elapsedMs + 5
          )
            throw new Error("Invalid benchmark stage time");
        if (body.witnessMs + body.keyLoadMs + body.proveMs > body.elapsedMs + 5)
          throw new Error("Inconsistent benchmark times");
        const record = {
          recordedAt: new Date().toISOString(),
          reportedByBrowser: true,
          genuineGoogleToken: body.source === "google",
          publicSignals: 12,
          outcome: "verified",
          proverMode: body.mode,
          keyLoadStrategy: "4-MiB bigMem pages",
          witnessMs: body.witnessMs,
          keyLoadMs: body.keyLoadMs,
          proveMs: body.proveMs,
          elapsedMs: body.elapsedMs,
          measuredMemoryBytes:
            Number.isSafeInteger(body.measuredMemoryBytes) &&
            body.measuredMemoryBytes >= 0
              ? body.measuredMemoryBytes
              : null,
          userAgent:
            typeof body.userAgent === "string"
              ? body.userAgent.slice(0, 256)
              : null,
          independentServerVerificationPassed: true,
          verificationKeySha256: run.verificationKeySha256,
          memoryMeasurement:
            "Post-proof browser API when available; not peak memory",
          sessionStillActive:
            body.source === "google"
              ? run.sessionExpiresAt > Math.floor(Date.now() / 1000)
              : null,
          acceptedOnChain: false,
          mobileTested: false,
        };
        writeFileSync(
          resolve(root, "benchmarks/phase3-browser.json"),
          JSON.stringify(record, null, 2) + "\n",
        );
        proverRuns.delete(body.runId);
        return respond(response, 200, { verified: true });
      }
    }
    if (request.method === "GET" && request.url === "/") {
      return respond(
        response,
        200,
        readFileSync(resolve(root, "web/phase3-login/index.html"), "utf8"),
        "text/html; charset=utf-8",
      );
    }
    if (request.method === "GET" && request.url === "/client.mjs") {
      return respond(
        response,
        200,
        readFileSync(resolve(root, "web/phase3-login/client.mjs"), "utf8"),
        "text/javascript; charset=utf-8",
      );
    }
    if (request.method === "GET" && request.url === "/config") {
      return respond(response, 200, {
        clientId,
        genesisHash: genesisHash.toString("base64url"),
      });
    }
    if (request.method === "POST" && request.url === "/capture") {
      if (
        request.headers.origin !== origin ||
        request.headers["content-type"] !== "application/json"
      ) {
        return respond(response, 403, {
          error: "Invalid local request origin or content type",
        });
      }
      const input = await readBody(request);
      const now = Math.floor(Date.now() / 1000);
      if (
        !Number.isSafeInteger(input.expiresAt) ||
        input.expiresAt <= now ||
        input.expiresAt > now + 600
      ) {
        throw new Error("Session expiry is outside the 10-minute window");
      }
      const expectedNonce = sessionNonce({
        genesisHash,
        sessionPublicKey: localBytes(
          input.sessionPublicKey,
          "session public key",
        ),
        expiresAt: input.expiresAt,
        randomness: localBytes(input.randomness, "session randomness"),
      });
      if (input.nonce !== expectedNonce)
        throw new Error("Session nonce does not match its binding");
      const verified = verifyGoogleIdToken(input.token, {
        audience: clientId,
        nonce: expectedNonce,
        jwks: await fetchGoogleJwks(),
        nowSeconds: now,
      });
      if (input.expiresAt > verified.expiresAt)
        throw new Error("Session outlives the Google token");
      saveLocalEnv({
        GOOGLE_CLIENT_ID: clientId,
        GOOGLE_EXPECTED_NONCE: expectedNonce,
        GOOGLE_ID_TOKEN: input.token,
        ZKLOGIN_SESSION_GENESIS_HASH: genesisHash.toString("base64url"),
        ZKLOGIN_SESSION_PUBLIC_KEY: input.sessionPublicKey,
        ZKLOGIN_SESSION_RANDOMNESS: input.randomness,
        ZKLOGIN_SESSION_EXPIRES_AT: String(input.expiresAt),
      });
      currentCapture = {
        token: input.token,
        nonce: expectedNonce,
        sessionPublicKey: localBytes(
          input.sessionPublicKey,
          "session public key",
        ),
        randomness: localBytes(input.randomness, "session randomness"),
        expiresAt: input.expiresAt,
      };
      return respond(response, 200, {
        verified: true,
        expiresAt: verified.expiresAt,
      });
    }
    return respond(response, 404, { error: "Not found" });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Local token check failed";
    return respond(response, 400, { error: message });
  }
});

server.listen(port, "localhost", () => {
  console.log(`Local Google token capture is ready at ${origin}`);
});
