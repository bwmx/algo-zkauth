// Development fixtures only: an RS256 token shaped like the provider's, with
// exactly the claims its circuit profile requires, signed by a local key. It
// carries no real credential and verifies only against the matching local JWKS.
import { sign } from "node:crypto";
import { circuitProfile, rawJsonText } from "./circuit-profile.mjs";

export function syntheticToken(provider, { privateKey, kid, audience, subject, subjectScope = "T0SYNTHETIC", nonce, issuedAt }) {
  const profile = circuitProfile(provider);
  // A provider whose session may outlive its token gets a five-minute token,
  // as Slack issues; otherwise one hour.
  const values = {
    iss: provider.issuer, aud: audience, sub: subject, nonce, iat: issuedAt,
    exp: issuedAt + (provider.sessionWithinTokenExpiry ? 3600 : 300),
    ...(provider.subjectScope ? { [provider.subjectScope.claim]: subjectScope } : {}),
  };
  const missing = profile.requiredClaims.filter((claim) => !Object.hasOwn(values, claim));
  if (missing.length) throw new Error(`No synthetic value for required claim ${missing.join(", ")}`);
  const claims = Object.fromEntries(profile.payloadKeys.filter((key) => profile.requiredClaims.includes(key)).map((key) => [key, values[key]]));
  const message = [{ alg: "RS256", kid, typ: "JWT" }, claims]
    .map((value) => Buffer.from(rawJsonText(JSON.stringify(value), profile.escapedSlashes)).toString("base64url"))
    .join(".");
  return `${message}.${sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64url")}`;
}
