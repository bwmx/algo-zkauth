// Display helpers and public-signal decoding (docs/phase3-protocol.md).
import { toBase64Url, type Operation } from "@algozkauth/protocol";

export const OPERATION_LABELS: Record<Operation, string> = { "0": "enrollment", "1": "ALGO transfer", "2": "ASA opt-in", "3": "ASA transfer" };

const LORA = "https://lora.algokit.io/testnet";
export const explorer = {
  tx: (id: string) => `${LORA}/transaction/${id}`,
  account: (address: string) => `${LORA}/account/${address}`,
  app: (id: string) => `${LORA}/application/${id}`,
  asset: (id: string) => `${LORA}/asset/${id}`,
};

export const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
export const shorten = (value: string, keep = 8) => (value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-keep)}` : value);
export const localTime = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleTimeString();

export function formatAlgo(micro: string | bigint, trim = false): string {
  const value = BigInt(micro);
  const whole = value / 1_000_000n;
  let fraction = (value % 1_000_000n).toString().padStart(6, "0");
  if (trim) fraction = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${whole.toLocaleString("en-US")}.${fraction} ALGO`;
}

// Every 256-bit public value is two 128-bit big-endian limbs.
export function signalBytes(signals: bigint[], index: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 2; i++) {
    let value = signals[index + i];
    if (value < 0n || value >= 1n << 128n) throw new Error("Noncanonical proof digest limb");
    for (let j = 15; j >= 0; j--) { bytes[i * 16 + j] = Number(value & 255n); value >>= 8n; }
  }
  return bytes;
}

export type DecodedSignals = {
  commitment: string;
  keyHash: string;
  audienceHash: string;
  sessionKey: string;
  genesisHash: string;
  expiresAt: number;
  notBefore: number;
};

export const SIGNAL_LAYOUT: { indexes: string; field: keyof DecodedSignals; meaning: string }[] = [
  { indexes: "0–1", field: "commitment", meaning: "Identity commitment: SHA-256 of issuer, audience, subject and salt" },
  { indexes: "2–3", field: "keyHash", meaning: "SHA-256 of the provider's RSA modulus that signed the token" },
  { indexes: "4–5", field: "audienceHash", meaning: "SHA-256 of the OAuth client ID (audience)" },
  { indexes: "6–7", field: "sessionKey", meaning: "Ed25519 session public key bound in the nonce" },
  { indexes: "8–9", field: "genesisHash", meaning: "Algorand network genesis hash bound in the nonce" },
  { indexes: "10", field: "expiresAt", meaning: "Session expiry (Unix seconds)" },
  { indexes: "11", field: "notBefore", meaning: "Not-before: max(iat − 60, nbf)" },
];

export function decodeSignals(publicSignals: string[]): DecodedSignals {
  if (publicSignals.length !== 12) throw new Error("Proof must have twelve public signals");
  const signals = publicSignals.map(BigInt);
  const digest = (index: number) => toBase64Url(signalBytes(signals, index));
  return {
    commitment: digest(0), keyHash: digest(2), audienceHash: digest(4), sessionKey: digest(6), genesisHash: digest(8),
    expiresAt: Number(signals[10]), notBefore: Number(signals[11]),
  };
}
