import { createHash } from "node:crypto";
import {
  fetchGoogleJwks,
  verifyGoogleIdToken,
} from "../src/phase3/google-id-token.mjs";

const {
  GOOGLE_CLIENT_ID: audience,
  GOOGLE_EXPECTED_NONCE: nonce,
  GOOGLE_ID_TOKEN: token,
} = process.env;
if (!audience || !nonce || !token) {
  throw new Error(
    "Set GOOGLE_CLIENT_ID, GOOGLE_EXPECTED_NONCE, and GOOGLE_ID_TOKEN in the local .env",
  );
}

const verified = verifyGoogleIdToken(token, {
  audience,
  nonce,
  jwks: await fetchGoogleJwks(),
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
