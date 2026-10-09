import {
  Account, Application, Bytes, Contract, Global, GlobalState, Txn,
  assert, ensureBudget, OpUpFeeSource, op, type bytes, type uint64,
} from "@algorandfoundation/algorand-typescript";
import { abiCall } from "@algorandfoundation/algorand-typescript/arc4";
import { type PublicSignals } from "./bn254_common.algo";
import { GoogleKeyRegistry } from "./google_key_registry.algo";

/** Shared policy for direct calls signed by the pinned Groth16 verifier. */
export abstract class WalletAuthorization extends Contract {
  protected verifier = GlobalState<Account>();
  protected keyRegistry = GlobalState<Application>();
  protected audience = GlobalState<bytes<32>>();

  protected initializePolicy(verifier: Account, keyRegistry: Application, audience: bytes<32>): void {
    assert(Txn.rekeyTo === Global.zeroAddress, "Rekey forbidden");
    assert(verifier !== Global.zeroAddress, "Verifier required");
    assert(keyRegistry.id !== 0, "Key registry required");
    this.verifier.value = verifier;
    this.keyRegistry.value = keyRegistry;
    this.audience.value = audience;
  }

  protected authorize(
    signals: PublicSignals, signature: bytes<64>, registryId: uint64,
    walletId: uint64, owner: bytes<32>, operation: uint64, recipient: Account,
    assetId: uint64, amount: uint64, nonce: uint64,
  ): void {
    assert(Txn.rekeyTo === Global.zeroAddress, "Rekey forbidden");
    // APP_OFFSET=0 binds this transaction's args 1/2 to Groth16 verification.
    assert(Txn.sender === this.verifier.value, "Proof verifier required");
    assert(signals.length === 12, "Expected twelve public signals");
    assert(this.digest(signals, 0) === owner, "Wrong owner");
    assert(this.digest(signals, 4) === this.audience.value, "Wrong audience");
    assert(this.digest(signals, 8) === Global.genesisHash, "Wrong network");
    const expiry = signals[10]!.asUint64();
    abiCall<typeof GoogleKeyRegistry.prototype.assertAuthorizationWindow>({
      appId: this.keyRegistry.value,
      method: GoogleKeyRegistry.prototype.assertAuthorizationWindow,
      args: [this.digest(signals, 2), signals[11]!.asUint64(), expiry],
      fee: 0,
    });
    // Only pooled outer fees pay for budget. Wallet funds never pay inner fees.
    ensureBudget(3500, OpUpFeeSource.GroupCredit);
    const message = Bytes("algorand-zklogin-action-v1\x00")
      .concat(Global.genesisHash)
      .concat(op.itob(registryId)).concat(op.itob(walletId)).concat(owner)
      .concat(op.itob(operation)).concat(recipient.bytes)
      .concat(op.itob(assetId)).concat(op.itob(amount)).concat(op.itob(nonce))
      .concat(op.itob(expiry));
    assert(op.ed25519verifyBare(op.sha256(message), signature, this.digest(signals, 6)), "Invalid action signature");
  }

  protected digest(signals: PublicSignals, index: uint64): bytes<32> {
    const high = signals[index]!.bytes;
    const low = signals[index + 1]!.bytes;
    const zero = Bytes.fromHex("00000000000000000000000000000000");
    assert(high.slice(0, 16) === zero && low.slice(0, 16) === zero, "Noncanonical digest limb");
    return high.slice(16, 32).concat(low.slice(16, 32)).toFixed({ length: 32 });
  }

  override clearStateProgram(): boolean { return false; }
}
