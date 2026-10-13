import { fromBase64Url, toBase64Url } from "./shared";
import type { ApprovedKey, Operation, ProviderId } from "./types";

// Each provider has its own circuit and deployment; a tab uses one, chosen with ?provider=.
export const PROVIDER_LABELS: Record<ProviderId, string> = { google: "Google", slack: "Slack" };
export const providerFromSearch = (search: string): ProviderId => (new URLSearchParams(search).get("provider") === "slack" ? "slack" : "google");

export const OPERATION_LABELS: Record<Operation, string> = { "0": "enrollment", "1": "ALGO transfer", "2": "ASA opt-in", "3": "ASA transfer" };

// Recorded genuine Google proofs took 124.751–130.697 seconds on the demo Mac.
export const TYPICAL_PROOF_MS = 130_000;
export const SESSION_SECONDS = 600;
// The full demo is up to seven TestNet groups plus funding, about 20–30 s in
// recorded runs; the server also refuses a proof with under 15 s left.
export const DEMO_RUN_SECONDS = 90;
export const CIRCUIT_SIGNED_BYTES = 1015;

const LORA = "https://lora.algokit.io/testnet";
export const explorer = {
  tx: (id: string) => `${LORA}/transaction/${id}`,
  account: (address: string) => `${LORA}/account/${address}`,
  app: (id: string) => `${LORA}/application/${id}`,
  asset: (id: string) => `${LORA}/asset/${id}`,
};

export const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
export const shorten = (value: string, keep = 8) => (value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-keep)}` : value);

export function formatAlgo(micro: string | bigint, trim = false): string {
  const value = BigInt(micro);
  const whole = value / 1_000_000n;
  let fraction = (value % 1_000_000n).toString().padStart(6, "0");
  if (trim) fraction = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${whole.toLocaleString("en-US")}.${fraction} ALGO`;
}

/** Converts a decimal ALGO amount to µALGO without floating point. */
export function parseAlgo(text: string): string {
  const match = /^(0|[1-9][0-9]{0,12})(?:\.([0-9]{1,6}))?$/.exec(text.trim());
  if (!match) throw new Error("Enter an ALGO amount such as 0.01, with at most six decimal places");
  const micro = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (micro === 0n) throw new Error("Enter a positive amount");
  return micro.toString();
}

export function parseUnits(text: string): string {
  const value = text.trim();
  if (!/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > 0xffffffffffffffffn) throw new Error("Enter a positive whole number of demo ASA units");
  return value;
}

export const spendable = (balance: string, minimum: string) => {
  const value = BigInt(balance) - BigInt(minimum);
  return value > 0n ? value : 0n;
};

// Every 256-bit public value is two 128-bit big-endian limbs (docs/phase3-protocol.md).
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

export type BindingCheck = { label: string; ok: boolean; required: boolean; detail: string };

/** The browser independently checks a proof's public bindings before signing anything with it. */
export function proofBindingChecks(
  decoded: DecodedSignals,
  expected: { commitment: string; audienceHash: string; genesisHash: string; sessionKey: string; expiresAt: number; approvedKeys: ApprovedKey[] },
): BindingCheck[] {
  const key = expected.approvedKeys.find(k => k.fingerprint === decoded.keyHash);
  return [
    { label: "Identity commitment", ok: decoded.commitment === expected.commitment, required: true, detail: "Matches the salt and login identity in this tab" },
    { label: "Audience", ok: decoded.audienceHash === expected.audienceHash, required: true, detail: "Matches this deployment's OAuth client ID" },
    { label: "Network", ok: decoded.genesisHash === expected.genesisHash, required: true, detail: "Matches the TestNet genesis hash" },
    { label: "Session key", ok: decoded.sessionKey === expected.sessionKey, required: true, detail: "Matches the nonextractable key held in this tab" },
    { label: "Session expiry", ok: decoded.expiresAt === expected.expiresAt, required: true, detail: "Matches the expiry this tab committed to in the nonce" },
    {
      label: "Signing key",
      ok: !!key,
      required: false,
      detail: key
        ? `Approved in the key registry until ${new Date(Number(key.validUntil) * 1000).toLocaleString()}`
        : "Not in the local deployment record; the wallet checks the on-chain key registry",
    },
  ];
}

export type TokenSummary = {
  alg?: string;
  kid?: string;
  iss?: string;
  aud?: string;
  sub?: string;
  iat?: number;
  exp?: number;
  nbf?: number;
  nonce?: string;
  signedBytes: number;
  claimNames: string[];
};

/** Decodes the token in this tab for display only; the server verifies it. */
export function summarizeToken(token: string): TokenSummary | undefined {
  try {
    const [header, payload] = token.split(".");
    const json = (part: string) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(part, 1, 4096)));
    const h = json(header);
    const p = json(payload);
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    const time = (v: unknown) => (typeof v === "number" ? v : undefined);
    return {
      alg: text(h.alg), kid: text(h.kid), iss: text(p.iss), aud: text(p.aud),
      sub: typeof p.sub === "string" ? `${p.sub.slice(0, 4)}…${p.sub.slice(-2)}` : undefined,
      iat: time(p.iat), exp: time(p.exp), nbf: time(p.nbf), nonce: text(p.nonce),
      signedBytes: header.length + 1 + payload.length, claimNames: Object.keys(p),
    };
  } catch {
    return undefined;
  }
}

export const localTime = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleTimeString();
