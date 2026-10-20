// @algozkauth/protocol/node — Node-only protocol: providers, token checks,
// circuit input, identity commitment and development tokens.
import * as providers from "./oidc-providers.mjs";
import * as idToken from "./id-token.mjs";
import * as circuitInput from "./circuit-input.mjs";
import * as profile from "./circuit-profile.mjs";
import * as commitment from "./identity-commitment.mjs";
import * as nonce from "./session-nonce.mjs";
import * as synthetic from "./synthetic-token.mjs";
import * as nodeAction from "./action-node.mjs";
import type { Identity, Jwks, Provider, ProviderId, VerifiedToken } from "./types.ts";

export * from "./index.ts";

const typed = <T>(value: unknown) => value as T;

export const PROVIDERS = typed<Readonly<Record<ProviderId, Provider>>>(providers.PROVIDERS);
export const DEFAULT_PROVIDER = typed<ProviderId>(providers.DEFAULT_PROVIDER);
export const providerById = typed<(id: ProviderId) => Provider>(providers.providerById);
export const providerForIssuer = typed<(issuer: string) => Provider>(providers.providerForIssuer);
export const identitySubject = typed<(provider: Provider, claims: Record<string, unknown>) => string>(providers.identitySubject);

export const parseUniqueJson = typed<(source: string) => unknown>(idToken.parseUniqueJson);
export const verifyIdToken = typed<(token: string, options: {
  provider: Provider; audience: string; nonce: string; jwks: Jwks; nowSeconds?: number;
}) => VerifiedToken>(idToken.verifyIdToken);
export const fetchJwks = typed<(provider: Provider) => Promise<Jwks>>(idToken.fetchJwks);

/** Private circuit input (contains the token and salt). Never log or persist it outside a prover job. */
export type CircuitInput = Record<string, unknown> & {
  identity: string[]; keyHash: string[]; audienceHash: string[]; sessionKey: string[]; genesisHash: string[];
  sessionExpiresAt: number | string; notBefore: number | string;
};
export const oidcCircuitInput = typed<(options: {
  provider: Provider; token: string; jwks: Jwks; audience: string; nonce: string; genesisHash: Uint8Array;
  sessionPublicKey: Uint8Array; expiresAt: number; randomness: Uint8Array; salt: Uint8Array; nowSeconds: number;
}) => CircuitInput>(circuitInput.oidcCircuitInput);
/** The public signals a correct proof of this input must have, in order. */
export const expectedPublicSignals = (input: CircuitInput): string[] =>
  [...input.identity, ...input.keyHash, ...input.audienceHash, ...input.sessionKey, ...input.genesisHash, input.sessionExpiresAt, input.notBefore].map(String);
export const PUBLIC_SIGNAL_ORDER = typed<readonly string[]>(profile.PUBLIC_SIGNAL_ORDER);

export const identityCommitment = typed<(identity: Identity & { salt: Uint8Array }) => { digest: Buffer }>(commitment.identityCommitment);
export const sessionNonce = typed<(values: {
  genesisHash: Uint8Array; sessionPublicKey: Uint8Array; expiresAt: number; randomness?: Uint8Array;
}) => string>(nonce.sessionNonce);
/** Two 128-bit signal limbs → 32 bytes. */
export const signalDigest = typed<(signals: (string | bigint)[], offset: number) => Buffer>(nodeAction.signalDigest);

/** Development only: a provider-shaped RS256 token signed by a local key (services/dev-issuer, tests). */
export const syntheticToken = typed<(provider: Provider, options: {
  privateKey: unknown; kid: string; audience: string; subject: string; subjectScope?: string; nonce: string; issuedAt: number;
}) => string>(synthetic.syntheticToken);
