// Supported circuit profile is intentionally narrower than the OIDC preflight.
// JSON is compact, flat, unescaped ASCII, with these unique keys and types.
export const HEADER_KEYS = ["alg", "kid", "typ"];
export const PAYLOAD_KEYS = [
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
];
export const PAYLOAD_KINDS = PAYLOAD_KEYS.map((key) =>
  ["iat", "exp", "nbf", "auth_time"].includes(key)
    ? 1
    : key === "email_verified"
      ? 2
      : 0,
);
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

// Slack's profile. Slack serializes JSON with escaped forward slashes ("\/"),
// as its documented example token shows, so keys and issuer use that raw
// spelling in circuit. Kind 3 is a string whose only escape is "\/".
export const SLACK_PAYLOAD_KEYS = [
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
];
export const SLACK_PAYLOAD_KINDS = SLACK_PAYLOAD_KEYS.map((key) =>
  ["exp", "iat", "auth_time", "date_email_verified"].includes(key)
    ? 1
    : key === "email_verified"
      ? 2
      : ["iss", "email"].includes(key)
        ? 3
        : 0,
);

export const CIRCUIT_PROFILES = {
  google: {
    headerKeys: HEADER_KEYS,
    payloadKeys: PAYLOAD_KEYS,
    payloadKinds: PAYLOAD_KINDS,
    escapedSlashes: false,
    requireTyp: true,
  },
  slack: {
    headerKeys: HEADER_KEYS,
    payloadKeys: SLACK_PAYLOAD_KEYS,
    payloadKinds: SLACK_PAYLOAD_KINDS,
    escapedSlashes: true,
    requireTyp: false,
  },
};

export const rawJsonText = (text, escapedSlashes) =>
  escapedSlashes ? text.replaceAll("/", "\\/") : text;
