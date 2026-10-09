import {
  Account,
  Application,
  Bytes,
  Contract,
  Global,
  GlobalState,
  Txn,
  assert,
  type bytes,
  type uint64,
} from "@algorandfoundation/algorand-typescript";
import {
  abimethod,
  abiCall,
} from "@algorandfoundation/algorand-typescript/arc4";
import { type PublicSignals } from "./bn254_common.algo";
import { type Groth16Bn254Proof } from "./groth16_bn254.algo";
import { GoogleKeyRegistry } from "./google_key_registry.algo";

/** Phase 3 proof-policy gate. It holds no assets and authorizes no transfers. */
export class GoogleJwtAuthorization extends Contract {
  private verifier = GlobalState<Account>();
  private keyRegistry = GlobalState<Application>();
  private audience = GlobalState<bytes<32>>();

  @abimethod({ onCreate: "require" })
  createApplication(
    verifier: Account,
    keyRegistry: Application,
    audience: bytes<32>,
  ): void {
    assert(Txn.rekeyTo === Global.zeroAddress, "Rekey forbidden");
    assert(verifier !== Global.zeroAddress, "Verifier required");
    this.verifier.value = verifier;
    this.keyRegistry.value = keyRegistry;
    this.audience.value = audience;
  }

  // The pinned verifier LogicSig reads signals and proof from application args
  // 1 and 2 of this same transaction (APP_OFFSET=0). Checking its sender is what
  // prevents a caller from invoking this policy gate without proof verification.
  verifySession(signals: PublicSignals, proof: Groth16Bn254Proof): void {
    assert(Txn.rekeyTo === Global.zeroAddress, "Rekey forbidden");
    assert(Txn.sender === this.verifier.value, "Proof verifier required");
    assert(signals.length === 12, "Expected twelve public signals");
    const keyHash = this.digest(signals, 2);
    assert(this.digest(signals, 4) === this.audience.value, "Wrong audience");
    assert(this.digest(signals, 8) === Global.genesisHash, "Wrong network");
    abiCall<typeof GoogleKeyRegistry.prototype.assertAuthorizationWindow>({
      appId: this.keyRegistry.value,
      method: GoogleKeyRegistry.prototype.assertAuthorizationWindow,
      args: [keyHash, signals[11]!.asUint64(), signals[10]!.asUint64()],
      fee: 0,
    });
  }

  private digest(signals: PublicSignals, index: uint64): bytes<32> {
    const high = signals[index]!.bytes;
    const low = signals[index + 1]!.bytes;
    const zero = Bytes.fromHex("00000000000000000000000000000000");
    assert(high.slice(0, 16) === zero, "Noncanonical digest limb");
    assert(low.slice(0, 16) === zero, "Noncanonical digest limb");
    return high.slice(16, 32).concat(low.slice(16, 32)).toFixed({ length: 32 });
  }
}
