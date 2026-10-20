import { ZkAuthError } from "./errors.ts";
import type { AssetId, MicroAlgos } from "./types.ts";

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ZkAuthError("login_cancelled", "Cancelled"));
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new ZkAuthError("login_cancelled", "Cancelled")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A tiny typed-by-convention event emitter; a throwing listener never breaks the others. */
export class Emitter {
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => { set.delete(listener); };
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try { listener(...args); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }

  clear() { this.listeners.clear(); }
}

/** "1.5" or 1.5 ALGO -> µALGO, without floating point. */
export function algo(amount: number | string): { microAlgo: bigint } {
  const text = typeof amount === "number" && Number.isFinite(amount) ? String(amount) : String(amount).trim();
  const match = /^(\d{1,13})(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) throw new ZkAuthError("bad_request", "Invalid ALGO amount: use a decimal such as 1.5 with at most six decimal places");
  return { microAlgo: BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0")) };
}

export function toMicroAlgos(amount: MicroAlgos): bigint {
  let value: unknown = amount;
  if (typeof amount === "object" && amount !== null) value = "microAlgo" in amount ? amount.microAlgo : amount.microAlgos;
  if (typeof value === "number" && Number.isSafeInteger(value)) value = BigInt(value);
  if (typeof value !== "bigint" || value < 0n || value > 0xffffffffffffffffn) throw new ZkAuthError("bad_request", "Invalid amount: use a whole number of µALGO or algo(\"1.5\")");
  return value;
}

export function toAssetId(id: AssetId): bigint {
  const value = typeof id === "number" && Number.isSafeInteger(id) ? BigInt(id) : id;
  if (typeof value !== "bigint" || value <= 0n || value > 0xffffffffffffffffn) throw new ZkAuthError("bad_request", "Invalid asset id");
  return value;
}

export function formatAlgo(amount: MicroAlgos, o: { trim?: boolean } = {}): string {
  const value = toMicroAlgos(amount);
  let fraction = (value % 1_000_000n).toString().padStart(6, "0");
  if (o.trim) fraction = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${(value / 1_000_000n).toString()}.${fraction} ALGO`;
}

/** Saves a backup file through the browser's download UI (a convenience for `backup.create()` / `export()` results). */
export function downloadBackup(backup: { file: Blob; fileName: string }): void {
  const url = URL.createObjectURL(backup.file);
  const link = document.createElement("a");
  link.href = url;
  link.download = backup.fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
