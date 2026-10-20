// Shared plumbing for the zkauth commands: context (environment, secrets.env,
// service config), argument parsing and small formatters. Nothing here prints
// a mnemonic.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { loadServiceEnv, type ServiceEnv } from "../../../packages/config/src/index.ts";
import { openChain } from "../../../packages/chain/src/index.ts";

export class UsageError extends Error {}
/** A failure with a message for the operator and an exit code. */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) { super(message); this.exitCode = exitCode; }
}

export type Ctx = {
  /** process.env overlaid on top of secrets.env: a real environment variable wins. */
  env: NodeJS.ProcessEnv;
  service: ServiceEnv;
  secretsPath: string;
  /** Where messages go. */
  print: (line?: string) => void;
  warn: (line: string) => void;
};

export const SECRETS_FILE = "secrets.env";

// ---- secrets.env ------------------------------------------------------------

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    values[match[1]!] = value;
  }
  return values;
}

/**
 * Written bare unless that would be misread. A mnemonic (lowercase words and spaces) stays bare, which
 * `docker run --env-file` (it keeps quotes literally), `docker compose` and `node --env-file` all read alike.
 */
const formatValue = (value: string) => (/^\S(?:[^\n\r#"'\\]*\S)?$|^$/.test(value) ? value : JSON.stringify(value));

export function readSecrets(path: string): Record<string, string> {
  return existsSync(path) ? parseEnvFile(readFileSync(path, "utf8")) : {};
}

/** Adds or replaces variables in the file (mode 0600, atomically), keeping any other line as it was. */
export function writeSecrets(path: string, updates: Record<string, string>) {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : ["# zkauth secrets: account mnemonics and shared tokens. Keep this file private; never commit it."];
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const pending = new Map(Object.entries(updates));
  const next = lines.map((line) => {
    const name = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim())?.[1];
    if (name && pending.has(name)) { const value = pending.get(name)!; pending.delete(name); return `${name}=${formatValue(value)}`; }
    return line;
  });
  for (const [name, value] of pending) next.push(`${name}=${formatValue(value)}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, next.join("\n") + "\n", { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

// ---- context ----------------------------------------------------------------

export type Globals = { network?: string; stateDir?: string };

export function loadContext(globals: Globals = {}, base: NodeJS.ProcessEnv = process.env, io: Pick<Ctx, "print" | "warn"> = { print: (l = "") => console.log(l), warn: (l) => console.error(l) }): Ctx {
  const start: NodeJS.ProcessEnv = { ...base };
  if (globals.network) start.ZKAUTH_NETWORK = globals.network;
  if (globals.stateDir) start.ZKAUTH_STATE_DIR = globals.stateDir;
  // The CLI defaults to LocalNet; TestNet must be chosen on purpose.
  start.ZKAUTH_NETWORK ||= "localnet";
  const service = loadServiceEnv(start);
  const secretsPath = join(service.stateDir, SECRETS_FILE);
  const env = { ...readSecrets(secretsPath), ...start } as NodeJS.ProcessEnv;
  return { env, service: loadServiceEnv(env), secretsPath, ...io };
}

export const openCtxChain = (ctx: Ctx) =>
  openChain({ network: ctx.service.network, algodUrl: ctx.service.algodUrl, algodToken: ctx.service.algodToken, indexerUrl: ctx.service.indexerUrl, root: ctx.service.root });

/** Opens the chain for the duration of `use`, then stops its worker threads. */
export async function withChain<T>(ctx: Ctx, use: (chain: Awaited<ReturnType<typeof openCtxChain>>) => Promise<T>): Promise<T> {
  const chain = await openCtxChain(ctx);
  try { return await use(chain); } finally { await chain.close(); }
}

// ---- arguments --------------------------------------------------------------

export function parse<T extends ParseArgsConfig["options"]>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

// ---- formatting -------------------------------------------------------------

export const algo = (micro: bigint | number) => `${(Number(micro) / 1e6).toFixed(2)} ALGO`;
export const isoTime = (seconds: string | bigint) => new Date(Number(seconds) * 1000).toISOString().replace(".000", "");
