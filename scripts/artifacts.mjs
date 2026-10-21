// Proving artifacts (proving key, witness wasm and calculator) are too large for
// git. They are published as release assets and pinned in fixtures/artifacts.json
// by size and SHA-256; the matching verification keys are committed.
//
//   node scripts/artifacts.mjs fetch [providers]        download and verify (default: the default provider)
//   node scripts/artifacts.mjs check [providers]        verify local files only
//   node scripts/artifacts.mjs stage <dir> [providers]  link verified files by asset name for publishing (default: all)
//
// fetch also installs the pinned rapidsnark prover for this platform at
// .local/bin/<platform>-<arch>/prover. The local prover uses it when present and
// otherwise falls back to snarkjs (about 20 times slower).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, existsSync, linkSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DEFAULT_PROVIDER } from "../packages/protocol/src/oidc-providers.mjs";

const root = new URL("../", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(resolve(root, "fixtures/artifacts.json"), "utf8"));
// ARTIFACTS_BASE_URL serves the same pinned files from a mirror.
const baseUrl = process.env.ARTIFACTS_BASE_URL ?? manifest.baseUrl;
const mb = bytes => `${(bytes / 1e6).toFixed(0)} MB`;

function files(providers, fallback = [DEFAULT_PROVIDER]) {
  if (!providers.length) providers = fallback;
  for (const p of providers) if (!Object.hasOwn(manifest.providers, p)) throw new Error(`Unknown provider ${p}; expected ${Object.keys(manifest.providers).join(" or ")}`);
  return providers.flatMap(p => manifest.providers[p].map(f => ({ ...f, target: resolve(root, f.path) })));
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const verified = async file => existsSync(file.target) && statSync(file.target).size === file.bytes && (await sha256(file.target)) === file.sha256;

async function download(file, from = baseUrl) {
  mkdirSync(dirname(file.target), { recursive: true });
  const partial = `${file.target}.partial`;
  let offset = existsSync(partial) ? statSync(partial).size : 0;
  if (offset >= file.bytes) { rmSync(partial); offset = 0; }
  const response = await fetch(new URL(file.asset, from), { headers: offset ? { Range: `bytes=${offset}-` } : {} });
  // A server that ignores the range sends the whole file again.
  if (response.status === 200) offset = 0;
  else if (response.status !== 206) throw new Error(`Downloading ${file.asset} from ${from} failed with HTTP ${response.status}`);
  let received = offset;
  let reported = 0;
  const progress = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      if (process.stderr.isTTY && received - reported >= 16e6) { reported = received; process.stderr.write(`\r  ${file.asset}: ${mb(received)} of ${mb(file.bytes)}`); }
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial, { flags: offset ? "a" : "w" }));
  if (process.stderr.isTTY) process.stderr.write("\n");
  if (statSync(partial).size !== file.bytes || (await sha256(partial)) !== file.sha256) {
    rmSync(partial);
    throw new Error(`${file.asset} does not match its pinned size and SHA-256; it was discarded`);
  }
  renameSync(partial, file.target);
}

// The rapidsnark release is a zip; only its prover binary is kept. The zip is
// checked against its pinned size and SHA-256 before anything is extracted, and
// the extracted binary against its own pinned SHA-256.
async function installProver() {
  const platform = `${process.platform}-${process.arch}`;
  const entry = manifest.rapidsnark?.platforms[platform];
  const dir = resolve(root, ".local/bin", platform);
  const target = resolve(dir, "prover");
  if (!entry) { console.log(`no rapidsnark build for ${platform}; proving will use snarkjs`); return false; }
  if (existsSync(target) && (await sha256(target)) === entry.proverSha256) { console.log(`verified .local/bin/${platform}/prover`); return true; }
  mkdirSync(dir, { recursive: true });
  const zip = resolve(dir, entry.asset);
  const source = { asset: entry.asset, bytes: entry.bytes, sha256: entry.sha256, target: zip };
  console.log(`downloading ${entry.asset}`);
  await download(source, manifest.rapidsnark.baseUrl); // not ARTIFACTS_BASE_URL: that mirrors only the proving artifacts
  try {
    const binary = execFileSync("unzip", ["-p", zip, entry.member], { maxBuffer: 64 * 1024 * 1024 });
    if (createHash("sha256").update(binary).digest("hex") !== entry.proverSha256) throw new Error(`${entry.member} does not match its pinned SHA-256`);
    writeFileSync(target, binary, { mode: 0o755 });
  } catch (error) {
    rmSync(target, { force: true });
    console.log(`could not extract the rapidsnark prover (${error.code === "ENOENT" ? "unzip is not installed" : error.message}); proving will use snarkjs`);
    return false;
  } finally { rmSync(zip, { force: true }); }
  chmodSync(target, 0o755);
  console.log(`installed .local/bin/${platform}/prover`);
  return true;
}

const [command, ...args] = process.argv.slice(2);
if (command === "fetch" || command === "check") {
  let missing = 0;
  for (const file of files(args.filter(a => !a.startsWith("--")))) {
    if (await verified(file)) { console.log(`verified ${file.path}`); continue; }
    if (command === "check") { console.error(`missing or different: ${file.path}`); missing++; continue; }
    console.log(`downloading ${file.asset} (${mb(file.bytes)})`);
    await download(file);
    console.log(`verified ${file.path}`);
  }
  if (command === "fetch" && !args.includes("--no-prover")) await installProver();
  if (missing) process.exit(1);
} else if (command === "stage" && args[0]) {
  const dir = resolve(root, args[0]);
  mkdirSync(dir, { recursive: true });
  for (const file of files(args.slice(1), Object.keys(manifest.providers))) {
    if (!(await verified(file))) throw new Error(`${file.path} does not match fixtures/artifacts.json`);
    const target = resolve(dir, file.asset);
    if (existsSync(target)) continue;
    try { linkSync(file.target, target); } catch { copyFileSync(file.target, target); }
  }
  console.log(`staged in ${dir}`);
} else {
  console.error(`Usage: node scripts/artifacts.mjs fetch|check [provider...]\n       node scripts/artifacts.mjs stage <dir> [provider...]\nProviders: ${Object.keys(manifest.providers).join(", ")}`);
  process.exit(2);
}
