import { SignedTransaction } from "../../upstream/snarkjs-algorand/node_modules/algosdk/dist/esm/index.js";
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

// Historical blocks retain application execution data after the pending-txn
// endpoint's 1,000-round window. Block encoding compresses outer genesis fields;
// restore them before hashing and require the exact recorded transaction IDs.
export function confirmedGroupFromBlock(block, transactionIds, expected) {
  const header = block.header;
  if (header.round !== BigInt(expected.round) || header.genesisID !== expected.genesisID || !same(header.genesisHash, expected.genesisHash)) throw new Error("Historical block round or network differs");
  if (!transactionIds.length || new Set(transactionIds).size !== transactionIds.length) throw new Error("Invalid recorded transaction IDs");
  const receipt = (item, signedTxn = item.signedTxn) => ({
    txn: signedTxn, confirmedRound: header.round, poolError: "",
    applicationIndex: item.applyData.applicationID,
    assetIndex: item.applyData.configAsset,
    logs: item.applyData.evalDelta?.logs ?? [],
    innerTxns: (item.applyData.evalDelta?.innerTxns ?? []).map(inner => receipt(inner)),
  });
  const outer = block.payset.map(entry => {
    const data = entry.signedTxn.signedTxn.toEncodingData();
    const txn = data.get("txn");
    if (entry.hasGenesisID) txn.set("gen", header.genesisID);
    if (entry.hasGenesisHash || !txn.get("gh")) txn.set("gh", header.genesisHash);
    data.set("txn", txn);
    const signed = SignedTransaction.fromEncodingData(data);
    return receipt(entry.signedTxn, signed);
  });
  const indexes = transactionIds.map(id => outer.findIndex(r => r.txn.txn.txID() === id));
  if (indexes.some((index, i) => index < 0 || index !== indexes[0] + i)) throw new Error("Recorded transactions are missing or out of block order");
  const selected = indexes.map(index => outer[index]);
  if (!selected[0].txn.txn.group || !selected.every(r => same(r.txn.txn.group, selected[0].txn.txn.group))) throw new Error("Historical transactions are not one atomic group");
  if (outer.filter(r => r.txn.txn.group && same(r.txn.txn.group, selected[0].txn.txn.group)).length !== selected.length) throw new Error("Recorded transactions omit part of the atomic group");
  return selected;
}
