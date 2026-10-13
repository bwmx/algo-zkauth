// Proving artifacts (proving key, witness wasm and calculator) are too large for
// git. They are published as release assets and pinned in fixtures/artifacts.json
// by size and SHA-256; the matching verification keys are committed.
//
//   node scripts/artifacts.mjs fetch [google] [slack]   download and verify
//   node scripts/artifacts.mjs check [google] [slack]   verify local files only
//   node scripts/artifacts.mjs stage <dir> [providers]  link verified files by asset name for publishing
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, linkSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = new URL("../", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(resolve(root, "fixtures/artifacts.json"), "utf8"));
// ARTIFACTS_BASE_URL serves the same pinned files from a mirror.
const baseUrl = process.env.ARTIFACTS_BASE_URL ?? manifest.baseUrl;
const mb = bytes => `${(bytes / 1e6).toFixed(0)} MB`;

function files(providers) {
  if (!providers.length) providers = ["google"];
  for (const p of providers) if (!Object.hasOwn(manifest.providers, p)) throw new Error(`Unknown provider ${p}; expected ${Object.keys(manifest.providers).join(" or ")}`);
  return providers.flatMap(p => manifest.providers[p].map(f => ({ ...f, target: resolve(root, f.path) })));
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const verified = async file => existsSync(file.target) && statSync(file.target).size === file.bytes && (await sha256(file.target)) === file.sha256;

async function download(file) {
  mkdirSync(dirname(file.target), { recursive: true });
  const partial = `${file.target}.partial`;
  let offset = existsSync(partial) ? statSync(partial).size : 0;
  if (offset >= file.bytes) { rmSync(partial); offset = 0; }
  const response = await fetch(new URL(file.asset, baseUrl), { headers: offset ? { Range: `bytes=${offset}-` } : {} });
  // A server that ignores the range sends the whole file again.
  if (response.status === 200) offset = 0;
  else if (response.status !== 206) throw new Error(`Downloading ${file.asset} from ${baseUrl} failed with HTTP ${response.status}`);
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

const [command, ...args] = process.argv.slice(2);
if (command === "fetch" || command === "check") {
  let missing = 0;
  for (const file of files(args)) {
    if (await verified(file)) { console.log(`verified ${file.path}`); continue; }
    if (command === "check") { console.error(`missing or different: ${file.path}`); missing++; continue; }
    console.log(`downloading ${file.asset} (${mb(file.bytes)})`);
    await download(file);
    console.log(`verified ${file.path}`);
  }
  if (missing) process.exit(1);
} else if (command === "stage" && args[0]) {
  const dir = resolve(root, args[0]);
  mkdirSync(dir, { recursive: true });
  for (const file of files(args.slice(1))) {
    if (!(await verified(file))) throw new Error(`${file.path} does not match fixtures/artifacts.json`);
    const target = resolve(dir, file.asset);
    if (existsSync(target)) continue;
    try { linkSync(file.target, target); } catch { copyFileSync(file.target, target); }
  }
  console.log(`staged in ${dir}`);
} else {
  console.error("Usage: node scripts/artifacts.mjs fetch|check [google] [slack]\n       node scripts/artifacts.mjs stage <dir> [google] [slack]");
  process.exit(2);
}
