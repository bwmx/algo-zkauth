// Google wrappers over the provider-generic ID token checks.
import { fetchJwks, verifyIdToken } from "./id-token.mjs";
import { PROVIDERS } from "./oidc-providers.mjs";

export { parseUniqueJson } from "./id-token.mjs";

export const verifyGoogleIdToken = (token, options) =>
  verifyIdToken(token, { ...options, provider: PROVIDERS.google });

export const fetchGoogleJwks = () => fetchJwks(PROVIDERS.google);
