// Shared protocol types. Wire values are strings (uint64 as decimal, bytes as
// base64url) so they cross JSON unchanged; see services/api/openapi.yaml.

export type ProviderId = string;
export type LoginFlow = "in-page" | "code";
export type Network = "localnet" | "testnet" | "mainnet";

/** One OpenID Connect provider (src/phase3/oidc-providers.mjs). */
export type Provider = {
  id: ProviderId;
  label: string;
  envPrefix: string;
  issuer: string;
  issuers: readonly string[];
  jwksUrl: string;
  login: { flow: LoginFlow; authorizeUrl?: string; tokenUrl?: string; pkce?: "always" | "localhost" | "never" };
  subjectScope?: { claim: string; name: string; pattern: RegExp; maxLength: number };
  sessionWithinTokenExpiry: boolean;
  circuit: { directory: string; name: string };
};

export type Identity = { issuer: string; audience: string; subject: string };

/** Action operations; version 2 (contract calls) will add operations, never renumber these. */
export type Operation = "0" | "1" | "2" | "3";
export const OPERATIONS = { enroll: "0", algo: "1", optIn: "2", asset: "3" } as const;

/** The plan the service builds and the session key signs (algorand-zklogin-action-v1). */
export type ActionPlan = {
  planId: string;
  version: 1;
  genesisHash: string;
  registryId: string;
  walletId: string;
  owner: string;
  operation: Operation;
  recipient: string;
  recipientPublicKey: string;
  assetId: string;
  amount: string;
  nonce: string;
  sessionExpiresAt: string;
};

/** The twelve public signals in circuit order (PUBLIC_SIGNAL_ORDER). */
export type DecodedSignals = {
  commitment: string;
  keyHash: string;
  audienceHash: string;
  sessionKey: string;
  genesisHash: string;
  expiresAt: number;
  notBefore: number;
};

export type Groth16Proof = { pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol: "groth16"; curve: "bn128" };
export type ProofResult = { proof: Groth16Proof; publicSignals: string[] };

export type RecoveryBinding = {
  stage: "pre-enrollment" | "wallet";
  networkGenesisHash: string;
  registryAppId: string;
  walletAppId: string;
  walletAddress: string | null;
};
export type Passkey = { output: Uint8Array; rpId: string; credentialId: string; prfInput: string };
export type PackageSlot = { kind: "secret" | "prf"; rpId?: string; credentialId?: string; prfInput?: string };
export type RecoveryPackage = {
  header: { packageId: string; commitment: string; audienceHash: string; binding: RecoveryBinding };
  slots: PackageSlot[];
};

/** Result of verifyIdToken. */
export type VerifiedToken = {
  issuer: string;
  audience: string;
  subject: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  keyId: string;
  modulusSha256: string;
};

export type Jwks = { keys: { kty: string; kid?: string; n?: string; e?: string; alg?: string; use?: string }[] };
