// @algozkauth/sdk — public API. Everything a dApp touches is declared here;
// the implementation talks to services/api/openapi.yaml.
//
// Changes from the milestone-0 draft (each one is explained where it is declared):
//   - ZkAuthOptions gains fetch, login, browserProver, indexerUrl, explorerUrl, approve, timing knobs.
//   - ZkAuth gains `session`, `signOut()` and `on("session")`; signIn takes SignInOptions.
//   - Session gains `provider`, `secondsLeft`, `on("change")`; renew() renews in place.
//   - Backup gains `stage`, `needsExport`; restore() returns a bigint wallet id and `enrolled`.
//   - Wallet gains `status`, `refresh()`, `on("change")`; enroll() is idempotent; ids are bigint | number.
//   - history()/plan events use friendlier shapes; amounts are bigint everywhere.
//   - ZkAuthErrorCode covers every service ErrorCode plus the SDK's own.
import type { Identity, Network, ProofResult, ProviderId, SignIn, SignInFields } from "@algozkauth/protocol";
export type { Identity, Network, ProviderId, SignIn, SignInFields };

/** session.createSignIn: a challenge from the dApp's backend, answered with the session key. */
export type SignInRequest = {
  /** The backend's single-use nonce (8–128 letters and digits; @algozkauth/verify createNonce()). */
  nonce: string;
  /** One line shown to the user and signed, e.g. "Sign in to Example". */
  statement?: string;
  /** The site the backend expects. Default: this page's origin. Required outside a browser page. */
  origin?: string;
  /** Validity in seconds (default 300, at most 600), never past the session's expiry. */
  expiresIn?: number;
};

/** ALGO amounts: bigint µALGO, or algo("1.5"), or an AlgoKit AlgoAmount (`microAlgo` / `microAlgos`). */
export type MicroAlgos = bigint | { microAlgo: bigint } | { microAlgos: bigint | number };
/** Asset base units. */
export type Units = bigint;
/** Asset ids may be given as number or bigint. */
export type AssetId = bigint | number;

/** What a login handler receives. See `ZkAuthOptions.login`. */
export type LoginContext = {
  provider: ProviderId;
  config: AppConfig;
  flow: "in-page" | "code";
  /** The nonce the provider must sign into the ID token. It binds this tab's session key. */
  nonce: string;
  /** Code flow: the provider URL to open in a login window. */
  authorizeUrl?: string;
  /** Where the default Google button renders (SignInOptions.button). */
  button?: HTMLElement;
  /** A window the SDK opened inside the click so pop-up blockers allow it (code flow). */
  popup?: Window | null;
  signal: AbortSignal;
};

/**
 * Drives the provider login step. Return the nonce-bound ID token (in-page flow) and the SDK sends it to
 * the service. For the code flow return nothing (or the login window, so the SDK notices when the user
 * closes it): the service exchanges the code and the SDK polls the session.
 */
export type LoginHandler = (context: LoginContext) => Promise<string | { closed: boolean } | void>;

export type SignInOptions = {
  /** Render the provider's own button here (in-page flow). Default: a small modal the SDK creates. */
  button?: HTMLElement | string;
  /** Overrides ZkAuthOptions.login for this call. */
  login?: LoginHandler;
  signal?: AbortSignal;
};

export type BrowserProverOptions = {
  /** URLs of the circuit's witness generator and proving key, hosted by the dApp. */
  wasmUrl: string;
  zkeyUrl: string;
  /** URL of snarkjs's browser ES module (node_modules/snarkjs/build/browser.esm.js), hosted by the dApp. */
  snarkjsUrl: string;
  /** The worker module (@algozkauth/sdk/prover-worker). Default: the one bundled next to the SDK. */
  worker?: string | URL | (() => Worker);
  /** Replaces the worker entirely (tests, custom runtimes). Receives the private circuit input. */
  run?: (input: Record<string, unknown>, progress: (message: string) => void) => Promise<ProofResult>;
};

export type ZkAuthOptions = {
  service: string;                           // e.g. "https://auth.example" or "http://localhost:8780"
  app: string;                               // app id registered with the service
  network?: Network;                         // checked against the service's config
  proving?: "service" | "browser";           // default "service"
  browserProver?: BrowserProverOptions;      // required when proving is "browser"
  /** Injected for tests, proxies or SSR. Default: globalThis.fetch. */
  fetch?: typeof fetch;
  /** Custom login UI (see LoginHandler). Default: Google Identity Services button / login window. */
  login?: LoginHandler;
  /** Overrides AppConfig.indexerUrl for history(). */
  indexerUrl?: string;
  /** Builds the explorer link in TxResult. Default: lora.algokit.io. */
  explorerUrl?: (txId: string, network: Network) => string;
  /** Called with every validated plan before the session key signs it; return false to cancel. */
  approve?: (plan: PlanSummary) => boolean | Promise<boolean>;
  /** Seconds before expiry at which "expiring" fires. Default 60. */
  expiringSeconds?: number;
  /** Poll interval for proofs, code-flow logins and waitForFunds. Default 1000 ms. */
  pollMs?: number;
  /** Give up waiting for a proof after this long. Default 300000 ms. */
  proofTimeoutMs?: number;
};

export interface ZkAuth {
  readonly options: ZkAuthOptions;
  /** The current signed-in session, or null. */
  readonly session: Session | null;
  /** Public deployment config (cached). Call early so a code-flow sign-in can open its window inside the click. */
  config(): Promise<AppConfig>;
  /** Creates a nonextractable session key, binds it in the login nonce and completes the provider login. */
  signIn(provider?: ProviderId, options?: SignInOptions): Promise<Session>;
  signOut(): Promise<void>;
  on(event: "session", listener: (session: Session | null) => void): () => void;
}

export type AppConfig = {
  app: string; provider: ProviderId; providers: ProviderId[]; loginFlow: "in-page" | "code"; clientId: string;
  network: Network; genesisHash: string; registryId: string; keyRegistryId: string; verifier: string;
  enrollmentDeposit: string; groupFeeMicroAlgos: string; sponsor: string;
  audienceHash?: string; algodUrl?: string; indexerUrl?: string; providerLabels?: Record<string, string>;
};

export interface Session {
  readonly id: string;                       // a capability: treat as secret
  readonly provider: ProviderId;
  readonly identity: Identity;
  readonly expiresAt: number;                // unix seconds
  readonly secondsLeft: number;
  readonly expired: boolean;
  readonly backup: Backup;
  /** Requires a salt (backup.create/restore). Discovers the wallet; enrollment happens on the first action. */
  wallet(): Promise<Wallet>;
  /** Signs in again as the same account with a fresh session key. Mutates and returns this session. */
  renew(options?: SignInOptions): Promise<Session>;
  /**
   * Proves to the dApp's backend which wallet this user controls: the session key signs the
   * backend's challenge, and the result carries the session's zero-knowledge proof. The backend
   * checks it with @algozkauth/verify against the chain, without trusting the service. Requires a
   * salt (backup.create/restore); proves first if the session has no proof yet.
   */
  createSignIn(request: SignInRequest): Promise<SignIn>;
  on(event: "expiring", listener: (secondsLeft: number) => void): () => void;
  on(event: "expired", listener: () => void): () => void;
  /** Any state change (salt bound, renewed, expired, closed). */
  on(event: "change", listener: () => void): () => void;
  close(): Promise<void>;
}

export interface Backup {
  readonly hasSalt: boolean;
  /** Stage of the latest package this session created, exported or restored. */
  readonly stage: "none" | "pre-enrollment" | "wallet";
  /** True once the wallet is enrolled but the latest package predates it: call export(). */
  readonly needsExport: boolean;
  /**
   * New salt (or, if the session already has one, a fresh package for the same salt) sealed under a new
   * recovery secret and optionally a passkey. The caller must store the file and the secret, separately.
   */
  create(o?: { passkey?: boolean }): Promise<{ file: Blob; fileName: string; secret: string; passkey: boolean }>;
  restore(file: Blob | string, unlock: { secret: string } | { passkey: true }): Promise<{ walletId: bigint | null; enrolled: boolean }>;
  /** After enrollment: a package bound to the wallet, for safekeeping. Reuses the session's secret, or makes a new one. */
  export(o?: { secret?: string }): Promise<{ file: Blob; fileName: string; secret: string }>;
}

export type TxResult = { txId: string; groupId: string; confirmedRound: bigint; explorerUrl: string };

export type PlanSummary = { kind: "enroll" | "sendAlgo" | "optIn" | "sendAsset"; recipient: string; assetId: bigint; amount: bigint; planId: string };
export type WalletStatus = "idle" | "proving" | "enrolling" | "preparing" | "signing" | "submitting";
export type Balance = { microAlgos: bigint; minBalance: bigint; spendable: bigint; assets: { id: bigint; amount: bigint }[] };
export type HistoryItem = {
  txId: string; round: bigint; time: number;
  type: "received" | "sent" | "opt-in" | "enrollment" | "other";
  amount: bigint; assetId: bigint;          // assetId 0n is ALGO
  counterparty?: string;
};

export interface Wallet {
  readonly id: bigint | null;                // null until enrolled
  readonly address: string | null;           // the address to fund; null until enrolled
  readonly enrolled: boolean;
  readonly status: WalletStatus;
  /** Detail for the current step, e.g. proving progress. */
  readonly progress: string | null;
  /** Idempotent: returns null if already enrolled. The service sponsor pays the deposit and fees. */
  enroll(): Promise<TxResult | null>;
  sendAlgo(o: { to: string; amount: MicroAlgos }): Promise<TxResult>;
  optIn(assetId: AssetId): Promise<TxResult>;
  sendAsset(o: { assetId: AssetId; to: string; amount: Units }): Promise<TxResult>;
  balance(): Promise<Balance>;
  history(o?: { limit?: number }): Promise<HistoryItem[]>;
  /** Resolves when the wallet holds at least this many µALGO. Requires an enrolled wallet. */
  waitForFunds(o: { microAlgos: bigint; timeoutMs?: number }): Promise<void>;
  refresh(): Promise<void>;
  /** Every action: the plan is validated against the request before the session key signs it. */
  on(event: "plan", listener: (plan: PlanSummary) => void): () => void;
  on(event: "change", listener: () => void): () => void;
}

/** Codes from the service (openapi ErrorCode) and the SDK itself. */
export type ZkAuthErrorCode =
  // service
  | "bad_request" | "unauthorized" | "not_found" | "origin_not_allowed" | "app_unknown" | "provider_unsupported"
  | "session_expired" | "not_signed_in" | "login_consumed" | "token_invalid" | "salt_required" | "salt_conflict"
  | "proof_pending" | "proof_failed" | "key_inactive" | "key_pending_delay" | "registry_paused" | "wallet_exists"
  | "not_enrolled" | "plan_expired" | "plan_mismatch" | "replay" | "insufficient_funds" | "quota_exceeded"
  | "rate_limited" | "service_unavailable"
  // SDK
  | "backup_invalid" | "passkey_unavailable" | "network_mismatch" | "popup_blocked" | "login_cancelled"
  | "login_timeout" | "nonce_mismatch" | "commitment_mismatch" | "wallet_mismatch" | "wrong_account"
  | "not_supported" | "timeout" | "user_rejected" | "wallet_closed";

/** The error class, createZkAuth, algo and formatAlgo are values: see index.ts. */
