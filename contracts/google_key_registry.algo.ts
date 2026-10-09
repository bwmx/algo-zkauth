import {
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

type GoogleKeyRecord = {
  validFrom: uint64;
  validUntil: uint64;
  revoked: boolean;
};

/**
 * POC policy authority: the immutable application creator approves RSA modulus
 * SHA-256 fingerprints after authenticating Google's JWKS off-chain. This app
 * does not establish key authenticity or verify a JWT/Groth16 proof itself.
 */
export class GoogleKeyRegistry extends Contract {
  private keys = BoxMap<bytes<32>, GoogleKeyRecord>({ keyPrefix: "gk:" });
  private paused = GlobalState<boolean>({ initialValue: false });

  @abimethod({ onCreate: "require" })
  createApplication(): void {
    this.requireNoRekey();
  }

  registerKey(keyHash: bytes<32>, validFrom: uint64, validUntil: uint64): void {
    this.requireAdministrator();
    assert(validFrom < validUntil, "Invalid key interval");
    assert(validUntil > Global.latestTimestamp, "Key already retired");
    assert(!this.keys(keyHash).exists, "Key already registered");
    this.keys(keyHash).value = { validFrom, validUntil, revoked: false };
  }

  /** Retirement can only shorten an existing interval; revocation is permanent. */
  retireKey(keyHash: bytes<32>, validUntil: uint64): void {
    this.requireAdministrator();
    const record = clone(this.keys(keyHash).value);
    assert(!record.revoked, "Key revoked");
    assert(validUntil >= record.validFrom, "Retirement before activation");
    assert(validUntil <= record.validUntil, "Cannot extend key interval");
    record.validUntil = validUntil;
    this.keys(keyHash).value = clone(record);
  }

  revokeKey(keyHash: bytes<32>): void {
    this.requireAdministrator();
    const record = clone(this.keys(keyHash).value);
    record.revoked = true;
    this.keys(keyHash).value = clone(record);
  }

  setPaused(paused: boolean): void {
    this.requireAdministrator();
    this.paused.value = paused;
  }

  @abimethod({ readonly: true })
  isKeyValid(keyHash: bytes<32>): boolean {
    this.requireNoRekey();
    if (this.paused.value || !this.keys(keyHash).exists) return false;
    const record = clone(this.keys(keyHash).value);
    return (
      !record.revoked &&
      Global.latestTimestamp >= record.validFrom &&
      Global.latestTimestamp < record.validUntil
    );
  }

  /** The wallet must call this at execution, alongside proof and action checks. */
  @abimethod({ readonly: true })
  assertKeyValid(keyHash: bytes<32>, sessionExpiresAt: uint64): void {
    assert(this.isKeyValid(keyHash), "Google key inactive");
    assert(Global.latestTimestamp < sessionExpiresAt, "Session expired");
    assert(
      sessionExpiresAt <= this.keys(keyHash).value.validUntil,
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

  private requireAdministrator(): void {
    this.requireNoRekey();
    assert(Txn.sender === Global.creatorAddress, "Administrator required");
  }

  private requireNoRekey(): void {
    assert(Txn.rekeyTo === Global.zeroAddress, "Rekey forbidden");
  }
}
