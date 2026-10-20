// Points a provider's endpoints at the dev issuer. Services call this when
// ZKAUTH_DEV_ISSUER_URL is set on LocalNet; everything else about the provider
// (issuer, claim profile, subject scope, circuit) stays as it was, so the same
// circuit and key registry apply.
import type { Provider } from "../../../packages/protocol/src/types.ts";

export function withDevIssuer(provider: Provider, baseUrl: string): Provider {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("Dev issuer URL must be http or https");
  const origin = base.origin + base.pathname.replace(/\/+$/, "");
  return Object.freeze({
    ...provider,
    jwksUrl: `${origin}/jwks`,
    // pkce "never": the dev issuer authenticates no client, so the code is bound
    // to client_id and redirect_uri (and to a PKCE challenge if one was sent).
    login: Object.freeze({ flow: "code" as const, authorizeUrl: `${origin}/authorize`, tokenUrl: `${origin}/token`, pkce: "never" as const }),
  });
}
