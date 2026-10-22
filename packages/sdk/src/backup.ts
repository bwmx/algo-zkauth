import {
  MAX_PACKAGE_BYTES, PrfUnavailableError, createRecoveryPackage, enrollPasskey, generateRecoverySecret, generateWalletSalt,
  parsePackage, restoreRecoveryPackage, unlockPasskey,
} from "@bwmx/algo-zkauth-protocol";
import type { Passkey, RecoveryBinding } from "@bwmx/algo-zkauth-protocol";
import { getApplicationAddress } from "./address.ts";
import { ZkAuthError } from "./errors.ts";
import type { SessionImpl } from "./session.ts";
import type { Backup } from "./types.ts";
import { bytesEqual } from "./util.ts";

const asBackupError = (error: unknown): ZkAuthError => {
  if (error instanceof ZkAuthError) return error;
  const message = error instanceof Error && error.message ? error.message : "The backup could not be read";
  if (/^Sign in to the original/.test(message)) return new ZkAuthError("wrong_account", message);
  return new ZkAuthError("backup_invalid", message, { cause: error });
};

const asPasskeyError = (error: unknown): ZkAuthError => {
  if (error instanceof ZkAuthError) return error;
  const message = error instanceof PrfUnavailableError || error instanceof Error ? error.message : "Passkey unavailable";
  return new ZkAuthError("passkey_unavailable", message, { cause: error });
};

/**
 * The salt's only home outside the browser is the user's own encrypted backup file. The salt reaches the
 * service solely through POST /v1/sessions/:id/salt (SessionImpl.bindSalt), never any other call.
 */
export class BackupImpl implements Backup {
  private secret: string | null = null;
  private passkey: Passkey | null = null;
  private latest: "none" | "pre-enrollment" | "wallet" = "none";

  constructor(private readonly session: SessionImpl) {}

  get hasSalt() { return this.session.salt !== null; }
  get stage() { return this.latest; }
  get needsExport() { return this.latest === "pre-enrollment" && this.session.walletImpl.enrolled; }

  private pendingBinding(): RecoveryBinding {
    return { stage: "pre-enrollment", networkGenesisHash: this.session.ctx.config.genesisHash, registryAppId: "0", walletAppId: "0", walletAddress: null };
  }
  private currentBinding(): RecoveryBinding {
    const wallet = this.session.walletImpl;
    if (!wallet.enrolled || wallet.id === null || !wallet.address) return this.pendingBinding();
    return { stage: "wallet", networkGenesisHash: this.session.ctx.config.genesisHash, registryAppId: this.session.ctx.config.registryId, walletAppId: wallet.id.toString(), walletAddress: wallet.address };
  }

  private blob(text: string) {
    return { file: new Blob([`${text}\n`], { type: "application/json" }), fileName: `algo-zkauth-${parsePackage(text).header.packageId}.json` };
  }

  async create(o: { passkey?: boolean } = {}) {
    const s = this.session;
    s.assertOpen();
    const secret = await generateRecoverySecret();
    let passkey: Passkey | null = null;
    if (o.passkey) {
      try { passkey = await enrollPasskey(); } catch (error) { throw asPasskeyError(error); }
    }
    try {
      // An existing salt is never replaced: it would orphan the wallet. Re-seal it under the new secret instead.
      const salt = s.salt ?? generateWalletSalt();
      const text = await createRecoveryPackage({ salt, identity: s.identity, binding: this.currentBinding(), recoverySecret: secret, passkeys: passkey ? [passkey] : [] });
      if (!s.salt) await s.bindSalt(salt, false);
      this.passkey?.output.fill(0);
      this.passkey = passkey;
      passkey = null;
      this.secret = secret;
      this.latest = parsePackage(text).header.binding.stage;
      s.emitChange();
      return { ...this.blob(text), secret, passkey: this.passkey !== null };
    } finally {
      passkey?.output.fill(0);
    }
  }

  async restore(file: Blob | string, unlock: { secret: string } | { passkey: true }) {
    const s = this.session;
    s.assertOpen();
    const { config } = s.ctx;
    const text = typeof file === "string" ? file : file.size > MAX_PACKAGE_BYTES ? "" : await file.text();
    let parsed;
    try { parsed = parsePackage(text); } catch (error) { throw asBackupError(error); }
    const binding = parsed.header.binding;
    if (binding.networkGenesisHash !== config.genesisHash || (binding.stage === "wallet" && binding.registryAppId !== config.registryId)) {
      throw new ZkAuthError("backup_invalid", "This backup belongs to a different network or deployment");
    }
    if (binding.stage === "wallet" && getApplicationAddress(BigInt(binding.walletAppId)).toString() !== binding.walletAddress) {
      throw new ZkAuthError("backup_invalid", "The backup's wallet address does not match its application id");
    }

    let key: Passkey | undefined;
    try {
      if ("passkey" in unlock) {
        const slot = parsed.slots.find((slot) => slot.kind === "prf" && slot.rpId === location.hostname);
        if (!slot) throw new ZkAuthError("passkey_unavailable", "This backup has no passkey for this site; use the recovery secret");
        try { key = await unlockPasskey(slot); } catch (error) { throw asPasskeyError(error); }
      }
      let recovered;
      try {
        recovered = await restoreRecoveryPackage({
          packageText: text, identity: s.identity, expectedBinding: binding,
          ...(key ? { passkey: key } : { recoverySecret: (unlock as { secret: string }).secret.trim() }),
        });
      } catch (error) { throw asBackupError(error); }
      if (s.salt && !bytesEqual(s.salt, recovered.salt)) {
        recovered.salt.fill(0);
        throw new ZkAuthError("backup_invalid", "This backup holds a different wallet salt than the one already active in this session");
      }
      const wallet = await s.bindSalt(recovered.salt, true);
      // The service's discovery must agree with the authenticated package header before anything is trusted.
      if (binding.stage === "wallet" && (!wallet.enrolled || wallet.walletId !== binding.walletAppId || wallet.address !== binding.walletAddress)) {
        s.salt?.fill(0);
        s.salt = null;
        throw new ZkAuthError("wallet_mismatch", "The service reports a different wallet than the one in this backup");
      }
      this.latest = binding.stage;
      if (key) { this.passkey?.output.fill(0); this.passkey = key; key = undefined; }
      if ("secret" in unlock) this.secret = unlock.secret.trim();
      s.emitChange();
      return { walletId: wallet.enrolled ? BigInt(wallet.walletId) : null, enrolled: wallet.enrolled };
    } finally {
      key?.output.fill(0);
    }
  }

  async export(o: { secret?: string } = {}) {
    const s = this.session;
    s.assertOpen();
    if (!s.salt) throw new ZkAuthError("salt_required", "There is no backup to export yet: call backup.create() first");
    if (!s.walletImpl.enrolled) throw new ZkAuthError("not_enrolled", "Enroll the wallet first (any wallet action does it); until then backup.create() is the current backup");
    const secret = o.secret ?? this.secret ?? await generateRecoverySecret();
    let text: string;
    try {
      text = await createRecoveryPackage({ salt: s.salt, identity: s.identity, binding: this.currentBinding(), recoverySecret: secret, passkeys: this.passkey ? [this.passkey] : [] });
    } catch (error) { throw asBackupError(error); }
    this.secret = secret;
    this.latest = "wallet";
    s.emitChange();
    return { ...this.blob(text), secret };
  }

  dispose() {
    this.passkey?.output.fill(0);
    this.passkey = null;
    this.secret = null;
  }
}
