import test from "node:test";
import assert from "node:assert/strict";
import * as sdk from "../upstream/snarkjs-algorand/node_modules/algosdk/dist/esm/index.js";
import { confirmedGroupFromBlock } from "../src/phase6/receipts.mjs";

function fixture() {
  const genesisHash = new Uint8Array(32).fill(7);
  const address = sdk.encodeAddress(new Uint8Array(32).fill(3));
  const params = { fee: 1000, minFee: 1000, flatFee: true, firstValid: 10n, lastValid: 20n, genesisID: "testnet-v1.0", genesisHash };
  const txns = sdk.assignGroupID([1, 2, 3].map(amount => sdk.makePaymentTxnWithSuggestedParamsFromObject({ sender: address, receiver: address, amount, suggestedParams: params })));
  const item = txn => ({ signedTxn: new sdk.SignedTransaction({ txn }), applyData: {} });
  const payset = txns.map(txn => {
    const data = txn.toEncodingData(); data.delete("gen"); data.delete("gh");
    return { signedTxn: item(sdk.Transaction.fromEncodingData(data)), hasGenesisID: true, hasGenesisHash: false };
  });
  const inner = sdk.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: address, receiver: address, assetIndex: 90n, amount: 7n, suggestedParams: { ...params, fee: 0 } });
  payset[1].signedTxn.applyData = { applicationID: 34n, evalDelta: { logs: [new Uint8Array([1, 2])], innerTxns: [item(inner)] } };
  return { block: { header: { round: 12n, genesisID: params.genesisID, genesisHash }, payset }, ids: txns.map(txn => txn.txID()), expected: { round: 12n, genesisID: params.genesisID, genesisHash } };
}
test("historical receipts restore compressed genesis fields and preserve exact IDs and inner transfers", () => {
  const { block, ids, expected } = fixture();
  assert.notEqual(block.payset[0].signedTxn.signedTxn.txn.txID(), ids[0]);
  const receipts = confirmedGroupFromBlock(block, ids, expected);
  assert.deepEqual(receipts.map(r => r.txn.txn.txID()), ids);
  assert.equal(receipts[1].confirmedRound, 12n);
  assert.equal(receipts[1].applicationIndex, 34n);
  assert.equal(receipts[1].innerTxns[0].txn.txn.assetTransfer.amount, 7n);
  assert.equal(receipts[1].innerTxns[0].txn.txn.fee, 0n);
});
test("historical receipt selection rejects foreign rounds/networks and missing/reordered IDs", () => {
  const { block, ids, expected } = fixture();
  assert.throws(() => confirmedGroupFromBlock(block, ids, { ...expected, round: 13n }), /round or network/);
  assert.throws(() => confirmedGroupFromBlock(block, ids, { ...expected, genesisHash: new Uint8Array(32) }), /round or network/);
  assert.throws(() => confirmedGroupFromBlock(block, [...ids].reverse(), expected), /block order/);
  assert.throws(() => confirmedGroupFromBlock(block, [ids[0], "MISSING"], expected), /missing/);
  assert.throws(() => confirmedGroupFromBlock(block, [ids[0], ids[0]], expected), /Invalid recorded/);
  assert.throws(() => confirmedGroupFromBlock(block, ids.slice(0, 2), expected), /omit part/);
});
test("adjacent transactions with distinct groups cannot be accepted as one group", () => {
  const { block, ids, expected } = fixture();
  const data = block.payset[1].signedTxn.signedTxn.txn.toEncodingData();
  data.set("grp", new Uint8Array(32).fill(8)); data.set("gen", block.header.genesisID); data.set("gh", block.header.genesisHash);
  const replacement = sdk.Transaction.fromEncodingData(data); ids[1] = replacement.txID();
  data.delete("gen"); data.delete("gh"); block.payset[1].signedTxn.signedTxn = new sdk.SignedTransaction({ txn: sdk.Transaction.fromEncodingData(data) });
  assert.throws(() => confirmedGroupFromBlock(block, ids, expected), /one atomic group/);
});
