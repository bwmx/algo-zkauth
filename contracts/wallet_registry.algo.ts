import {
  Account, Application, BoxMap, Global, Txn, assert, ensureBudget, OpUpFeeSource, gtxn, itxn,
  type bytes, type uint64,
} from "@algorandfoundation/algorand-typescript";
import { abimethod, compileArc4 } from "@algorandfoundation/algorand-typescript/arc4";
import { type PublicSignals } from "./bn254_common.algo";
import { type Groth16Bn254Proof } from "./groth16_bn254.algo";
import { WalletAuthorization } from "./wallet_authorization.algo";
import { UserWallet } from "./user_wallet.algo";

/** One canonical wallet per identity commitment, with atomic funding/creation. */
export class WalletRegistry extends WalletAuthorization {
  private wallets = BoxMap<bytes<32>, uint64>({ keyPrefix: "w:" });

  @abimethod({ onCreate: "require" })
  createApplication(verifier: Account, keyRegistry: Application, audience: bytes<32>): void {
    this.initializePolicy(verifier, keyRegistry, audience);
  }

  @abimethod({ readonly: true })
  enrollmentDeposit(): uint64 {
    const wallet = compileArc4(UserWallet);
    // Creator schema/pages + permanent discovery box (34-byte key, 8 value)
    // + new wallet's account minimum. Registry's base 100k is funded separately.
    return 100000 * (1 + wallet.extraProgramPages) + 28500 * wallet.globalUints
      + 50000 * wallet.globalBytes + 2500 + 400 * (34 + 8) + 100000;
  }

  enroll(signals: PublicSignals, proof: Groth16Bn254Proof, payer: Account, signature: bytes<64>): uint64 {
    ensureBudget(1500, OpUpFeeSource.GroupCredit);
    assert(Txn.groupIndex === 1, "Enrollment payment must precede call");
    const deposit = this.enrollmentDeposit();
    const payment = gtxn.PaymentTxn(0);
    assert(payment.sender === payer && payment.receiver === Global.currentApplicationAddress, "Wrong enrollment payer");
    assert(payment.amount === deposit, "Wrong enrollment deposit");
    assert(payment.rekeyTo === Global.zeroAddress && payment.closeRemainderTo === Global.zeroAddress, "Unsafe enrollment payment");
    assert(signals.length === 12, "Expected twelve public signals");
    const owner = this.digest(signals, 0);
    this.authorize(signals, signature, Global.currentApplicationId.id, 0, owner, 0, payer, 0, deposit, 0);
    assert(!this.wallets(owner).exists, "Wallet already registered");
    const wallet = compileArc4(UserWallet);
    const created = wallet.call.createApplication({
      args: [owner, this.verifier.value, this.keyRegistry.value, this.audience.value], fee: 0,
    }).itxn.createdApp;
    this.wallets(owner).value = created.id;
    itxn.payment({ receiver: created.address, amount: 100000, fee: 0 }).submit();
    return created.id;
  }

  @abimethod({ readonly: true })
  lookup(owner: bytes<32>): uint64 {
    assert(Txn.rekeyTo === Global.zeroAddress, "Rekey forbidden");
    if (!this.wallets(owner).exists) return 0;
    return this.wallets(owner).value;
  }
}
