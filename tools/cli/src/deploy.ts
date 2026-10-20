// zkauth deploy provider|app: write deployment records with packages/config.
// Idempotent: an existing record is verified on chain and left as it is.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ConfigError, guardianAddress, providerRecordPath, readApps, readAppDeployment, readProviderDeployment, requireRole,
  writeAppDeployment, writeProviderDeployment,
} from "../../../packages/config/src/index.ts";
import { ChainError } from "../../../packages/chain/src/errors.ts";
import { providerById } from "../../../packages/protocol/src/node.ts";
import { CliError, UsageError, parse, withChain, type Ctx } from "./lib.ts";

export const DEPLOY_HELP = `Usage: zkauth deploy provider <id>
       zkauth deploy app <app>

provider  Deploys the provider's Groth16 verifier LogicSig and key registry (one
          per provider per network, shared by every app). Signs with
          ZKAUTH_ADMIN_MNEMONIC; the guardian is ZKAUTH_GUARDIAN_ADDRESS (or the
          guardian mnemonic's address) and is fixed at creation. Needs the
          provider's proving artifacts (zkauth artifacts fetch).
app       Deploys the wallet registry for an app in apps.json (zkauth apps add)
          against its provider's key registry. Signs and pays with
          ZKAUTH_SPONSOR_MNEMONIC.

Records go to $ZKAUTH_STATE_DIR/deployments/<network>/. If a record already
exists it is checked against the chain and kept; to redeploy, delete the record.`;

const stale = (what: string, path: string) => new CliError(`${what}. Delete ${path} to deploy again.`);

export async function deployProvider(ctx: Ctx, id: string): Promise<void> {
  const provider = providerById(id);
  const { service } = ctx;
  const existing = readProviderDeployment(service, provider.id);
  await withChain(ctx, async (chain) => {
    if (existing) {
      const path = providerRecordPath(service, provider.id);
      const keys = chain.keys(existing); // refuses a record from another network
      try { await keys.flags(); } catch (error) {
        if (error instanceof ChainError) throw error;
        throw stale(`Key registry ${existing.keyRegistryId} in the ${provider.id} record was not found on ${service.network}`, path);
      }
      const onChain = await keys.client.state.global.guardian();
      if (onChain !== undefined && String(onChain) !== existing.guardian) throw stale(`The key registry's guardian differs from the ${provider.id} record`, path);
      const vk = createHash("sha256").update(readFileSync(join(service.root, provider.circuit.directory, "verification_key.json"))).digest("hex");
      if (vk !== existing.verificationKeySha256) throw stale(`The ${provider.id} verification key differs from the record's`, path);
      const wanted = guardianAddress(service, ctx.env);
      if (wanted && wanted !== existing.guardian) ctx.warn(`warning: the configured guardian differs from the ${provider.id} record; the record's guardian ${existing.guardian} stays (it is fixed at creation)`);
      ctx.print(`provider ${provider.id}: verified key registry ${existing.keyRegistryId}, verifier ${existing.verifier} (record kept)`);
      return;
    }
    const administrator = requireRole("admin", service, ctx.env, ctx.warn);
    const guardian = guardianAddress(service, ctx.env, ctx.warn);
    if (!guardian) throw new ConfigError("Set ZKAUTH_GUARDIAN_ADDRESS (or run zkauth init) so the key registry has a guardian");
    const record = await chain.deployProvider({ provider: provider.id, administrator, guardian });
    writeProviderDeployment(service, record);
    ctx.print(`provider ${provider.id}: deployed key registry ${record.keyRegistryId}, verifier ${record.verifier}, guardian ${record.guardian}`);
  });
}

export async function deployApp(ctx: Ctx, appId: string): Promise<void> {
  const { service } = ctx;
  const app = readApps(service).find((a) => a.id === appId);
  if (!app) throw new CliError(`No app "${appId}" in apps.json; add it with zkauth apps add`);
  const provider = readProviderDeployment(service, app.provider);
  if (!provider) throw new CliError(`App ${appId} uses provider ${app.provider}, which is not deployed; run zkauth deploy provider ${app.provider}`);
  const sponsor = requireRole("sponsor", service, ctx.env, ctx.warn);
  const existing = readAppDeployment(service, appId);
  await withChain(ctx, async (chain) => {
    if (existing) {
      if (existing.audience !== app.clientId || existing.provider !== app.provider)
        throw new CliError(`The ${appId} record is for audience ${existing.audience} on ${existing.provider}, but apps.json says ${app.clientId} on ${app.provider}. Delete ${join(service.stateDir, "deployments", service.network, "apps", `${appId}.json`)} to deploy the new audience.`);
      try { await chain.wallets(existing, provider).verify({ sender: sponsor.addr }); } catch (error) {
        if (error instanceof ChainError && error.code === "wrong_network") throw error;
        throw new CliError(`The ${appId} record does not match the chain (${error instanceof ChainError ? error.message : "registry not found"}). Delete the record to deploy again.`);
      }
      ctx.print(`app ${appId}: verified wallet registry ${existing.registryId} (record kept)`);
      return;
    }
    const record = await chain.deployApp({ provider, app: appId, audience: app.clientId, funder: sponsor });
    writeAppDeployment(service, record);
    ctx.print(`app ${appId}: deployed wallet registry ${record.registryId} (audience ${record.audience}, deposit ${record.enrollmentDeposit} microALGO)`);
  });
}

export async function deploy(ctx: Ctx, args: string[]): Promise<number> {
  const { positionals } = parse(args, { help: { type: "boolean" } });
  const [kind, name, ...extra] = positionals;
  if ((kind !== "provider" && kind !== "app") || !name || extra.length) throw new UsageError("Usage: zkauth deploy provider <id> | zkauth deploy app <app>");
  if (kind === "provider") await deployProvider(ctx, name); else await deployApp(ctx, name);
  return 0;
}
