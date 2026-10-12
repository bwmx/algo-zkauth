// Protocol modules shared with the classic page, the server and the Node
// tests. They use only WebCrypto, so this tab computes the same bytes. The
// modules are untyped JavaScript; these declarations describe their contracts.
import * as recovery from "../../../src/phase5/recovery.mjs";
import * as passkeys from "../../../src/phase5/passkey-prf.mjs";
import * as action from "../../../src/phase6/action.mjs";
import * as login from "../../phase3-login/client.mjs";
import type { ActionPlan, Config, Identity } from "./types";

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

const typed = <T,>(value: unknown) => value as T;

export const MAX_PACKAGE_BYTES = typed<number>(recovery.MAX_PACKAGE_BYTES);
export const toBase64Url = typed<(bytes: Uint8Array) => string>(recovery.toBase64Url);
export const fromBase64Url = typed<(value: string, min: number, max?: number) => Uint8Array<ArrayBuffer>>(recovery.fromBase64Url);
export const generateWalletSalt = typed<() => Uint8Array<ArrayBuffer>>(recovery.generateWalletSalt);
export const generateRecoverySecret = typed<() => Promise<string>>(recovery.generateRecoverySecret);
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

export const browserActionDigest = typed<(plan: ActionPlan) => Promise<Uint8Array<ArrayBuffer>>>(action.browserActionDigest);
export const validateActionPlan = typed<(
  plan: unknown, expected: Record<string, string | undefined>, config: Config, decodeAddress: (address: string) => { publicKey: Uint8Array },
) => ActionPlan>(action.validateActionPlan);

export const browserSessionNonce = typed<(values: {
  genesisHash: Uint8Array; sessionPublicKey: Uint8Array; expiresAt: number; randomness: Uint8Array;
}) => Promise<string>>(login.browserSessionNonce);
