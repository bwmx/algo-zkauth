// @algozkauth/protocol — browser-safe protocol (WebCrypto only). Node-only
// pieces are in ./node.ts. Typed views of the implementations in this directory;
// the old paths (src/phase3-6, web/phase3-login/client.mjs) re-export them.
import * as recovery from "./recovery.mjs";
import * as passkeys from "./passkey-prf.mjs";
import * as action from "./action.mjs";
import * as login from "./browser-session-nonce.mjs";
import type { ActionPlan, Identity, Passkey, PackageSlot, RecoveryBinding, RecoveryPackage } from "./types.ts";

export * from "./types.ts";

const typed = <T>(value: unknown) => value as T;

export const ACTION_DOMAIN = "algorand-zklogin-action-v1\0";
export const SESSION_SECONDS = 600;

export const MAX_PACKAGE_BYTES = typed<number>(recovery.MAX_PACKAGE_BYTES);
export const toBase64Url = typed<(bytes: Uint8Array) => string>(recovery.toBase64Url);
export const fromBase64Url = typed<(value: string, min: number, max?: number) => Uint8Array<ArrayBuffer>>(recovery.fromBase64Url);

/** A fresh random 32-byte wallet salt. */
export const generateWalletSalt = typed<() => Uint8Array<ArrayBuffer>>(recovery.generateWalletSalt);
export const generateRecoverySecret = typed<() => Promise<string>>(recovery.generateRecoverySecret);
/** SHA-256 identity commitment used for wallet discovery (same bytes as the circuit's). */
export const recoveryCommitment = typed<(identity: Identity, salt: Uint8Array) => Promise<Uint8Array>>(recovery.recoveryCommitment);
export const parsePackage = typed<(text: string) => RecoveryPackage>(recovery.parsePackage);
export const createRecoveryPackage = typed<(options: {
  salt: Uint8Array; identity: Identity; binding: RecoveryBinding; recoverySecret: string; passkeys?: Passkey[];
}) => Promise<string>>(recovery.createRecoveryPackage);
export const restoreRecoveryPackage = typed<(options: {
  packageText: string; identity: Identity; expectedBinding: RecoveryBinding; recoverySecret?: string; passkey?: Passkey;
}) => Promise<{ salt: Uint8Array<ArrayBuffer>; commitment: Uint8Array; packageId: string }>>(recovery.restoreRecoveryPackage);

export const enrollPasskey = typed<() => Promise<Passkey>>(passkeys.enrollPasskey);
export const unlockPasskey = typed<(slot: PackageSlot) => Promise<Passkey>>(passkeys.unlockPasskey);
export const PrfUnavailableError = typed<new (message?: string) => Error>(passkeys.PrfUnavailableError);

/** The nonce a login binds: SHA-256 over genesis hash, session key, expiry and randomness. */
export const browserSessionNonce = typed<(values: {
  genesisHash: Uint8Array; sessionPublicKey: Uint8Array; expiresAt: number; randomness: Uint8Array;
}) => Promise<string>>(login.browserSessionNonce);

/** SHA-256 of the fixed-width action preimage the session key signs. */
export const actionDigest = typed<(plan: ActionPlan) => Promise<Uint8Array<ArrayBuffer>>>(action.browserActionDigest);
/** Throws unless the service's plan is exactly the requested action on this deployment. */
export const validateActionPlan = typed<(
  plan: unknown,
  expected: Partial<Record<keyof ActionPlan, string>>,
  deployment: { genesisHash: string; registryId: string },
  decodeAddress: (address: string) => { publicKey: Uint8Array },
) => ActionPlan>(action.validateActionPlan);
