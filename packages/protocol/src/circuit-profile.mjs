// Supported circuit profiles are intentionally narrower than the OIDC
// preflight. JSON is compact and flat, with each profile's unique keys and
// types. Value kinds: 0 printable ASCII string without escapes, 1 uint32
// time, 2 boolean, 3 string whose only escape is "\/".
export const HEADER_KEYS = ["alg", "kid", "typ"];
export const MESSAGE_CAPACITY = 1024;
export const HEADER_CAPACITY = 128;
export const PAYLOAD_CAPACITY = 896;
export const VALUE_CAPACITY = 255;
export const PUBLIC_SIGNAL_ORDER = [
  "identityHigh",
  "identityLow",
  "keyHashHigh",
  "keyHashLow",
  "audienceHashHigh",
  "audienceHashLow",
  "sessionKeyHigh",
  "sessionKeyLow",
  "genesisHashHigh",
  "genesisHashLow",
  "sessionExpiresAt",
  "notBefore",
];

export function packedKey(key) {
  return [...Buffer.from(key, "ascii")]
    .reduce((value, byte, i) => value + (BigInt(byte) << BigInt(i * 8)), 0n)
    .toString();
}

export const rawJsonText = (text, escapedSlashes) =>
  escapedSlashes ? text.replaceAll("/", "\\/") : text;

function profile({ payloadKeys, times, booleans = [], escapedStrings = [], ...rules }) {
  return Object.freeze({
    headerKeys: HEADER_KEYS,
    payloadKeys: Object.freeze(payloadKeys),
    payloadKinds: Object.freeze(payloadKeys.map((key) =>
      times.includes(key) ? 1 : booleans.includes(key) ? 2 : escapedStrings.includes(key) ? 3 : 0,
    )),
    ...rules,
  });
}

// Each profile also drives scripts/build/write-jwt-circuit.mjs:
// - requiredClaims: present exactly once (the subject scope claim included);
// - authorizedPartyClaim: optional, equal to aud when present;
// - notBeforeClaim: optional, raises the public notBefore when later;
// - escapedSlashes: the provider signs "/" as "\/" in keys and kind-3 values;
// - requireTyp: header typ must be present, otherwise optional.
// The issuer spellings, subject scope and session-expiry rule come from the
// provider (oidc-providers.mjs).
export const CIRCUIT_PROFILES = Object.freeze({
  google: profile({
    payloadKeys: [
      "iss",
      "azp",
      "aud",
      "sub",
      "hd",
      "email",
      "email_verified",
      "nonce",
      "nbf",
      "name",
      "picture",
      "given_name",
      "family_name",
      "iat",
      "exp",
      "jti",
      "at_hash",
      "auth_time",
    ],
    times: ["iat", "exp", "nbf", "auth_time"],
    booleans: ["email_verified"],
    requiredClaims: ["iss", "aud", "sub", "nonce", "iat", "exp"],
    authorizedPartyClaim: "azp",
    notBeforeClaim: "nbf",
    escapedSlashes: false,
    requireTyp: true,
  }),
  // Slack serializes JSON with escaped forward slashes ("\/"), as its
  // documented example token shows, so keys and issuer use that raw spelling
  // in circuit.
  slack: profile({
    payloadKeys: [
      "iss",
      "sub",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "nonce",
      "at_hash",
      "https://slack.com/team_id",
      "https://slack.com/user_id",
      "email",
      "email_verified",
      "date_email_verified",
      "locale",
    ],
    times: ["exp", "iat", "auth_time", "date_email_verified"],
    booleans: ["email_verified"],
    escapedStrings: ["iss", "email"],
    requiredClaims: ["iss", "sub", "aud", "nonce", "iat", "exp", "https://slack.com/team_id"],
    escapedSlashes: true,
    requireTyp: false,
  }),
});

export function circuitProfile(provider) {
  if (!Object.hasOwn(CIRCUIT_PROFILES, provider?.id)) throw new Error("Login provider has no circuit profile");
  return CIRCUIT_PROFILES[provider.id];
}
