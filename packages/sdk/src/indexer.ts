// Read-only wallet history from an Algorand indexer. The address and its transactions are public chain data.
import { ZkAuthError } from "./errors.ts";
import type { HistoryItem } from "./types.ts";

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
  if (t["tx-type"] === "pay" && t["payment-transaction"]) return { amount: BigInt(t["payment-transaction"].amount), assetId: 0n, receiver: t["payment-transaction"].receiver };
  if (t["tx-type"] === "axfer" && t["asset-transfer-transaction"]) {
    const a = t["asset-transfer-transaction"];
    return { amount: BigInt(a.amount), assetId: BigInt(a["asset-id"]), receiver: a.receiver };
  }
  return undefined;
};

/** Summarizes root transactions, including the wallet's inner transfers. */
export function summarizeHistory(txns: IndexerTxn[], address: string, walletId: bigint): HistoryItem[] {
  return txns.map((t): HistoryItem => {
    const base = { txId: t.id, round: BigInt(t["confirmed-round"] ?? 0), time: t["round-time"] ?? 0 };
    const none = { amount: 0n, assetId: 0n };
    const app = t["application-transaction"] ? BigInt(t["application-transaction"]["application-id"]) : undefined;
    const inner = (t["inner-txns"] ?? []).map((i) => ({ sender: i.sender, ...transfer(i) }))
      .filter((i): i is { sender: string; amount: bigint; assetId: bigint; receiver: string } => !!i.receiver);
    if (app === walletId) {
      const out = inner.find((i) => i.sender === address);
      if (!out) return { ...base, ...none, type: "other" };
      if (out.assetId !== 0n && out.amount === 0n && out.receiver === address) return { ...base, ...none, type: "opt-in", assetId: out.assetId };
      return { ...base, type: "sent", amount: out.amount, assetId: out.assetId, counterparty: out.receiver };
    }
    const received = inner.find((i) => i.receiver === address);
    if (app !== undefined && received) return { ...base, type: "enrollment", amount: received.amount, assetId: received.assetId, counterparty: received.sender };
    const direct = transfer(t);
    if (direct?.receiver === address) return { ...base, type: "received", amount: direct.amount, assetId: direct.assetId, counterparty: t.sender };
    return { ...base, ...none, type: "other" };
  });
}

export async function fetchHistory(
  fetchFn: typeof fetch, indexerUrl: string, address: string, walletId: bigint, limit: number,
): Promise<HistoryItem[]> {
  let response: Response;
  try {
    response = await fetchFn(`${indexerUrl.replace(/\/+$/, "")}/v2/accounts/${address}/transactions?limit=${limit}`, { cache: "no-store" });
  } catch (cause) {
    throw new ZkAuthError("service_unavailable", "The indexer is unreachable", { cause });
  }
  if (!response.ok) throw new ZkAuthError("service_unavailable", "The indexer is unavailable");
  const value = (await response.json()) as { transactions?: IndexerTxn[] };
  return summarizeHistory(value.transactions ?? [], address, walletId);
}
