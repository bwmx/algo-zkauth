import {
  Account, Application, Asset, Global, GlobalState, Txn,
  assert, ensureBudget, OpUpFeeSource, itxn, type bytes, type uint64,
} from "@algorandfoundation/algorand-typescript";
import { abimethod } from "@algorandfoundation/algorand-typescript/arc4";
import { type PublicSignals } from "./bn254_common.algo";
import { type Groth16Bn254Proof } from "./groth16_bn254.algo";
import { WalletAuthorization } from "./wallet_authorization.algo";

/** An immutable asset-holding wallet created only by an inner application call. */
export class UserWallet extends WalletAuthorization {
  private owner = GlobalState<bytes<32>>();
  private registry = GlobalState<uint64>();
  private nonce = GlobalState<uint64>({ initialValue: 0 });

  @abimethod({ onCreate: "require" })
  createApplication(owner: bytes<32>, verifier: Account, keyRegistry: Application, audience: bytes<32>): void {
    assert(Global.callerApplicationId !== 0, "Registry creation required");
    assert(Txn.sender === Global.callerApplicationAddress, "Registry sender required");
    this.initializePolicy(verifier, keyRegistry, audience);
    this.owner.value = owner;
    this.registry.value = Global.callerApplicationId;
  }

  // All transfer fields are signed; unused fields have one canonical value.
  execute(
    signals: PublicSignals, proof: Groth16Bn254Proof, operation: uint64,
    recipient: Account, assetId: uint64, amount: uint64, nonce: uint64,
    signature: bytes<64>,
  ): void {
    ensureBudget(1500, OpUpFeeSource.GroupCredit);
    assert(Txn.groupIndex === 0, "Wallet call must lead group");
    assert(nonce === this.nonce.value, "Wrong action nonce");
    assert(recipient !== Global.zeroAddress, "Recipient required");
    if (operation === 1) {
      assert(assetId === 0 && amount > 0, "Invalid ALGO action");
    } else if (operation === 2) {
      assert(assetId > 0 && amount === 0 && recipient === Global.currentApplicationAddress, "Invalid opt-in action");
    } else {
      assert(operation === 3 && assetId > 0 && amount > 0, "Invalid ASA action");
    }
    this.authorize(signals, signature, this.registry.value, Global.currentApplicationId.id,
      this.owner.value, operation, recipient, assetId, amount, nonce);
    // Any failed inner transfer rolls this increment back with the whole group.
    this.nonce.value = nonce + 1;
    if (operation === 1) {
      itxn.payment({ receiver: recipient, amount, fee: 0 }).submit();
    } else {
      itxn.assetTransfer({ xferAsset: Asset(assetId), assetReceiver: recipient, assetAmount: amount, fee: 0 }).submit();
    }
  }

  @abimethod({ readonly: true })
  getNonce(): uint64 {
    assert(Txn.rekeyTo === Global.zeroAddress, "Rekey forbidden");
    return this.nonce.value;
  }
}
