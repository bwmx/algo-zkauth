import { createHash } from "node:crypto";
import { providerForIssuer } from "./oidc-providers.mjs";

const DOMAIN = Buffer.from("algorand-zklogin-identity-v1\0", "ascii");

function asciiClaim(value, name, maxLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new Error(`${name} must be 1–${maxLength} visible ASCII bytes`);
  }
  return Buffer.from(value, "ascii");
}

function appendLengthPrefixed(hash, bytes) {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  hash.update(length).update(bytes);
}

// Accepted issuer spellings map to the provider's canonical issuer. A
// workspace-scoped subject is "scope/sub", e.g. Slack's "team/sub" (see
// identitySubject).
export function identityCommitment({ issuer, audience, subject, salt }) {
  const canonicalIssuer = providerForIssuer(issuer).issuer;
  const saltBytes = Buffer.from(salt);
  if (saltBytes.length !== 32) throw new Error("Wallet salt must be 32 bytes");
  const hash = createHash("sha256").update(DOMAIN);
  appendLengthPrefixed(hash, Buffer.from(canonicalIssuer, "ascii"));
  appendLengthPrefixed(hash, asciiClaim(audience, "Audience", 255));
  appendLengthPrefixed(hash, asciiClaim(subject, "Subject", 255));
  const digest = hash.update(saltBytes).digest();
  return {
    digest,
    high128: BigInt(`0x${digest.subarray(0, 16).toString("hex")}`),
    low128: BigInt(`0x${digest.subarray(16).toString("hex")}`),
  };
}
