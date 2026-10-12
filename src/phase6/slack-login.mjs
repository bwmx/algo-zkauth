// Sign in with Slack uses the authorization code flow. The browser's session
// nonce goes in the authorize request; the client secret stays on this server,
// which exchanges the code for the nonce-bound ID token.
import { parseUniqueJson } from "../phase3/id-token.mjs";
import { PROVIDERS } from "../phase3/oidc-providers.mjs";

const slack = PROVIDERS.slack;

export function slackAuthorizeUrl({ clientId, redirectUri, nonce, state }) {
  const url = new URL(slack.authorizeUrl);
  // Only "openid": profile claims would exceed the circuit's claim profile.
  url.search = new URLSearchParams({ response_type: "code", scope: "openid", client_id: clientId, redirect_uri: redirectUri, state, nonce }).toString();
  return url.toString();
}

export async function exchangeSlackCode({ clientId, clientSecret, code, redirectUri, fetch = globalThis.fetch }) {
  if (typeof code !== "string" || !/^[\x21-\x7e]{1,512}$/.test(code)) throw new Error("Invalid Slack authorization code");
  const response = await fetch(slack.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Slack token request failed: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 100_000) throw new Error("Slack token response is too large");
  const value = parseUniqueJson(text);
  if (value?.ok !== true || typeof value.id_token !== "string") {
    // Slack reports failures as HTTP 200 with a short error code.
    const reason = typeof value?.error === "string" && /^[a-z_]{1,64}$/.test(value.error) ? ` (${value.error})` : "";
    throw new Error(`Slack token exchange was rejected${reason}`);
  }
  return value.id_token;
}
