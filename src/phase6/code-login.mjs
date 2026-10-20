// Authorization code login for providers whose login.flow is "code". The
// browser's session nonce goes in the authorize request and this server
// exchanges the code for the nonce-bound ID token, so the token never reaches
// the browser. Provider differences (endpoints, when PKCE is used, Slack's
// PKCE authorize form and error codes) are data in oidc-providers.mjs.
//
// Slack: with an https redirect the exchange authenticates with the client
// secret, as Slack documents. Slack requires PKCE for localhost ("non-web")
// redirects once an app opts into PKCE; that form is kept, but on 2026-10-12
// Slack answered internal_error to every exchange of such a code.
import { createHash, randomBytes } from "node:crypto";
import { parseUniqueJson } from "../phase3/id-token.mjs";
import { providerEnvName } from "../phase3/oidc-providers.mjs";

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

const codeLogin = (provider) => {
  if (provider?.login?.flow !== "code") throw new Error("Login provider does not use the authorization code flow");
  return provider.login;
};

// The local callback for a provider's login window.
export const localCallback = (origin, provider) => `${origin}/demo/${provider.id}/callback`;

// A provider that redirects to localhost only with PKCE (Slack's PKCE-enabled
// apps) can use an https relay instead, named by <PREFIX>_REDIRECT_URI, that
// returns code and state to the local callback (web/oauth-relay). The default
// is the callback.
export function redirectUri(provider, callback, configured = undefined) {
  if (configured === undefined || configured === "") return callback;
  const name = providerEnvName(provider, "REDIRECT_URI");
  let url;
  try { url = new URL(configured); } catch { throw new Error(`${name} must be an https URL`); }
  if (url.protocol !== "https:" || url.search || url.hash) throw new Error(`${name} must be an https URL without query or fragment`);
  return url.toString();
}

// "always": the provider requires PKCE. "localhost": PKCE for a localhost
// redirect, the client secret for an https one.
export function usesPkce(provider, redirect) {
  const { pkce } = codeLogin(provider);
  return pkce === "always" || (pkce === "localhost" && new URL(redirect).protocol !== "https:");
}

export const pkceChallenge = (verifier) => createHash("sha256").update(verifier, "ascii").digest("base64url");

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function authorizeUrl(provider, { clientId, redirectUri: redirect, nonce, state, codeChallenge = undefined }) {
  const login = codeLogin(provider);
  // Only "openid": profile claims would exceed the circuit's claim profile.
  if (!codeChallenge) {
    const url = new URL(login.authorizeUrl);
    url.search = new URLSearchParams({ response_type: "code", scope: "openid", client_id: clientId, redirect_uri: redirect, state, nonce }).toString();
    return url.toString();
  }
  // With PKCE, a provider may need another endpoint and parameter spelling.
  const form = login.pkceAuthorize ?? { url: login.authorizeUrl, scopeParameter: "scope", parameters: {} };
  const url = new URL(form.url);
  url.search = new URLSearchParams({ client_id: clientId, [form.scopeParameter]: "openid", ...form.parameters, redirect_uri: redirect, response_type: "code", nonce, state, code_challenge: codeChallenge, code_challenge_method: "S256" }).toString();
  return url.toString();
}

export async function exchangeCode(provider, { clientId, clientSecret, code, codeVerifier = undefined, redirectUri: redirect, fetch = globalThis.fetch, onAttempt = undefined }) {
  const login = codeLogin(provider);
  const { label } = provider;
  if (typeof code !== "string" || !/^[\x21-\x7e]{1,512}$/.test(code)) throw new Error(`Invalid ${label} authorization code`);
  if (codeVerifier !== undefined && (typeof codeVerifier !== "string" || !VERIFIER.test(codeVerifier))) throw new Error(`Invalid ${label} PKCE code verifier`);
  if (codeVerifier === undefined && !clientSecret) throw new Error(`${label} sign-in needs ${providerEnvName(provider, "CLIENT_SECRET")} for an https redirect`);
  const request = async (withSecret) => {
    const response = await fetch(login.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, ...(codeVerifier ? { code_verifier: codeVerifier } : {}), ...(withSecret ? { client_secret: clientSecret } : {}) }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${label} token request failed: HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 100_000) throw new Error(`${label} token response is too large`);
    return parseUniqueJson(text);
  };
  // Slack reports failures as HTTP 200 with ok: false and a short error code.
  const succeeded = (value) => typeof value?.id_token === "string" && value.ok !== false;
  const retryErrors = login.secretlessRetryErrors ?? [];
  // Without PKCE the secret authenticates the exchange. With PKCE, send the
  // secret too when configured; a PKCE public client may reject it, so fall
  // back once to the secretless form on the provider's listed errors.
  let value;
  for (const withSecret of !codeVerifier ? [true] : clientSecret ? [true, false] : [false]) {
    value = await request(withSecret);
    onAttempt?.({ withSecret, ok: succeeded(value), error: typeof value?.error === "string" ? value.error.slice(0, 64) : null });
    if (succeeded(value) || !retryErrors.includes(value?.error)) break;
  }
  if (!succeeded(value)) {
    const reason = typeof value?.error === "string" && /^[a-z_]{1,64}$/.test(value.error) ? ` (${value.error})` : "";
    throw new Error(`${label} token exchange was rejected${reason}`);
  }
  return value.id_token;
}
