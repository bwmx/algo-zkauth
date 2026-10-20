import {
  Account,
  BoxMap,
  Contract,
  Global,
  GlobalState,
  Txn,
  assert,
  clone,
  type bytes,
  type uint64,
} from "@algorandfoundation/algorand-typescript";
import { abimethod } from "@algorandfoundation/algorand-typescript/arc4";

/** Delay between an administrator's approval and its effect, after bootstrap. */
const APPROVAL_DELAY: uint64 = 86400;

type KeyRecord = {
  validFrom: uint64;
  validUntil: uint64;
  revoked: boolean;
  /** A pending extension: validUntil becomes renewedUntil from renewalEffectiveAt. */
  renewedUntil: uint64;
  renewalEffectiveAt: uint64;
};

/**
 * POC policy authority: the immutable application creator approves RSA modulus
 * SHA-256 fingerprints after authenticating one login provider's JWKS off-chain;
 * each provider's deployment has its own registry. This app does not establish
 * key authenticity or verify a JWT/Groth16 proof itself.
 *
 * Until the creator seals the bootstrap, keys can be registered with immediate
 * effect, but none is valid. After sealing, a new key or a longer interval takes
 * effect no sooner than APPROVAL_DELAY later. A separate guardian, fixed at
 * creation, can revoke a key, cancel a pending renewal or pause during that
 * delay; it cannot approve anything.
 */
export class KeyRegistry extends Contract {
  // The "gk:" prefix is the deployed box layout; it is kept for existing registries.
  private keys = BoxMap<bytes<32>, KeyRecord>({ keyPrefix: "gk:" });
  private paused = GlobalState<boolean>({ initialValue: false });
  private sealed = GlobalState<boolean>({ initialValue: false });
  private guardian = GlobalState<Account>();

  @abimethod({ onCreate: "require" })
  createApplication(guardian: Account): void {
    this.requireNoRekey();
    assert(guardian !== Global.zeroAddress, "Guardian required");
    assert(guardian !== Txn.sender, "Guardian must differ from administrator");
    this.guardian.value = guardian;
  }

  /** Ends immediate registration; the registry's keys become usable from here on. */
  sealBootstrap(): void {
    this.requireAdministrator();
    this.sealed.value = true;
  }

  registerKey(keyHash: bytes<32>, validFrom: uint64, validUntil: uint64): void {
    this.requireAdministrator();
    assert(!this.keys(keyHash).exists, "Key already registered");
    assert(validFrom < validUntil, "Invalid key interval");
    assert(validUntil > Global.latestTimestamp, "Key already retired");
    assert(
      !this.sealed.value || validFrom >= Global.latestTimestamp + APPROVAL_DELAY,
      "Key activation inside approval delay",
    );
    this.keys(keyHash).value = { validFrom, validUntil, revoked: false, renewedUntil: 0, renewalEffectiveAt: 0 };
  }

  /**
   * Requests a longer interval. It applies from APPROVAL_DELAY after the request
   * (immediately before sealing) and replaces any earlier pending renewal.
   */
  renewKey(keyHash: bytes<32>, validUntil: uint64): void {
    this.requireAdministrator();
    const record = this.settled(keyHash);
    assert(!record.revoked, "Key revoked");
    assert(validUntil > record.validUntil, "Renewal must extend key interval");
    record.renewedUntil = validUntil;
    record.renewalEffectiveAt = this.sealed.value ? Global.latestTimestamp + APPROVAL_DELAY : Global.latestTimestamp;
    this.keys(keyHash).value = clone(record);
  }

  /** Retirement can only shorten an existing interval and cancels a pending renewal; revocation is permanent. */
  retireKey(keyHash: bytes<32>, validUntil: uint64): void {
    this.requireAdministrator();
    const record = this.settled(keyHash);
    assert(!record.revoked, "Key revoked");
    assert(validUntil >= record.validFrom, "Retirement before activation");
    assert(validUntil <= record.validUntil, "Cannot extend key interval");
    record.validUntil = validUntil;
    record.renewedUntil = 0;
    record.renewalEffectiveAt = 0;
    this.keys(keyHash).value = clone(record);
  }

  revokeKey(keyHash: bytes<32>): void {
    this.requireAdministratorOrGuardian();
    const record = clone(this.keys(keyHash).value);
    record.revoked = true;
    this.keys(keyHash).value = clone(record);
  }

  cancelRenewal(keyHash: bytes<32>): void {
    this.requireAdministratorOrGuardian();
    const record = this.settled(keyHash);
    record.renewedUntil = 0;
    record.renewalEffectiveAt = 0;
    this.keys(keyHash).value = clone(record);
  }

  /** Either role can pause; only the administrator can resume. */
  setPaused(paused: boolean): void {
    if (paused) this.requireAdministratorOrGuardian();
    else this.requireAdministrator();
    this.paused.value = paused;
  }

  @abimethod({ readonly: true })
  isKeyValid(keyHash: bytes<32>): boolean {
    this.requireNoRekey();
    if (this.paused.value || !this.sealed.value || !this.keys(keyHash).exists) return false;
    const record = this.settled(keyHash);
    return (
      !record.revoked &&
      Global.latestTimestamp >= record.validFrom &&
      Global.latestTimestamp < record.validUntil
    );
  }

  /** The wallet must call this at execution, alongside proof and action checks. */
  @abimethod({ readonly: true })
  assertKeyValid(keyHash: bytes<32>, sessionExpiresAt: uint64): void {
    assert(this.isKeyValid(keyHash), "Key inactive");
    assert(Global.latestTimestamp < sessionExpiresAt, "Session expired");
    assert(
      sessionExpiresAt <= this.settled(keyHash).validUntil,
      "Session outlives key interval",
    );
  }

  @abimethod({ readonly: true })
  assertAuthorizationWindow(
    keyHash: bytes<32>,
    notBefore: uint64,
    sessionExpiresAt: uint64,
  ): void {
    this.assertKeyValid(keyHash, sessionExpiresAt);
    assert(notBefore <= Global.latestTimestamp, "Session not yet active");
    assert(
      sessionExpiresAt <= Global.latestTimestamp + 600,
      "Session exceeds maximum duration",
    );
  }

  /** The record with any renewal that has taken effect applied to validUntil. */
  private settled(keyHash: bytes<32>): KeyRecord {
    const record = clone(this.keys(keyHash).value);
    if (record.renewalEffectiveAt !== 0 && Global.latestTimestamp >= record.renewalEffectiveAt) {
      record.validUntil = record.renewedUntil;
      record.renewedUntil = 0;
      record.renewalEffectiveAt = 0;
    }
    return clone(record);
  }

  private requireAdministrator(): void {
    this.requireNoRekey();
    assert(Txn.sender === Global.creatorAddress, "Administrator required");
  }

  private requireAdministratorOrGuardian(): void {
    this.requireNoRekey();
    assert(
      Txn.sender === Global.creatorAddress || Txn.sender === this.guardian.value,
      "Administrator or guardian required",
    );
  }

  private requireNoRekey(): void {
    assert(Txn.rekeyTo === Global.zeroAddress, "Rekey forbidden");
  }
}
