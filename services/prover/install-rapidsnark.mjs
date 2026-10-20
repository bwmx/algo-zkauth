// Installs the pinned rapidsnark prover for this platform: the Docker build's
// slim equivalent of installProver() in scripts/artifacts.mjs (which also fetches
// the 1.4 GB proving keys, kept out of the image).
//
//   node install-rapidsnark.mjs <fixtures/artifacts.json> <output root>
//
// writes <output root>/<platform>-<arch>/prover. The zip is checked against its
// pinned size and SHA-256 before extraction and the binary against its own.
// Needs the unzip command.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const [manifestPath, outputRoot] = process.argv.slice(2);
if (!manifestPath || !outputRoot) { console.error("Usage: node install-rapidsnark.mjs <artifacts.json> <output root>"); process.exit(2); }
const { rapidsnark } = JSON.parse(readFileSync(manifestPath, "utf8"));
const platform = `${process.platform}-${process.arch}`;
const entry = rapidsnark?.platforms[platform];
if (!entry) { console.error(`no pinned rapidsnark build for ${platform}`); process.exit(1); }
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const response = await fetch(new URL(entry.asset, rapidsnark.baseUrl));
if (!response.ok) { console.error(`downloading ${entry.asset} failed with HTTP ${response.status}`); process.exit(1); }
const zip = Buffer.from(await response.arrayBuffer());
if (zip.length !== entry.bytes || sha256(zip) !== entry.sha256) { console.error(`${entry.asset} does not match its pinned size and SHA-256`); process.exit(1); }
const scratch = mkdtempSync(resolve(tmpdir(), "rapidsnark-"));
let binary;
try {
  writeFileSync(resolve(scratch, entry.asset), zip);
  binary = execFileSync("unzip", ["-p", resolve(scratch, entry.asset), entry.member], { maxBuffer: 64 * 1024 * 1024 });
} finally { rmSync(scratch, { recursive: true, force: true }); }
if (sha256(binary) !== entry.proverSha256) { console.error(`${entry.member} does not match its pinned SHA-256`); process.exit(1); }
const target = resolve(outputRoot, platform, "prover");
mkdirSync(resolve(outputRoot, platform), { recursive: true });
writeFileSync(target, binary, { mode: 0o755 });
chmodSync(target, 0o755);
console.log(`installed ${target}`);
