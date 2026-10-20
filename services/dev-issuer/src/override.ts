// Points a provider's endpoints at the dev issuer. Services call this when
// ZKAUTH_DEV_ISSUER_URL is set on LocalNet; everything else about the provider
// (issuer, claim profile, subject scope, circuit) stays as it was, so the same
// circuit and key registry apply.
import type { Provider } from "../../../packages/protocol/src/types.ts";

// `publicUrl` is where the browser reaches the sign-in page when services reach
// the issuer at another address (compose: http://localhost:8790 vs http://dev-issuer:8790).
export function withDevIssuer(provider: Provider, baseUrl: string, publicUrl: string = baseUrl): Provider {
  const origin = trimmed(baseUrl);
  const browser = trimmed(publicUrl);
  return Object.freeze({
    ...provider,
    jwksUrl: `${origin}/jwks`,
    // pkce "never": the dev issuer authenticates no client, so the code is bound
    // to client_id and redirect_uri (and to a PKCE challenge if one was sent).
    login: Object.freeze({ flow: "code" as const, authorizeUrl: `${browser}/authorize`, tokenUrl: `${origin}/token`, pkce: "never" as const }),
  });
}

function trimmed(url: string) {
  const base = new URL(url);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("Dev issuer URL must be http or https");
  return base.origin + base.pathname.replace(/\/+$/, "");
}
