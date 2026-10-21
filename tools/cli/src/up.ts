// zkauth up --local, artifacts and check.
import { spawnSync } from "node:child_process";
import { validateApp } from "../../../packages/config/src/index.ts";
import { CliError, UsageError, loadContext, parse, type Ctx } from "./lib.ts";
import { addApp } from "./apps.ts";
import { deployApp, deployProvider } from "./deploy.ts";
import { init } from "./init.ts";
import { keys } from "./keys.ts";

export const UP_HELP = `Usage: zkauth up --local

Brings a LocalNet state directory to a working demo setup; the compose \`init\`
container runs this. In order, each step skipped when already done:
  1. zkauth init                      (accounts, funding, secrets.env)
  2. zkauth apps add demo             (provider google, client id dev-client,
                                       origin http://localhost:8765)
  3. zkauth deploy provider google
  4. zkauth deploy app demo
  5. zkauth keys sync google          (registers the dev issuer's key, seals)

Needs ZKAUTH_NETWORK=localnet (the default) and ZKAUTH_DEV_ISSUER_URL, the dev
issuer whose JWKS is registered. Proving artifacts (zkauth artifacts fetch)
must already be present for step 3.`;

export const DEMO_APP = { id: "demo", provider: "google", clientId: "dev-client", allowedOrigins: ["http://localhost:8765"], shared: false, clientSecretEnv: null, redirectUri: null } as const;

export async function up(ctx: Ctx, args: string[]): Promise<number> {
  const { values } = parse(args, { local: { type: "boolean" }, help: { type: "boolean" } });
  if (!values.local) throw new UsageError("Usage: zkauth up --local");
  if (ctx.service.network !== "localnet") throw new CliError("up --local runs on LocalNet only; unset ZKAUTH_NETWORK or set it to localnet");
  if (!ctx.env.ZKAUTH_DEV_ISSUER_URL) throw new CliError("Set ZKAUTH_DEV_ISSUER_URL to the dev issuer (for example http://localhost:8790); its key is the one registered");

  ctx.print("==> init");
  await init(ctx, []);
  // init may have written secrets.env; read it back.
  const next = loadContext({}, ctx.env, { print: ctx.print, warn: ctx.warn });
  ctx.print("==> apps");
  next.print(addApp(next, validateApp({ ...DEMO_APP, allowedOrigins: [...DEMO_APP.allowedOrigins] })) ? "added app demo" : "app demo already exists (unchanged)");
  ctx.print("==> deploy");
  await deployProvider(next, "google");
  await deployApp(next, "demo");
  ctx.print("==> keys");
  await keys(next, ["sync", "google"]);
  ctx.print("zkauth up --local: done");
  return 0;
}

export async function artifacts(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "fetch" && sub !== "check") throw new UsageError("Usage: zkauth artifacts fetch|check [providers]");
  const run = spawnSync(process.execPath, ["scripts/artifacts.mjs", sub, ...rest], { cwd: ctx.service.root, stdio: "inherit" });
  return run.status ?? 1;
}

export async function check(ctx: Ctx, args: string[]): Promise<number> {
  const run = spawnSync("sh", ["evidence/check-demo.sh", ...args], { cwd: ctx.service.root, stdio: "inherit" });
  return run.status ?? 1;
}
