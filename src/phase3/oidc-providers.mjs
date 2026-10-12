// OpenID Connect providers. Each has its own circuit, verification key and
// on-chain deployment, so one provider's signing keys never verify another's
// tokens. Plain data: shared by Node services, scripts and tests.
export const SLACK_TEAM_CLAIM = "https://slack.com/team_id";

export const PROVIDERS = Object.freeze({
  google: Object.freeze({
    id: "google",
    label: "Google",
    issuer: "https://accounts.google.com",
    issuers: Object.freeze(["https://accounts.google.com", "accounts.google.com"]),
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    sessionWithinTokenExpiry: true,
    circuit: Object.freeze({ directory: "fixtures/phase3", name: "google_jwt" }),
  }),
  slack: Object.freeze({
    id: "slack",
    label: "Slack",
    issuer: "https://slack.com",
    issuers: Object.freeze(["https://slack.com"]),
    jwksUrl: "https://slack.com/openid/connect/keys",
    authorizeUrl: "https://slack.com/openid/connect/authorize",
    tokenUrl: "https://slack.com/api/openid.connect.token",
    // Slack ID tokens expire five minutes after issue. The token is consumed
    // once to bind the session key, so the session is bounded by iat + 600
    // rather than by the token's own exp.
    sessionWithinTokenExpiry: false,
    circuit: Object.freeze({ directory: "fixtures/slack", name: "slack_jwt" }),
  }),
});

export function providerById(id) {
  if (typeof id !== "string" || !Object.hasOwn(PROVIDERS, id)) {
    throw new Error("Unsupported login provider");
  }
  return PROVIDERS[id];
}

export function providerForIssuer(issuer) {
  const provider = Object.values(PROVIDERS).find((p) => p.issuers.includes(issuer));
  if (!provider) throw new Error("Unsupported issuer");
  return provider;
}

// The wallet identity subject. Slack user IDs are scoped to a workspace, so
// Slack identities use "team/sub". Team IDs never contain "/", so the split
// is unambiguous; the Slack circuit constrains the same form.
export function identitySubject(provider, claims) {
  const { label } = provider;
  if (typeof claims.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)) {
    throw new Error(`Invalid ${label} subject`);
  }
  if (provider.id !== "slack") return claims.sub;
  const team = claims[SLACK_TEAM_CLAIM];
  if (
    typeof team !== "string" ||
    !/^[A-Za-z0-9]{1,32}$/.test(team) ||
    team.length + 1 + claims.sub.length > 255
  ) {
    throw new Error("Invalid Slack team or subject");
  }
  return `${team}/${claims.sub}`;
}
