// Read-only wallet history from the public AlgoNode TestNet indexer. The
// wallet address and its transactions are already public chain data.
export const INDEXER = "https://testnet-idx.algonode.cloud";

export type HistoryItem = {
  id: string;
  round: number;
  time: number;
  label: string;
  direction: "in" | "out" | "none";
  amount?: string;
  assetId?: string;
  counterparty?: string;
};

type IndexerTxn = {
  id: string;
  "tx-type": string;
  sender: string;
  "confirmed-round"?: number;
  "round-time"?: number;
  "payment-transaction"?: { amount: number | string; receiver: string };
  "asset-transfer-transaction"?: { amount: number | string; "asset-id": number | string; receiver: string };
  "application-transaction"?: { "application-id": number | string };
  "inner-txns"?: IndexerTxn[];
};

const transfer = (t: IndexerTxn) => {
  if (t["tx-type"] === "pay" && t["payment-transaction"]) return { amount: String(t["payment-transaction"].amount), assetId: "0", receiver: t["payment-transaction"].receiver };
  if (t["tx-type"] === "axfer" && t["asset-transfer-transaction"]) {
    const a = t["asset-transfer-transaction"];
    return { amount: String(a.amount), assetId: String(a["asset-id"]), receiver: a.receiver };
  }
};

/** Summarizes root transactions, including the wallet's inner transfers. */
export function summarizeHistory(txns: IndexerTxn[], address: string, walletId: string): HistoryItem[] {
  return txns.map(t => {
    const base = { id: t.id, round: t["confirmed-round"] ?? 0, time: t["round-time"] ?? 0 };
    const app = t["application-transaction"] && String(t["application-transaction"]["application-id"]);
    const inner = (t["inner-txns"] ?? []).map(i => ({ sender: i.sender, ...transfer(i) })).filter(i => i.receiver);
    if (app === walletId) {
      const out = inner.find(i => i.sender === address);
      if (!out) return { ...base, label: "Wallet call", direction: "none" as const };
      if (out.assetId !== "0" && out.amount === "0" && out.receiver === address) return { ...base, label: "ASA opt-in", direction: "none" as const, assetId: out.assetId };
      return { ...base, label: "Signed transfer", direction: "out" as const, amount: out.amount, assetId: out.assetId, counterparty: out.receiver };
    }
    const received = inner.find(i => i.receiver === address);
    if (app && received) return { ...base, label: "Enrollment", direction: "in" as const, amount: received.amount, assetId: received.assetId, counterparty: received.sender };
    const direct = transfer(t);
    if (direct?.receiver === address) return { ...base, label: direct.assetId === "0" ? "Received ALGO" : "Received ASA", direction: "in" as const, amount: direct.amount, assetId: direct.assetId, counterparty: t.sender };
    return { ...base, label: t["tx-type"], direction: "none" as const };
  });
}

export async function fetchHistory(address: string, walletId: string): Promise<HistoryItem[]> {
  const response = await fetch(`${INDEXER}/v2/accounts/${address}/transactions?limit=50`, { cache: "no-store" });
  if (!response.ok) throw new Error("TestNet indexer unavailable");
  const value = await response.json();
  return summarizeHistory(value.transactions ?? [], address, walletId);
}

export async function fetchAssetUnit(assetId: string): Promise<string | undefined> {
  const response = await fetch(`${INDEXER}/v2/assets/${assetId}`);
  if (!response.ok) return undefined;
  const value = await response.json();
  const unit = value.asset?.params?.["unit-name"];
  return typeof unit === "string" ? unit : undefined;
}
