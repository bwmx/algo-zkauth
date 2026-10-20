// @algozkauth/config — environment, role signers, apps.json and deployment
// records shared by services/api, services/keysync and tools/cli. See
// docs/service-architecture.md ("Configuration"). Nothing here logs a value.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mnemonicToSecretKey, makeBasicAccountTransactionSigner } from "../../../upstream/snarkjs-algorand/node_modules/algosdk/dist/esm/index.js";
import { providerById } from "../../protocol/src/node.ts";
import type { Network, Provider, ProviderId } from "../../protocol/src/types.ts";
import type { AppDeployment, ProviderDeployment, Signer } from "../../chain/src/types.ts";
import { withDevIssuer } from "../../../services/dev-issuer/src/override.ts";

const ROOT = resolve(new URL("../../../", import.meta.url).pathname);
const LOCAL_TOKEN = "a".repeat(64);
const DEFAULTS: Record<Exclude<Network, "mainnet">, { algodUrl: string; algodToken: string; indexerUrl: string }> = {
  localnet: { algodUrl: "http://localhost:4001", algodToken: LOCAL_TOKEN, indexerUrl: "http://localhost:8980" },
  testnet: { algodUrl: "https://testnet-api.algonode.cloud", algodToken: "", indexerUrl: "https://testnet-idx.algonode.cloud" },
};

export class ConfigError extends Error {}

export type ServiceEnv = {
  root: string;
  network: Exclude<Network, "mainnet">;
  algodUrl: string;
  algodToken: string;
  indexerUrl: string;
  stateDir: string;
  /** Set only on LocalNet. */
  devIssuerUrl?: string;
  /** Where the browser reaches the dev issuer's sign-in page, if not devIssuerUrl. */
  devIssuerPublicUrl?: string;
  /** LocalNet only: KMD, whose dispenser account funds `zkauth init` (ZKAUTH_KMD_URL, ZKAUTH_KMD_TOKEN). */
  kmdUrl?: string;
  kmdToken?: string;
};

export function loadServiceEnv(env: NodeJS.ProcessEnv = process.env): ServiceEnv {
  const network = env.ZKAUTH_NETWORK;
  if (network === "mainnet") throw new ConfigError("MainNet is refused until the Phase 7 production decision");
  if (network !== "localnet" && network !== "testnet") throw new ConfigError("Set ZKAUTH_NETWORK to localnet or testnet");
  const defaults = DEFAULTS[network];
  if (env.ZKAUTH_DEV_ISSUER_URL && network !== "localnet") throw new ConfigError("ZKAUTH_DEV_ISSUER_URL is allowed only on LocalNet");
  return {
    root: ROOT,
    network,
    algodUrl: env.ZKAUTH_ALGOD_URL || defaults.algodUrl,
    algodToken: env.ZKAUTH_ALGOD_TOKEN ?? defaults.algodToken,
    indexerUrl: env.ZKAUTH_INDEXER_URL || defaults.indexerUrl,
    stateDir: resolve(ROOT, env.ZKAUTH_STATE_DIR || ".local/service"),
    ...(env.ZKAUTH_DEV_ISSUER_URL ? { devIssuerUrl: env.ZKAUTH_DEV_ISSUER_URL } : {}),
    ...(env.ZKAUTH_DEV_ISSUER_URL && env.ZKAUTH_DEV_ISSUER_PUBLIC_URL ? { devIssuerPublicUrl: env.ZKAUTH_DEV_ISSUER_PUBLIC_URL } : {}),
    ...(network === "localnet" ? { kmdUrl: env.ZKAUTH_KMD_URL || "http://localhost:4002", kmdToken: env.ZKAUTH_KMD_TOKEN ?? LOCAL_TOKEN } : {}),
  };
}

/** A provider descriptor, pointed at the dev issuer when one is configured (LocalNet only). */
export function providerFor(id: ProviderId, service: ServiceEnv): Provider {
  const provider = providerById(id);
  return service.devIssuerUrl ? (withDevIssuer(provider, service.devIssuerUrl, service.devIssuerPublicUrl) as Provider) : provider;
}

// ---- Role signers ---------------------------------------------------------

export type Role = "admin" | "sponsor" | "guardian";
const ROLE_ENV: Record<Role, string> = { admin: "ZKAUTH_ADMIN_MNEMONIC", sponsor: "ZKAUTH_SPONSOR_MNEMONIC", guardian: "ZKAUTH_GUARDIAN_MNEMONIC" };
// Migration from the single-account demo .env (TestNet only).
const LEGACY_ENV: Record<Role, string> = { admin: "TESTNET_MNEMONIC", sponsor: "TESTNET_MNEMONIC", guardian: "KEY_GUARDIAN_MNEMONIC" };

export function signerFromMnemonic(mnemonic: string): Signer {
  let account;
  // algosdk's error can quote part of the input, so it is replaced by a static message.
  try { account = mnemonicToSecretKey(mnemonic.trim()); } catch { throw new ConfigError("A role mnemonic is not a valid 25-word Algorand mnemonic"); }
  return { addr: account.addr.toString(), signer: makeBasicAccountTransactionSigner(account) };
}

/** The signer for a role, or undefined when unset. `warn` hears about legacy fallbacks (never the value). */
export function roleSigner(role: Role, service: ServiceEnv, env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = () => {}): Signer | undefined {
  const value = env[ROLE_ENV[role]];
  if (value) return signerFromMnemonic(value);
  if (service.network === "testnet" && env[LEGACY_ENV[role]]) {
    warn(`${ROLE_ENV[role]} is unset; using ${LEGACY_ENV[role]} for the ${role} role`);
    return signerFromMnemonic(env[LEGACY_ENV[role]]!);
  }
  return undefined;
}

export function requireRole(role: Role, service: ServiceEnv, env: NodeJS.ProcessEnv = process.env, warn?: (message: string) => void): Signer {
  const signer = roleSigner(role, service, env, warn);
  if (!signer) throw new ConfigError(`Set ${ROLE_ENV[role]} for the ${role} role`);
  return signer;
}

/** The guardian address fixed at key-registry creation: ZKAUTH_GUARDIAN_ADDRESS, else the guardian mnemonic's address. */
export function guardianAddress(service: ServiceEnv, env: NodeJS.ProcessEnv = process.env, warn?: (message: string) => void): string | undefined {
  if (env.ZKAUTH_GUARDIAN_ADDRESS) return env.ZKAUTH_GUARDIAN_ADDRESS;
  if (service.network === "testnet" && env.KEY_GUARDIAN_ADDRESS) return env.KEY_GUARDIAN_ADDRESS;
  return roleSigner("guardian", service, env, warn)?.addr;
}

// ---- apps.json --------------------------------------------------------------

export type SponsorPolicy = { operations: string[]; maxActionsPerSession: number; maxDailyFeeMicroAlgos: string };
export type AppConfig = {
  id: string;
  provider: ProviderId;
  clientId: string;
  clientSecretEnv: string | null;
  redirectUri: string | null;
  allowedOrigins: string[];
  shared: boolean;
  sponsor: SponsorPolicy;
};

export const DEFAULT_SPONSOR: SponsorPolicy = { operations: ["0", "1", "2", "3"], maxActionsPerSession: 20, maxDailyFeeMicroAlgos: "2000000" };
const APP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function validateApp(value: unknown): AppConfig {
  const v = value as Partial<AppConfig>;
  if (!v || typeof v !== "object") throw new ConfigError("App entry must be an object");
  if (typeof v.id !== "string" || !APP_ID.test(v.id)) throw new ConfigError("App id must be 1-40 lowercase letters, digits or dashes");
  providerById(v.provider as string);
  if (typeof v.clientId !== "string" || !v.clientId) throw new ConfigError(`App ${v.id} needs a clientId`);
  if (!Array.isArray(v.allowedOrigins) || !v.allowedOrigins.every((o) => typeof o === "string" && new URL(o).origin === o))
    throw new ConfigError(`App ${v.id} allowedOrigins must be origins like http://localhost:8765`);
  const sponsor = { ...DEFAULT_SPONSOR, ...(v.sponsor ?? {}) };
  if (!sponsor.operations.every((o) => ["0", "1", "2", "3"].includes(o))) throw new ConfigError(`App ${v.id} has an unknown operation`);
  return {
    id: v.id, provider: v.provider as ProviderId, clientId: v.clientId,
    clientSecretEnv: v.clientSecretEnv ?? null, redirectUri: v.redirectUri ?? null,
    allowedOrigins: v.allowedOrigins, shared: v.shared === true, sponsor,
  };
}

export const appsPath = (service: ServiceEnv) => join(service.stateDir, "apps.json");

export function readApps(service: ServiceEnv): AppConfig[] {
  const path = appsPath(service);
  if (!existsSync(path)) return [];
  const apps = (JSON.parse(readFileSync(path, "utf8")).apps ?? []).map(validateApp);
  if (new Set(apps.map((a: AppConfig) => a.id)).size !== apps.length) throw new ConfigError("Duplicate app id in apps.json");
  return apps;
}

export function writeApps(service: ServiceEnv, apps: AppConfig[]): void {
  writeJson(appsPath(service), { apps: apps.map(validateApp) });
}

/** The client secret of a code-flow app, from the env variable it names. */
export function appClientSecret(app: AppConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return app.clientSecretEnv ? env[app.clientSecretEnv] : undefined;
}

// ---- Deployment records -----------------------------------------------------

const deploymentsDir = (service: ServiceEnv) => join(service.stateDir, "deployments", service.network);
export const providerRecordPath = (service: ServiceEnv, provider: ProviderId) => join(deploymentsDir(service), "providers", `${provider}.json`);
export const appRecordPath = (service: ServiceEnv, app: string) => join(deploymentsDir(service), "apps", `${app}.json`);

const readJson = <T>(path: string): T | undefined => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined);
function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}

export const readProviderDeployment = (service: ServiceEnv, provider: ProviderId) => readJson<ProviderDeployment>(providerRecordPath(service, provider));
export const writeProviderDeployment = (service: ServiceEnv, record: ProviderDeployment) => writeJson(providerRecordPath(service, record.provider), record);
export const readAppDeployment = (service: ServiceEnv, app: string) => readJson<AppDeployment>(appRecordPath(service, app));
export const writeAppDeployment = (service: ServiceEnv, record: AppDeployment) => writeJson(appRecordPath(service, record.app), record);

export function listProviderDeployments(service: ServiceEnv): ProviderDeployment[] {
  const dir = join(deploymentsDir(service), "providers");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJson<ProviderDeployment>(join(dir, f))!) : [];
}

/** Every configured app with its deployment and its provider's deployment; apps not yet deployed are skipped. */
export function deployedApps(service: ServiceEnv) {
  return readApps(service).flatMap((app) => {
    const record = readAppDeployment(service, app.id);
    const provider = readProviderDeployment(service, app.provider);
    return record && provider ? [{ app, record, provider }] : [];
  });
}
