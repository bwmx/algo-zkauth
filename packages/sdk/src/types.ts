// @algozkauth/sdk — public API. Everything a dApp touches is declared here;
// the implementation (milestone 3) talks to services/api/openapi.yaml.
import type { Identity, Network, ProviderId } from "@algozkauth/protocol";

/** Amounts: bigint µALGO / base units, or an AlgoKit AlgoAmount for ALGO. */
export type MicroAlgos = bigint | { microAlgo: bigint };
export type Units = bigint;

export type ZkAuthOptions = {
  service: string;                           // e.g. "https://auth.example" or "http://localhost:8780"
  app: string;                               // app id registered with the service
  network?: Network;                         // checked against the service's config
  mode?: "embedded" | "hosted";              // hosted: the shared-wallet popup owns login, salt and signing
  proving?: "service" | "browser";           // default "service"
  walletOrigin?: string;                     // hosted mode; default derived from service
};

export interface ZkAuth {
  readonly options: ZkAuthOptions;
  config(): Promise<AppConfig>;
  /** Creates a nonextractable session key, binds it in the login nonce and completes the provider login. */
  signIn(provider?: ProviderId): Promise<Session>;
}

export type AppConfig = {
  app: string; provider: ProviderId; providers: ProviderId[]; loginFlow: "in-page" | "code"; clientId: string;
  network: Network; genesisHash: string; registryId: string; keyRegistryId: string; verifier: string;
  enrollmentDeposit: string; groupFeeMicroAlgos: string; sponsor: string;
};

export interface Session {
  readonly id: string;
  readonly identity: Identity;
  readonly expiresAt: number;                // unix seconds
  readonly backup: Backup;
  /** Requires a salt (backup.create/restore). Discovers the wallet; enrollment happens on the first action. */
  wallet(): Promise<Wallet>;
  renew(): Promise<Session>;
  on(event: "expiring", listener: (secondsLeft: number) => void): () => void;
  on(event: "expired", listener: () => void): () => void;
  close(): void;
}

export interface Backup {
  readonly hasSalt: boolean;
  /** New salt; returns the encrypted package and its secret. The caller must store both, separately. */
  create(o?: { passkey?: boolean }): Promise<{ file: Blob; fileName: string; secret: string }>;
  restore(file: Blob | string, unlock: { secret: string } | { passkey: true }): Promise<{ walletId: string | null }>;
  /** After enrollment: a package bound to the wallet, for safekeeping. */
  export(): Promise<{ file: Blob; fileName: string }>;
}

export type TxResult = { txId: string; groupId: string; confirmedRound: bigint; explorerUrl: string };

export interface Wallet {
  readonly id: bigint | null;                // null until enrolled
  readonly address: string | null;
  readonly enrolled: boolean;
  /** The account that pays the enrollment deposit and fees is the service sponsor; funding the wallet is the dApp's or user's job. */
  enroll(): Promise<TxResult>;
  sendAlgo(o: { to: string; amount: MicroAlgos }): Promise<TxResult>;
  optIn(assetId: bigint): Promise<TxResult>;
  sendAsset(o: { assetId: bigint; to: string; amount: Units }): Promise<TxResult>;
  balance(): Promise<{ microAlgos: bigint; minBalance: bigint; spendable: bigint; assets: { id: bigint; amount: bigint }[] }>;
  history(o?: { limit?: number }): Promise<{ txId: string; round: bigint; type: string; amount: bigint; assetId?: bigint; counterparty: string }[]>;
  waitForFunds(o: { microAlgos: bigint; timeoutMs?: number }): Promise<void>;
  /** Every action: the plan is validated against the request before the session key signs it. */
  on(event: "plan", listener: (plan: { operation: string; recipient: string; assetId: string; amount: string }) => void): () => void;
}

export type ZkAuthErrorCode =
  | "session_expired" | "not_signed_in" | "salt_required" | "backup_invalid" | "passkey_unavailable"
  | "key_pending_delay" | "key_inactive" | "registry_paused" | "replay" | "insufficient_funds"
  | "quota_exceeded" | "origin_not_allowed" | "plan_mismatch" | "proof_failed" | "network_mismatch" | "service_unavailable";
export declare class ZkAuthError extends Error { readonly code: ZkAuthErrorCode; readonly retryAfter?: number; }

export declare function createZkAuth(options: ZkAuthOptions): ZkAuth;
export declare function algo(amount: number | string): MicroAlgos;
