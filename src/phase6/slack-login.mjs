// Sign in with Slack uses the authorization code flow. The browser's session
// nonce goes in the authorize request and this server exchanges the code for
// the nonce-bound ID token. With an https redirect it authenticates with the
// client secret, as Slack documents. Slack requires PKCE for localhost
// ("non-web") redirects once an app opts into PKCE; that form is kept, but on
// 2026-10-12 Slack answered internal_error to every exchange of such a code.
import { createHash, randomBytes } from "node:crypto";
import { parseUniqueJson } from "../phase3/id-token.mjs";
import { PROVIDERS } from "../phase3/oidc-providers.mjs";

const slack = PROVIDERS.slack;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const RETRY = ["invalid_client", "bad_client_secret", "invalid_auth", "internal_error"];

// A PKCE-enabled Slack app redirects to localhost only with PKCE, so
// SLACK_REDIRECT_URI may name an https relay that returns code and state to
// the local callback (web/slack-relay). The default is the callback.
export function slackRedirectUri(localCallback, configured = undefined) {
  if (configured === undefined || configured === "") return localCallback;
  let url;
  try { url = new URL(configured); } catch { throw new Error("SLACK_REDIRECT_URI must be an https URL"); }
  if (url.protocol !== "https:" || url.search || url.hash) throw new Error("SLACK_REDIRECT_URI must be an https URL without query or fragment");
  return url.toString();
}

export const usesPkce = (redirectUri) => new URL(redirectUri).protocol !== "https:";

export const pkceChallenge = (verifier) => createHash("sha256").update(verifier, "ascii").digest("base64url");

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function slackAuthorizeUrl({ clientId, redirectUri, nonce, state, codeChallenge = undefined }) {
  // Only "openid": profile claims would exceed the circuit's claim profile.
  if (!codeChallenge) {
    const url = new URL(slack.authorizeUrl);
    url.search = new URLSearchParams({ response_type: "code", scope: "openid", client_id: clientId, redirect_uri: redirectUri, state, nonce }).toString();
    return url.toString();
  }
  // The parameters the OpenID Connect endpoint forwards, plus PKCE.
  const url = new URL(slack.pkceAuthorizeUrl);
  url.search = new URLSearchParams({ client_id: clientId, user_scope: "openid", openid_connect: "1", redirect_uri: redirectUri, response_type: "code", nonce, state, code_challenge: codeChallenge, code_challenge_method: "S256" }).toString();
  return url.toString();
}

export async function exchangeSlackCode({ clientId, clientSecret, code, codeVerifier = undefined, redirectUri, fetch = globalThis.fetch, onAttempt = undefined }) {
  if (typeof code !== "string" || !/^[\x21-\x7e]{1,512}$/.test(code)) throw new Error("Invalid Slack authorization code");
  if (codeVerifier !== undefined && (typeof codeVerifier !== "string" || !VERIFIER.test(codeVerifier))) throw new Error("Invalid Slack PKCE code verifier");
  if (codeVerifier === undefined && !clientSecret) throw new Error("Slack sign-in needs SLACK_CLIENT_SECRET for an https redirect");
  const request = async (withSecret) => {
    const response = await fetch(slack.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, ...(codeVerifier ? { code_verifier: codeVerifier } : {}), ...(withSecret ? { client_secret: clientSecret } : {}) }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Slack token request failed: HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 100_000) throw new Error("Slack token response is too large");
    return parseUniqueJson(text);
  };
  // Without PKCE the secret authenticates the exchange. With PKCE, send the
  // secret too when configured; a PKCE public client may reject it, so fall
  // back once to the secretless form on client-authentication or internal errors.
  let value;
  for (const withSecret of !codeVerifier ? [true] : clientSecret ? [true, false] : [false]) {
    value = await request(withSecret);
    onAttempt?.({ withSecret, ok: value?.ok === true, error: typeof value?.error === "string" ? value.error.slice(0, 64) : null });
    if (value?.ok === true || !RETRY.includes(value?.error)) break;
  }
  if (value?.ok !== true || typeof value.id_token !== "string") {
    // Slack reports failures as HTTP 200 with a short error code.
    const reason = typeof value?.error === "string" && /^[a-z_]{1,64}$/.test(value.error) ? ` (${value.error})` : "";
    throw new Error(`Slack token exchange was rejected${reason}`);
  }
  return value.id_token;
}
