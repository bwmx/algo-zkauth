// The postMessage protocol between a dApp (connectWallet, ./hosted.ts) and the
// hosted wallet window (serveWallet, ./wallet-host.ts). Version 1.
//
//   wallet → dApp   { type: "algozkauth:ready", v: 1 }                      once the window can take requests
//   dApp → wallet   { type: "algozkauth:request", v: 1, id, method, params }
//   wallet → dApp   { type: "algozkauth:response", v: 1, id, result } | { …, id, error: { code, message } }
//
// Both sides check the other's origin on every message; the wallet also checks
// that a request comes from an origin the user approved with "connect". Values
// that are bigints elsewhere in the SDK travel as decimal strings. A sign-in names
// the origin the wallet saw (event.origin), never one the dApp supplies.

export const PROTOCOL_VERSION = 1;
export const READY = "algozkauth:ready";
export const REQUEST = "algozkauth:request";
export const RESPONSE = "algozkauth:response";

import type { SignIn } from "@algozkauth/protocol";

export type HostedMethod = "connect" | "account" | "sendAlgo" | "optIn" | "sendAsset" | "signIn" | "disconnect";

export type HostedParams = {
  connect: { network?: string };
  account: Record<string, never>;
  sendAlgo: { to: string; amount: string };
  optIn: { assetId: string };
  sendAsset: { assetId: string; to: string; amount: string };
  signIn: { nonce: string; statement?: string };
  disconnect: Record<string, never>;
};

/** What the wallet tells a connected dApp: no login identifiers, only the wallet and its network. */
export type HostedAccount = {
  address: string;
  walletId: string;
  provider: string;
  network: string;
  balanceMicroAlgos: string;
  spendableMicroAlgos: string;
  assets: { id: string; amount: string }[];
};

export type HostedTx = { txId: string; groupId: string; confirmedRound: string; explorerUrl: string };

export type HostedResults = {
  connect: HostedAccount;
  account: HostedAccount;
  sendAlgo: HostedTx;
  optIn: HostedTx;
  sendAsset: HostedTx;
  signIn: SignIn;
  disconnect: { disconnected: true };
};

export type Request = { type: typeof REQUEST; v: number; id: string; method: HostedMethod; params: unknown };
export type Response = { type: typeof RESPONSE; v: number; id: string; result?: unknown; error?: { code: string; message: string; retryAfter?: number } };

export const isRequest = (data: unknown): data is Request =>
  !!data && typeof data === "object" && (data as Request).type === REQUEST && (data as Request).v === PROTOCOL_VERSION && typeof (data as Request).id === "string" && typeof (data as Request).method === "string";
export const isResponse = (data: unknown): data is Response =>
  !!data && typeof data === "object" && (data as Response).type === RESPONSE && typeof (data as Response).id === "string";
export const isReady = (data: unknown) => !!data && typeof data === "object" && (data as { type?: string }).type === READY;
