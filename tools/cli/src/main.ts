// zkauth: operate an AlgoZKAuth deployment (docs/service-architecture.md).
// Run it through tools/cli/zkauth, which supplies the TypeScript loader.
import { pathToFileURL } from "node:url";
import { ConfigError } from "../../../packages/config/src/index.ts";
import { ChainError } from "../../../packages/chain/src/errors.ts";
import { CliError, UsageError, loadContext } from "./lib.ts";
import { APPS_HELP, apps } from "./apps.ts";
import { DEPLOY_HELP, deploy } from "./deploy.ts";
import { INIT_HELP, init } from "./init.ts";
import { GUARDIAN_HELP, KEYS_HELP, guardian, keys } from "./keys.ts";
import { silenceAlgoKit } from "../../../services/keysync/src/sync.ts";
import { UP_HELP, artifacts, check, up } from "./up.ts";

const HELP = `zkauth: operate an AlgoZKAuth deployment

Usage: zkauth [--network localnet|testnet] [--state-dir <dir>] <command> [args]

Commands:
  init                          create admin, sponsor and guardian accounts; fund them (LocalNet) or say how
  deploy provider <id>          deploy a provider's verifier and key registry
  deploy app <app>              deploy an app's wallet registry
  apps add|list|remove          manage apps.json
  keys sync [provider]          register, renew and seal keys from the provider's JWKS
  keys list [provider]          show the registry's keys
  guardian status [provider]    check for unexpected keys (exit 1 on an alert; no secrets needed)
  guardian revoke <fp> [p]      revoke a key (guardian)
  guardian cancel-renewal <fp> [p]
  guardian pause [p]            stop all keys (guardian)
  artifacts fetch [providers]   download and verify the proving artifacts
  check                         run the legacy TestNet demo evidence check
  up --local                    set up a LocalNet demo from empty state (what compose \`init\` runs)

Global options (or env):
  --network <n>      ZKAUTH_NETWORK, default localnet (testnet is chosen on purpose)
  --state-dir <dir>  ZKAUTH_STATE_DIR, default .local/service
  -h, --help         help for zkauth or for a command (zkauth <command> --help)

Secrets come from the environment and from $ZKAUTH_STATE_DIR/secrets.env (written
by init); an exported variable wins. Mnemonics are never printed.

Exit codes: 0 success, 1 failure or guardian alert, 2 usage error.
Examples:  zkauth init && zkauth up --local        zkauth --network testnet init --wait`;

const HELPS: Record<string, string> = { init: INIT_HELP, deploy: DEPLOY_HELP, apps: APPS_HELP, keys: KEYS_HELP, guardian: GUARDIAN_HELP, up: UP_HELP,
  artifacts: "Usage: zkauth artifacts fetch|check [providers]\n\nRuns scripts/artifacts.mjs: downloads the proving artifacts (and the rapidsnark prover) pinned in fixtures/artifacts.json, or verifies them.\nThe default provider is google.",
  check: "Usage: zkauth check [args]\n\nRuns evidence/check-demo.sh, the legacy TestNet demo evidence check (it reads .local/phase6 records, not the zkauth state directory)." };

/** Global options may appear anywhere; they are removed before the command sees its arguments. */
function extractGlobals(argv: string[]) {
  const globals: { network?: string; stateDir?: string } = {};
  const rest: string[] = [];
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (name: string) => {
      const inline = arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined;
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`${name} needs a value`);
      return next;
    };
    if (arg === "--network" || arg.startsWith("--network=")) globals.network = value("--network");
    else if (arg === "--state-dir" || arg.startsWith("--state-dir=")) globals.stateDir = value("--state-dir");
    else if (arg === "-h" || arg === "--help") help = true;
    else rest.push(arg);
  }
  return { globals, rest, help };
}

export async function main(argv: string[]): Promise<number> {
  try {
    const { globals, rest, help } = extractGlobals(argv);
    const [command, ...args] = rest;
    if (!command || command === "help") { console.log(HELP); return command || help ? 0 : 2; }
    if (help) { console.log(HELPS[command] ?? HELP); return HELPS[command] ? 0 : 2; }
    if (!(command in HELPS)) throw new UsageError(`Unknown command "${command}"`);
    silenceAlgoKit();
    const ctx = loadContext(globals);
    switch (command) {
      case "init": return await init(ctx, args);
      case "deploy": return await deploy(ctx, args);
      case "apps": return await apps(ctx, args);
      case "keys": return await keys(ctx, args);
      case "guardian": return await guardian(ctx, args);
      case "artifacts": return await artifacts(ctx, args);
      case "check": return await check(ctx, args);
      case "up": return await up(ctx, args);
    }
    return 2;
  } catch (error) {
    if (error instanceof UsageError) { console.error(`zkauth: ${error.message}\nTry: zkauth --help`); return 2; }
    if (error instanceof CliError) { console.error(`zkauth: ${error.message}`); return error.exitCode; }
    if (error instanceof ConfigError || error instanceof ChainError) { console.error(`zkauth: ${error.message}`); return 1; }
    // Other errors come from the network or the SDK; their text names no secret.
    console.error(`zkauth: ${(error as Error)?.message ?? "unexpected error"}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
  // Worker threads and keep-alive sockets must not hold a finished command open.
  setTimeout(() => process.exit(), 50).unref();
}
