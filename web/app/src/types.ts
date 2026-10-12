// Shapes returned by scripts/phase6-server.mjs and src/phase6/chain.ts.
export type ApprovedKey = { fingerprint: string; validFrom: string; validUntil: string };

export type Config = {
  network: string;
  genesisHash: string;
  audienceHash: string;
  verificationKeySha256: string;
  verifier: string;
  sponsor: string;
  keyRegistryId: string;
  registryId: string;
  demoAssetId: string;
  enrollmentDeposit: string;
  groupFeeMicroAlgos: string;
  approvedKeys: ApprovedKey[];
  clientId: string;
  latestTimestamp: string;
};

export type Identity = { issuer: string; audience: string; subject: string };

export type Wallet = {
  walletId: string;
  address: string | null;
  nonce: string;
  balanceMicroAlgos: string;
  minBalanceMicroAlgos: string;
  assets: { id: string; amount: string }[];
  enrolled: boolean;
};

export type Operation = "0" | "1" | "2" | "3";

export type ActionPlan = {
  planId: string;
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

export type Measurement = {
  operation: Operation;
  transactionIds: string[];
  confirmedRound: string;
  confirmationMs: number;
  groupFeeMicroAlgos: string;
  outerTransactions: number;
  innerTransactions: number;
  signedBytes: number;
  appBudgetConsumed: number;
  logicSigBudgetConsumed: number;
};

export type ProofMeasurement = { witnessMs?: number; proveMs?: number; elapsedMs: number; peakRssBytes: number };

export type ProofStatus = {
  stage: string;
  elapsedMs: number;
  ready: boolean;
  publicSignals?: string[];
  measurement?: ProofMeasurement;
};
