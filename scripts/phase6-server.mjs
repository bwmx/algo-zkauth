import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, chmodSync, readFileSync, writeFileSync, existsSync, createReadStream, statSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { openDemoChain } from "../upstream/snarkjs-algorand/src/phase6/chain.ts";
import { DemoSessions } from "../src/phase6/sessions.mjs";
import { fetchGoogleJwks, parseUniqueJson } from "../src/phase3/google-id-token.mjs";
import { googleCircuitInput } from "../src/phase3/google-circuit-input.mjs";
import { fromBase64Url } from "../src/phase5/recovery.mjs";
const root = new URL("../", import.meta.url).pathname;
const origin = "http://localhost:8765";
const clientId = process.env.GOOGLE_CLIENT_ID;
if (!clientId || !process.env.TESTNET_MNEMONIC) throw new Error("Missing local TestNet/Google configuration");
for (const dir of [".local", ".local/phase6", ".local/phase6/jobs"]) { mkdirSync(`${root}${dir}`, { recursive: true, mode: 0o700 }); chmodSync(`${root}${dir}`, 0o700); }
const chain = await openDemoChain({ root, mnemonic: process.env.TESTNET_MNEMONIC, audience: clientId });
const sessions = new DemoSessions({ genesisHash: Buffer.from(chain.config().genesisHash, "base64url"), audience: clientId });
const jobs = new Map(); const plans = new Map(); let proving;
const auditKeyPath = `${root}.local/phase6/audit-key.bin`;
if (!existsSync(auditKeyPath)) writeFileSync(auditKeyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
const auditKey = readFileSync(auditKeyPath);
const identityPath = `${root}.local/phase6/audit-identities.json`;
const labels = existsSync(identityPath) ? JSON.parse(readFileSync(identityPath, "utf8")) : [];
const label = s => {
  const tag = createHmac("sha256", auditKey).update(JSON.stringify(s.identity)).digest("hex");
  let found = labels.find(v => v.tag === tag);
  if (!found) { found = { tag, label: String.fromCharCode(65 + labels.length) }; labels.push(found); writeFileSync(identityPath, JSON.stringify(labels), { mode: 0o600 }); }
  return found.label;
};
const benchmarkPath = `${root}benchmarks/phase6-demo.testnet.json`;
const benchmark = existsSync(benchmarkPath) ? JSON.parse(readFileSync(benchmarkPath, "utf8")) : { recordedAt: new Date().toISOString(), network: "testnet-v1.0", registryId: chain.config().registryId, keyRegistryId: chain.config().keyRegistryId, demoAssetId: chain.config().demoAssetId, developmentTrustedSetup: true, localNodeProver: true, browserPrivateKeyKeptLocal: true, phase5PhysicalDeviceGateDeferred: true, events: [] };
const record = event => { benchmark.events.push({ recordedAt: new Date().toISOString(), ...event }); benchmark.recordedAt = new Date().toISOString(); writeFileSync(benchmarkPath + ".tmp", JSON.stringify(benchmark, null, 2) + "\n"); renameSync(benchmarkPath + ".tmp", benchmarkPath); };
const files = new Map([
  ["/", ["web/phase6-demo/index.html", "text/html; charset=utf-8"]],
  ["/demo/", ["web/phase6-demo/index.html", "text/html; charset=utf-8"]],
  ["/demo/client.mjs", ["web/phase6-demo/client.mjs", "text/javascript; charset=utf-8"]],
  ["/demo/algosdk.min.js", ["upstream/snarkjs-algorand/node_modules/algosdk/dist/browser/algosdk.min.js", "text/javascript; charset=utf-8"]],
  ["/modules/phase6/action.mjs", ["src/phase6/action.mjs", "text/javascript; charset=utf-8"]],
  ["/modules/phase5/recovery.mjs", ["src/phase5/recovery.mjs", "text/javascript; charset=utf-8"]],
  ["/modules/phase5/passkey-prf.mjs", ["src/phase5/passkey-prf.mjs", "text/javascript; charset=utf-8"]],
]);
const send = (response, status, value) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
  response.end(JSON.stringify(value));
};
const body = async request => {
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 20_000) throw new Error("Request too large"); chunks.push(chunk); }
  return parseUniqueJson(Buffer.concat(chunks).toString("utf8"));
};
const publicError = error => {
  const m = String(error?.message ?? "");
  // Own validation errors are static messages. Never return SDK traces, request
  // JSON, token strings, witness contents or Google account identifiers.
  const prefixes = ["Session ", "Sign in ", "Login challenge", "Too many active", "Proof ", "Invalid proof", "Action ", "Invalid action", "Browser action", "Google key policy", "Wallet already", "Enroll the", "Unsupported wallet", "ALGO transfer", "Invalid demo", "No enrolled", "Opt in before", "POC funding", "First confirm", "Node rejected replay", "Unexpected replay", "Demo requires", "Backup verification", "Another proof", "Unknown proof", "Unknown action", "The selected", "Request too", "Invalid local", "Circuit ", "Token exceeds", "Token contains", "Nonce", "Google token", "Invalid Google", "Unsupported Google", "Token has", "Missing or inconsistent", "Untrusted signing", "ID token", "Signature"];
  return prefixes.some(p => m.startsWith(p)) && m.length < 180 ? m : "The local demo request failed. Check the server status and retry.";
};
const server = createServer(async (request, response) => {
  try {
    if (request.headers.host !== "localhost:8765") return send(response, 403, { error: "Invalid local host" });
    if (["GET", "HEAD"].includes(request.method) && files.has(request.url)) {
      const [file, type] = files.get(request.url); const path = resolve(root, file);
      response.writeHead(200, { "Content-Type": type, "Content-Length": statSync(path).size, "Cache-Control": "no-store", "Cross-Origin-Opener-Policy": "same-origin-allow-popups", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
      if (request.method === "HEAD") return response.end();
      const stream = createReadStream(path); response.on("close", () => stream.destroy()); stream.on("error", () => response.destroy()); return stream.pipe(response);
    }
    if (request.method === "GET" && request.url === "/demo/config") return send(response, 200, { ...chain.config(), clientId, latestTimestamp: String(await chain.time()) });
    if (request.method === "GET" && /^\/demo\/proof\/[a-f0-9-]{36}$/.test(request.url)) {
      const jobId = request.url.split("/").at(-1); const job = jobs.get(jobId);
      if (!job || request.headers["x-demo-session"] !== job.sessionId) throw new Error("Unknown proof job");
      const s = sessions.get(job.sessionId); let progress = { stage: "queued", elapsedMs: 0 };
      if (existsSync(`${job.dir}/progress.json`)) progress = JSON.parse(readFileSync(`${job.dir}/progress.json`, "utf8"));
      return send(response, 200, { ...progress, ready: !!s.proof, ...(s.proof ? { publicSignals: s.proof.publicSignals, measurement: s.proof.measurement } : {}) });
    }
    if (request.method !== "POST" || !request.url.startsWith("/demo/")) return send(response, 404, { error: "Not found" });
    if (request.headers.origin !== origin || request.headers["content-type"] !== "application/json") return send(response, 403, { error: "Invalid local origin or content type" });
    const input = await body(request);
    if (request.url === "/demo/login-start") return send(response, 200, sessions.start(input));
    if (request.url === "/demo/login") {
      const jwks = await fetchGoogleJwks(); const s = sessions.login(input.sessionId, input.token, jwks);
      await chain.ensureGoogleKeys(jwks); s.accountCase = label(s);
      record({ kind: "login", accountCase: s.accountCase, genuineGoogleToken: true, sessionExpiry: s.expiresAt, userAgent: typeof input.userAgent === "string" ? input.userAgent.slice(0, 256) : null });
      return send(response, 200, { verified: true, identity: s.identity, accountCase: s.accountCase, expiresAt: s.expiresAt });
    }
    if (request.url === "/demo/discover") {
      const s = sessions.salt(input.sessionId, input.salt); const wallet = await chain.snapshot(s.owner);
      if (input.restored === true) record({ kind: "restore-discovery", accountCase: s.accountCase, walletId: wallet.walletId, address: wallet.address, ownerAndPolicyChecked: true, physicalSecondDeviceVerified: false });
      return send(response, 200, { wallet, commitment: s.owner.toString("base64url") });
    }
    if (request.url === "/demo/wallet-binding") {
      sessions.get(input.sessionId); const commitment = fromBase64Url(input.commitment, 32);
      const wallet = await chain.snapshot(commitment); if (!wallet.enrolled) throw new Error("The selected backup has no wallet in this registry");
      return send(response, 200, { stage: "wallet", networkGenesisHash: chain.config().genesisHash, registryAppId: chain.config().registryId, walletAppId: wallet.walletId, walletAddress: wallet.address });
    }
    if (request.url === "/demo/proof") {
      if (input.backupVerified !== true) throw new Error("Backup verification is required before proving/enrollment");
      const s = sessions.salt(input.sessionId, input.salt);
      if (s.jobId) return send(response, 200, { jobId: s.jobId });
      if (proving) throw new Error("Another proof is running locally; wait for it to finish");
      const circuit = googleCircuitInput({ ...s, audience: clientId, jwks: await fetchGoogleJwks() });
      const jobId = randomUUID(); const dir = `${root}.local/phase6/jobs/${jobId}`;
      mkdirSync(dir, { mode: 0o700 }); writeFileSync(`${dir}/input.json`, JSON.stringify(circuit), { mode: 0o600 });
      s.jobId = jobId; jobs.set(jobId, { sessionId: s.id, dir });
      const child = spawn(process.execPath, ["--max-old-space-size=6000", `${root}scripts/prove-demo.mjs`, dir], { cwd: root, stdio: "ignore" }); proving = child;
      child.once("error", () => { proving = undefined; writeFileSync(`${dir}/progress.json`, JSON.stringify({ stage: "failed", elapsedMs: 0 }), { mode: 0o600 }); rmSync(`${dir}/input.json`, { force: true }); rmSync(`${dir}/proof.wtns`, { force: true }); });
      child.once("exit", code => {
        proving = undefined;
        if (code === 0 && existsSync(`${dir}/result.json`)) {
          s.proof = JSON.parse(readFileSync(`${dir}/result.json`, "utf8"));
          record({ kind: "proof", accountCase: s.accountCase, jobId, genuineGoogleToken: true, sessionStillActive: s.expiresAt > Math.floor(Date.now() / 1000), ...s.proof.measurement });
        } else {
          writeFileSync(`${dir}/progress.json`, JSON.stringify({ stage: "failed", elapsedMs: 0 }), { mode: 0o600 });
          rmSync(`${dir}/input.json`, { force: true }); rmSync(`${dir}/proof.wtns`, { force: true });
        }
      });
      return send(response, 200, { jobId });
    }
    const s = sessions.get(input.sessionId);
    if (!s.proof) throw new Error("Proof is not ready; generate a fresh proof first");
    if (request.url === "/demo/prepare") {
      const plan = await chain.prepare(s.proof, input); plans.set(plan.planId, { sessionId: s.id, action: plan, createdAt: Date.now() });
      return send(response, 200, plan);
    }
    if (request.url === "/demo/submit") {
      const pending = plans.get(input.planId);
      if (!pending || pending.sessionId !== s.id || Date.now() - pending.createdAt > 120_000) throw new Error("Unknown action plan; prepare again");
      plans.delete(input.planId);
      const signature = fromBase64Url(input.signature, 64); const result = await chain.submit(s.proof, pending.action, signature);
      s.lastExecution = { action: pending.action, signature };
      record({ kind: "action", accountCase: s.accountCase, walletId: result.wallet.walletId, address: result.wallet.address, ...result.measurement });
      return send(response, 200, result);
    }
    if (request.url === "/demo/fund" || request.url === "/demo/seed") {
      const wallet = await chain.fund(s.owner, request.url === "/demo/seed");
      record({ kind: request.url === "/demo/seed" ? "seed" : "fund", accountCase: s.accountCase, walletId: wallet.walletId, balanceMicroAlgos: wallet.balanceMicroAlgos, assets: wallet.assets }); return send(response, 200, { wallet });
    }
    if (request.url === "/demo/replay") {
      if (!s.lastExecution) throw new Error("First confirm a wallet execution before checking replay");
      const check = await chain.replay(s.proof, s.lastExecution.action, s.lastExecution.signature); record({ kind: "replay", accountCase: s.accountCase, ...check }); return send(response, 200, check);
    }
    if (request.url === "/demo/isolation") {
      if (!s.lastExecution) throw new Error("First confirm a wallet execution before checking isolation");
      const peer = benchmark.events.find(e => e.kind === "action" && e.accountCase !== s.accountCase && e.walletId !== s.lastExecution.action.walletId);
      if (!peer) return send(response, 200, { available: false });
      const check = await chain.isolation(s.proof, s.lastExecution.action, s.lastExecution.signature, peer.walletId);
      record({ kind: "isolation", accountCase: s.accountCase, ...check }); return send(response, 200, check);
    }
    return send(response, 404, { error: "Not found" });
  } catch (error) { return send(response, 400, { error: publicError(error) }); }
});
const cleanup = setInterval(() => { sessions.clean(); for (const [id,p] of plans) if (Date.now() - p.createdAt > 120_000) plans.delete(id); }, 30_000);
const stop = async () => { clearInterval(cleanup); proving?.kill("SIGTERM"); sessions.close(); server.close(); await chain.close(); await globalThis.curve_bn128?.terminate(); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
server.listen(8765, "localhost", () => console.log(`Phase 6 TestNet demo ready at ${origin}/demo/`));
