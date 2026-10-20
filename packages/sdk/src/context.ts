import type { Identity, ProviderId } from "@algozkauth/protocol";
import type { Api } from "./http.ts";
import type { Prover } from "./proving.ts";
import type { AppConfig, ZkAuthOptions } from "./types.ts";

/** Resolved, shared state for one ZkAuth instance. */
export type Ctx = {
  options: ZkAuthOptions;
  api: Api;
  config: AppConfig;
  fetchFn: () => typeof fetch;
  prover?: Prover;
  pollMs: number;
  proofTimeoutMs: number;
  expiringSeconds: number;
};

/** The result of a completed provider login, before a Session wraps it. */
export type LoginOutcome = {
  sessionId: string;
  provider: ProviderId;
  identity: Identity;
  expiresAt: number;       // network clock (the chain's), as signed into the nonce and proven
  /** Network clock minus this device's clock, in seconds (0 when the service does not report it). */
  clockSkew: number;
  key: CryptoKeyPair;
  publicKey: string;       // base64url raw Ed25519
};

/** Service wallet state (openapi Wallet). */
export type WalletWire = {
  walletId: string;
  address: string | null;
  nonce: string;
  balanceMicroAlgos: string;
  minBalanceMicroAlgos: string;
  assets: { id: string; amount: string }[];
  enrolled: boolean;
};
