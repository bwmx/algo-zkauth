// The key-registry logic shared by the keysync service and `zkauth`: fetch a
// provider's JWKS, register and renew its keys, and the guardian check (a key
// that is or will become valid but that the provider no longer publishes).
// Nothing here logs; callers decide what to print. No secret passes through.
import { createHash } from "node:crypto";
import { ChainError } from "../../../packages/chain/src/errors.ts";
import type { ApprovedKey, ChainClient, ProviderDeployment, Signer } from "../../../packages/chain/src/types.ts";
import { fetchJwks as fetchProviderJwks } from "../../../packages/protocol/src/node.ts";
import type { Jwks, Provider } from "../../../packages/protocol/src/types.ts";
import { providerFor, type ServiceEnv } from "../../../packages/config/src/index.ts";

// The same module instance packages/chain uses (see packages/chain/src/deps.ts).
import { Config } from "../../../upstream/snarkjs-algorand/node_modules/@algorandfoundation/algokit-utils/index.mjs";

/** AlgoKit logs every transaction it sends at info level; callers that print only their own lines turn that off. */
export function silenceAlgoKit() {
  const none = () => {};
  (Config as { configure(o: unknown): void }).configure({ logger: { error: none, warning: none, info: none, verbose: none, debug: none } });
}

export type KeyState = "active" | "pending" | "expired" | "revoked" | "lapsed";
export type KeyReport = {
  fingerprint: string;
  state: KeyState;
  /** Unix seconds, as the registry stores them. */
  validFrom: string;
  validUntil: string;
  renewedUntil?: string;
  renewalEffectiveAt?: string;
  inJwks: boolean;
  /** Valid now or later, yet absent from the provider's JWKS. */
  alert: boolean;
};

/** A key's fingerprint: base64url SHA-256 of its RSA modulus, as the registry names it. */
export const fingerprintOf = (modulus: string) => createHash("sha256").update(Buffer.from(modulus, "base64url")).digest("base64url");

/** Fingerprints of every RSA key the provider publishes. */
export function liveFingerprints(jwks: { keys: unknown[] }): Set<string> {
  const live = new Set<string>();
  for (const key of jwks.keys as { kty?: string; n?: unknown }[]) if (key?.kty === "RSA" && typeof key.n === "string" && key.n) live.add(fingerprintOf(key.n));
  return live;
}

/** The guardian's reading of the registry at block time `now`. A pending renewal of a key keeps it a risk until it is cancelled. */
export function assessKeys(keys: ApprovedKey[], live: Set<string>, now: bigint): KeyReport[] {
  return keys.map((key) => {
    const validFrom = BigInt(key.validFrom), validUntil = BigInt(key.validUntil);
    const renewing = key.renewalEffectiveAt !== undefined;
    const state: KeyState = key.revoked ? "revoked"
      : now < validFrom ? "pending"
      : now < validUntil ? "active"
      : renewing ? "lapsed" : "expired";
    const inJwks = live.has(key.fingerprint);
    return {
      fingerprint: key.fingerprint, state, validFrom: key.validFrom, validUntil: key.validUntil,
      ...(renewing ? { renewedUntil: key.renewedUntil, renewalEffectiveAt: key.renewalEffectiveAt } : {}),
      inJwks,
      alert: !key.revoked && (now < validUntil || renewing) && !inJwks,
    };
  });
}

/** The provider with the dev-issuer override applied (LocalNet), and its current JWKS. */
export async function fetchLiveJwks(provider: ProviderDeployment, service: ServiceEnv, fetchJwks: (p: Provider) => Promise<Jwks> = fetchProviderJwks): Promise<Jwks> {
  const jwks = await fetchJwks(providerFor(provider.provider, service));
  if (!Array.isArray(jwks?.keys)) throw new Error("JWKS has no keys array");
  return jwks;
}

export async function guardianReport(chain: ChainClient, provider: ProviderDeployment, jwks: { keys: unknown[] }) {
  const keys = chain.keys(provider);
  const [list, flags, now] = await Promise.all([keys.list(), keys.flags(), chain.time()]);
  return { flags, now, keys: assessKeys(list, liveFingerprints(jwks), now) };
}

export type RunResult = {
  provider: string;
  /** ISO time the run finished. */
  at: string;
  registered: string[];
  renewed: string[];
  sealed: boolean;
  alerts: KeyReport[];
  /** A ChainError code or one of the codes below; null when the run succeeded. */
  error: string | null;
};
export type RunErrorCode = "jwks_unavailable" | "administrator_mismatch" | "unexpected";

/** Static codes only: a node or SDK error's text can carry request details, so it is never reported. */
export const errorCode = (error: unknown): string => (error instanceof ChainError ? error.code : "unexpected");

/** One provider: ensureKeys with the administrator, then the guardian check. Never throws. */
export async function runProvider(chain: ChainClient, provider: ProviderDeployment, o: {
  service: ServiceEnv; administrator: Signer; fetchJwks?: (p: Provider) => Promise<Jwks>;
}): Promise<RunResult> {
  const result: RunResult = { provider: provider.provider, at: "", registered: [], renewed: [], sealed: false, alerts: [], error: null };
  let jwks: Jwks | undefined;
  try {
    jwks = await fetchLiveJwks(provider, o.service, o.fetchJwks);
  } catch {
    result.error = "jwks_unavailable";
  }
  if (jwks) {
    try {
      if (provider.administrator !== o.administrator.addr) result.error = "administrator_mismatch";
      else {
        const done = await chain.keys(provider).ensureKeys({ jwks, administrator: o.administrator });
        result.registered = done.registered; result.renewed = done.renewed; result.sealed = done.sealed;
      }
    } catch (error) {
      result.error = errorCode(error);
    }
    // The guardian check runs even when ensureKeys failed: it is read-only and matters most then.
    try {
      result.alerts = (await guardianReport(chain, provider, jwks)).keys.filter((k) => k.alert);
    } catch (error) {
      result.error ??= errorCode(error);
    }
  }
  result.at = new Date().toISOString();
  return result;
}
