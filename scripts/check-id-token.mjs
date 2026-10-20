// Checks a captured ID token against the provider's live JWKS and prints only
// hashed or public values. Reads <PREFIX>_CLIENT_ID, <PREFIX>_EXPECTED_NONCE
// and <PREFIX>_ID_TOKEN, as the local Google capture page writes them.
// Usage: node --env-file=.env scripts/check-id-token.mjs [provider]
import { createHash } from "node:crypto";
import { fetchJwks, verifyIdToken } from "../src/phase3/id-token.mjs";
import { DEFAULT_PROVIDER, providerById, providerEnv, providerEnvName } from "../src/phase3/oidc-providers.mjs";

const provider = providerById(process.argv[2] ?? DEFAULT_PROVIDER);
const [audience, nonce, token] = ["CLIENT_ID", "EXPECTED_NONCE", "ID_TOKEN"].map((name) => providerEnv(provider, name));
if (!audience || !nonce || !token) {
  throw new Error(
    `Set ${["CLIENT_ID", "EXPECTED_NONCE", "ID_TOKEN"].map((name) => providerEnvName(provider, name)).join(", ")} in the local .env`,
  );
}

const verified = verifyIdToken(token, {
  provider,
  audience,
  nonce,
  jwks: await fetchJwks(provider),
});
const subjectSha256 = createHash("sha256")
  .update(verified.subject, "utf8")
  .digest("hex");
console.log(
  JSON.stringify(
    {
      issuer: verified.issuer,
      audience: verified.audience,
      subjectSha256,
      issuedAt: verified.issuedAt,
      expiresAt: verified.expiresAt,
      keyId: verified.keyId,
      modulusSha256: verified.modulusSha256,
    },
    null,
    2,
  ),
);
