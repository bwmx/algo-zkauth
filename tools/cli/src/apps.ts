// zkauth apps add|list|remove: the services' apps.json.
import { ConfigError, readApps, readAppDeployment, validateApp, writeApps, type AppConfig } from "../../../packages/config/src/index.ts";
import { CliError, UsageError, parse, type Ctx } from "./lib.ts";

export const APPS_HELP = `Usage: zkauth apps add <id> --provider <provider> --client-id <id> --origin <url>... [options]
       zkauth apps list
       zkauth apps remove <id>

An app is one OAuth client (audience) with its own wallet registry. Settings live
in $ZKAUTH_STATE_DIR/apps.json; deploy the registry with zkauth deploy app <id>.

add options:
  --provider <p>            google or slack
  --client-id <id>          the OAuth client ID (the token audience)
  --origin <url>            an allowed browser origin, e.g. http://localhost:8765
                            (repeat for several)
  --shared                  mark the hosted shared wallet app
  --client-secret-env NAME  env variable holding the client secret (code-flow providers)
  --redirect-uri <url>      the OAuth redirect URI registered with the provider

Adding an app that already exists with the same settings does nothing; with
different settings it is refused (remove it first). remove leaves the app's
deployment record in place.`;

const same = (a: AppConfig, b: AppConfig) => JSON.stringify(a) === JSON.stringify(b);

/** Adds the app unless an identical one exists; returns whether it was added. */
export function addApp(ctx: Ctx, app: AppConfig): boolean {
  const apps = readApps(ctx.service);
  const existing = apps.find((a) => a.id === app.id);
  if (existing) {
    if (same(existing, app)) return false;
    throw new CliError(`App ${app.id} already exists with different settings; run zkauth apps remove ${app.id} first`);
  }
  writeApps(ctx.service, [...apps, app]);
  return true;
}

export async function apps(ctx: Ctx, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "add") {
    const { values, positionals } = parse(rest, {
      provider: { type: "string" }, "client-id": { type: "string" }, origin: { type: "string", multiple: true },
      shared: { type: "boolean" }, "client-secret-env": { type: "string" }, "redirect-uri": { type: "string" }, help: { type: "boolean" },
    });
    const [id, ...extra] = positionals;
    if (!id || extra.length) throw new UsageError("Usage: zkauth apps add <id> --provider <p> --client-id <id> --origin <url>...");
    if (!values.provider || !values["client-id"] || !values.origin?.length) throw new UsageError("apps add needs --provider, --client-id and at least one --origin");
    let app: AppConfig;
    try {
      app = validateApp({
        id, provider: values.provider, clientId: values["client-id"], allowedOrigins: values.origin, shared: values.shared === true,
        clientSecretEnv: values["client-secret-env"] ?? null, redirectUri: values["redirect-uri"] ?? null,
      });
    } catch (error) {
      throw new CliError(error instanceof ConfigError ? error.message : `Invalid app settings: ${error instanceof Error ? error.message : "unknown"}`);
    }
    ctx.print(addApp(ctx, app) ? `added app ${id}` : `app ${id} already exists (unchanged)`);
    return 0;
  }
  if (sub === "list") {
    const all = readApps(ctx.service);
    if (!all.length) { ctx.print("no apps; add one with zkauth apps add"); return 0; }
    for (const app of all) {
      const record = readAppDeployment(ctx.service, app.id);
      ctx.print(`${app.id}  provider ${app.provider}  client ${app.clientId}${app.shared ? "  shared" : ""}  ${record ? `registry ${record.registryId}` : "not deployed"}`);
      ctx.print(`  origins: ${app.allowedOrigins.join(", ")}${app.clientSecretEnv ? `  secret env: ${app.clientSecretEnv}` : ""}${app.redirectUri ? `  redirect: ${app.redirectUri}` : ""}`);
    }
    return 0;
  }
  if (sub === "remove") {
    const { positionals } = parse(rest, { help: { type: "boolean" } });
    const [id, ...extra] = positionals;
    if (!id || extra.length) throw new UsageError("Usage: zkauth apps remove <id>");
    const all = readApps(ctx.service);
    if (!all.some((a) => a.id === id)) throw new CliError(`No app "${id}" in apps.json`);
    writeApps(ctx.service, all.filter((a) => a.id !== id));
    ctx.print(`removed app ${id}${readAppDeployment(ctx.service, id) ? " (its deployment record is kept)" : ""}`);
    return 0;
  }
  throw new UsageError("Usage: zkauth apps add|list|remove ...");
}
