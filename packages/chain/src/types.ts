// @algozkauth/chain — the contract surface services build on. Milestone 1
// implements this from src/phase6/chain.ts (openDemoChain), splitting the
// demo-only parts (fund/seed/replay/isolation) into ./demo.ts.
import type { ActionPlan, Network, Operation, ProofResult, ProviderId } from "@algozkauth/protocol";

/** Per provider per network: shared by every audience (app). */
export type ProviderDeployment = {
  network: Network;
  genesisHash: string;
  provider: ProviderId;
  verifier: string;               // Groth16 verifier LogicSig address
  verificationKeySha256: string;
  keyRegistryId: string;
  guardian: string;
  administrator: string;          // key-registry creator
  createdAt: string;
};

/** Per audience (app): one WalletRegistry bound to the provider deployment. */
export type AppDeployment = {
  app: string;                    // app id in the service config, e.g. "demo"
  provider: ProviderId;
  audience: string;               // OAuth client ID
  audienceHash: string;
  registryId: string;
  enrollmentDeposit: string;      // µALGO
  groupFeeMicroAlgos: string;
};

export type ApprovedKey = { fingerprint: string; validFrom: string; validUntil: string; renewedUntil?: string; renewalEffectiveAt?: string; revoked?: boolean };
export type RegistryFlags = { paused: boolean; sealed: boolean; timelocked: boolean };

export type WalletSnapshot = {
  walletId: string;               // "0" when not enrolled
  address: string | null;
  nonce: string;
  balanceMicroAlgos: string;
  minBalanceMicroAlgos: string;
  assets: { id: string; amount: string }[];
  enrolled: boolean;
};

export type ActionRequest = { operation: Operation; recipient?: string; assetId?: string; amount?: string };
export type Submitted = { txId: string; transactionIds: string[]; groupId: string; confirmedRound: string; wallet: WalletSnapshot; groupFeeMicroAlgos: string };

/** Chain clients. Signing accounts are passed explicitly; nothing reads env. */
export interface ChainClient {
  readonly network: Network;
  time(): Promise<bigint>;                                             // latest block timestamp
  // Deployment (tools/cli, services/keysync)
  deployProvider(o: { provider: ProviderId; administrator: Signer; guardian: string }): Promise<ProviderDeployment>;
  deployApp(o: { provider: ProviderDeployment; app: string; audience: string; funder: Signer }): Promise<AppDeployment>;
  // Key registry (services/keysync); ensureKeys registers new JWKS keys, renews near expiry, seals bootstrap
  keys(provider: ProviderDeployment): {
    flags(): Promise<RegistryFlags>;
    list(): Promise<ApprovedKey[]>;
    ensureKeys(o: { jwks: { keys: unknown[] }; administrator: Signer }): Promise<{ registered: string[]; renewed: string[]; sealed: boolean }>;
    revoke(o: { fingerprint: string; signer: Signer }): Promise<void>;
    cancelRenewal(o: { fingerprint: string; signer: Signer }): Promise<void>;
    pause(o: { signer: Signer }): Promise<void>;
    resume(o: { administrator: Signer }): Promise<void>;
  };
  // Wallets (services/api)
  wallets(app: AppDeployment, provider: ProviderDeployment): {
    discover(owner: Uint8Array): Promise<WalletSnapshot>;
    snapshotByAddress(address: string): Promise<WalletSnapshot>;
    /** Verifies the proof, network/audience binding and key policy; throws typed ChainError. */
    checkProof(proof: ProofResult): Promise<{ owner: Uint8Array; keyHash: Uint8Array; expiresAt: bigint }>;
    prepare(o: { proof: ProofResult; request: ActionRequest }): Promise<ActionPlan>;
    submit(o: { proof: ProofResult; plan: ActionPlan; signature: Uint8Array; sponsor: Signer }): Promise<Submitted>;
  };
}

export type Signer = { addr: string; signer: unknown };          // algokit TransactionSignerAccount

export type ChainErrorCode =
  | "key_inactive" | "key_pending_delay" | "registry_paused" | "session_expired" | "invalid_proof"
  | "wrong_network" | "wrong_audience" | "wallet_exists" | "not_enrolled" | "replay" | "insufficient_funds" | "rejected";
export declare class ChainError extends Error { readonly code: ChainErrorCode; }

export declare function openChain(o: { network: Network; algodUrl?: string; algodToken?: string; indexerUrl?: string; root: string }): Promise<ChainClient>;
