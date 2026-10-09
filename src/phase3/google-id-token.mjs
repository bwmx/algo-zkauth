import { constants, createHash, createPublicKey, verify } from "node:crypto";

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const utf8 = new TextDecoder("utf-8", { fatal: true });

function requireRecord(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value;
}

// JSON.parse silently accepts duplicate claim names. JWT policy must not.
export function parseUniqueJson(source) {
  if (typeof source !== "string") throw new Error("JSON input must be text");
  let pos = 0;
  const skipSpace = () => {
    while (/[\x20\t\r\n]/.test(source[pos] ?? "")) pos++;
  };
  const parseString = () => {
    if (source[pos] !== '"') throw new Error("Expected JSON string");
    const start = pos++;
    while (pos < source.length) {
      const char = source[pos++];
      if (char === '"') return JSON.parse(source.slice(start, pos));
      if (char === "\\") pos++;
      else if (char.charCodeAt(0) < 32) throw new Error("Invalid JSON string");
    }
    throw new Error("Unterminated JSON string");
  };
  const parseValue = (depth) => {
    if (depth > 16) throw new Error("JSON nesting limit exceeded");
    skipSpace();
    if (source[pos] === '"') return parseString();
    if (source[pos] === "{") {
      pos++;
      const object = Object.create(null);
      skipSpace();
      if (source[pos] === "}") {
        pos++;
        return object;
      }
      while (true) {
        skipSpace();
        const key = parseString();
        if (Object.hasOwn(object, key)) throw new Error("Duplicate JSON key");
        skipSpace();
        if (source[pos++] !== ":") throw new Error("Expected JSON colon");
        object[key] = parseValue(depth + 1);
        skipSpace();
        const delimiter = source[pos++];
        if (delimiter === "}") return object;
        if (delimiter !== ",")
          throw new Error("Expected JSON object delimiter");
      }
    }
    if (source[pos] === "[") {
      pos++;
      const array = [];
      skipSpace();
      if (source[pos] === "]") {
        pos++;
        return array;
      }
      while (true) {
        array.push(parseValue(depth + 1));
        skipSpace();
        const delimiter = source[pos++];
        if (delimiter === "]") return array;
        if (delimiter !== ",") throw new Error("Expected JSON array delimiter");
      }
    }
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (source.startsWith(literal, pos)) {
        pos += literal.length;
        return value;
      }
    }
    const number = source
      .slice(pos)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) throw new Error("Invalid JSON value");
    pos += number[0].length;
    const value = Number(number[0]);
    if (!Number.isFinite(value)) throw new Error("Invalid JSON number");
    return value;
  };
  const value = parseValue(0);
  skipSpace();
  if (pos !== source.length) throw new Error("Trailing JSON data");
  return value;
}

function decodeBase64Url(part, name, maxBytes) {
  if (typeof part !== "string" || !/^[A-Za-z0-9_-]+$/.test(part)) {
    throw new Error(`Invalid ${name} encoding`);
  }
  const bytes = Buffer.from(part, "base64url");
  if (
    bytes.length === 0 ||
    bytes.length > maxBytes ||
    bytes.toString("base64url") !== part
  ) {
    throw new Error(`Invalid ${name} length or canonical encoding`);
  }
  return bytes;
}

function integerClaim(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name} claim`);
  }
  return value;
}

export function verifyGoogleIdToken(
  token,
  { audience, nonce, jwks, nowSeconds = Math.floor(Date.now() / 1000) },
) {
  if (typeof audience !== "string" || audience.length === 0) {
    throw new Error("Expected Google OAuth client ID is required");
  }
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new Error("Expected nonce is required");
  }
  if (typeof token !== "string" || token.length > 12_000) {
    throw new Error("Invalid ID token length");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("ID token must have three parts");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = requireRecord(
    parseUniqueJson(
      utf8.decode(decodeBase64Url(encodedHeader, "JWT header", 2048)),
    ),
    "JWT header",
  );
  const claims = requireRecord(
    parseUniqueJson(
      utf8.decode(decodeBase64Url(encodedPayload, "JWT payload", 8192)),
    ),
    "JWT payload",
  );
  const signature = decodeBase64Url(encodedSignature, "JWT signature", 512);

  if (
    header.alg !== "RS256" ||
    (header.typ !== undefined && header.typ !== "JWT")
  ) {
    throw new Error("Unsupported JWT header");
  }
  if (
    header.crit !== undefined ||
    typeof header.kid !== "string" ||
    header.kid.length === 0
  ) {
    throw new Error("Invalid JWT key ID or critical header");
  }
  if (
    claims.iss !== "https://accounts.google.com" &&
    claims.iss !== "accounts.google.com"
  ) {
    throw new Error("Invalid Google issuer");
  }
  if (
    claims.aud !== audience ||
    (claims.azp !== undefined && claims.azp !== audience)
  ) {
    throw new Error("Invalid Google audience or authorized party");
  }
  if (
    typeof claims.sub !== "string" ||
    !/^[\x21-\x7e]{1,255}$/.test(claims.sub)
  ) {
    throw new Error("Invalid Google subject");
  }
  if (claims.nonce !== nonce) throw new Error("Invalid Google nonce");
  const issuedAt = integerClaim(claims.iat, "iat");
  const expiresAt = integerClaim(claims.exp, "exp");
  const now = integerClaim(nowSeconds, "current time");
  if (
    issuedAt > now + 60 ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 7200
  ) {
    throw new Error("ID token is expired or outside the allowed time window");
  }
  if (claims.nbf !== undefined && integerClaim(claims.nbf, "nbf") > now) {
    throw new Error("ID token is not yet valid");
  }

  if (!jwks || !Array.isArray(jwks.keys))
    throw new Error("Google JWKS is required");
  const matches = jwks.keys.filter((key) => key?.kid === header.kid);
  if (matches.length !== 1)
    throw new Error("Google key ID is missing or ambiguous");
  const key = matches[0];
  if (
    key.kty !== "RSA" ||
    (key.alg !== undefined && key.alg !== "RS256") ||
    (key.use !== undefined && key.use !== "sig") ||
    key.e !== "AQAB"
  ) {
    throw new Error("Unsupported Google signing key");
  }
  const modulus = decodeBase64Url(key.n, "RSA modulus", 512);
  if (
    modulus.length !== 256 ||
    (modulus[0] & 0x80) === 0 ||
    signature.length !== 256
  ) {
    throw new Error(
      "Only RSA-2048 Google keys are supported by this circuit profile",
    );
  }
  const publicKey = createPublicKey({ key, format: "jwk" });
  const signedBytes = Buffer.from(
    `${encodedHeader}.${encodedPayload}`,
    "ascii",
  );
  if (
    !verify(
      "RSA-SHA256",
      signedBytes,
      { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
      signature,
    )
  ) {
    throw new Error("Invalid Google ID token signature");
  }
  return {
    issuer: claims.iss,
    audience,
    subject: claims.sub,
    nonce,
    issuedAt,
    expiresAt,
    keyId: header.kid,
    modulusSha256: createHash("sha256").update(modulus).digest("hex"),
  };
}

export async function fetchGoogleJwks() {
  const response = await fetch(JWKS_URL, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`Google JWKS request failed: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 100_000)
    throw new Error("Google JWKS response is too large");
  return requireRecord(parseUniqueJson(text), "Google JWKS");
}
