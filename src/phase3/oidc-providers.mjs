// OpenID Connect providers. Each has its own circuit, verification key and
// on-chain deployment, so one provider's signing keys never verify another's
// tokens. Plain data: shared by Node services, scripts and tests.
//
// Adding a provider means an entry here, its circuit profile in
// circuit-profile.mjs and its issuer in src/phase5/recovery.mjs. Everything
// else (token checks, circuit generation and input, login, deployment, the
// demo server and records) takes a provider and reads these fields.

// Where a provider's artifacts, deployment and records live. A new provider
// uses its id throughout; Google keeps the Phase 3–6 paths of its published
// artifacts and recorded evidence.
function files(id, legacy = {}) {
  return {
    circuit: Object.freeze({ directory: `fixtures/${id}`, name: `${id}_jwt`, ...legacy.circuit }),
    // Private local state: captured logins, witnesses and development proofs.
    local: legacy.local ?? `.local/${id}`,
    deployment: legacy.deployment ?? `.local/phase6/deployment-${id}.json`,
    // Published records in benchmarks/ (or DEMO_EVIDENCE_DIR for demo runs).
    records: Object.freeze({
      setup: `${id}-setup.json`,
      deployment: `${id}-deployment.testnet.json`,
      demo: `${id}-demo.testnet.json`,
      acceptance: `${id}-acceptance.testnet.json`,
      policy: `${id}-policy.testnet.json`,
      tokenProfile: `${id}-token-profile.json`,
      // Witness and proof from a genuine token (prepare-witness.mjs, prove-witness.mjs).
      witness: `${id}-witness.json`,
      proof: `${id}-proof.json`,
      syntheticProof: `${id}-proof.synthetic.json`,
      // LocalNet development proof and wallet suite (run-provider-localnet.sh).
      localnetProofs: `${id}-proofs.localnet.json`,
      localnetWallets: `${id}-wallets.localnet.json`,
      ...legacy.records,
    }),
  };
}

export const PROVIDERS = Object.freeze({
  google: Object.freeze({
    id: "google",
    label: "Google",
    // Configuration comes from GOOGLE_CLIENT_ID and so on (providerEnv).
    envPrefix: "GOOGLE",
    issuer: "https://accounts.google.com",
    issuers: Object.freeze(["https://accounts.google.com", "accounts.google.com"]),
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    // Google Identity Services returns the nonce-bound ID token to the page.
    login: Object.freeze({ flow: "in-page" }),
    sessionWithinTokenExpiry: true,
    ...files("google", {
      circuit: { directory: "fixtures/phase3" },
      local: ".local/phase3",
      deployment: ".local/phase6/deployment.json",
      records: {
        setup: "phase3-setup.json",
        deployment: "phase6-deployment.testnet.json",
        demo: "phase6-demo.testnet.json",
        acceptance: "phase6-acceptance.testnet.json",
        policy: "phase6-policy.testnet.json",
        witness: "phase3-witness.google.json",
        proof: "phase3-proof.google.json",
        syntheticProof: "phase3-proof.synthetic.json",
        localnetProofs: "phase4-proofs.localnet.json",
        localnetWallets: "phase4-wallets.localnet.json",
      },
    }),
  }),
  slack: Object.freeze({
    id: "slack",
    label: "Slack",
    envPrefix: "SLACK",
    issuer: "https://slack.com",
    issuers: Object.freeze(["https://slack.com"]),
    jwksUrl: "https://slack.com/openid/connect/keys",
    // Slack user IDs are scoped to a workspace, so the identity subject is
    // "team/sub". Team IDs never contain "/", so the split is unambiguous; the
    // Slack circuit constrains the same form.
    subjectScope: Object.freeze({ claim: "https://slack.com/team_id", name: "team", pattern: /^[A-Za-z0-9]+$/, maxLength: 32 }),
    // Authorization code flow in a login window; the local server exchanges the code.
    login: Object.freeze({
      flow: "code",
      authorizeUrl: "https://slack.com/openid/connect/authorize",
      tokenUrl: "https://slack.com/api/openid.connect.token",
      // Slack requires PKCE for localhost ("non-web") redirects once an app opts
      // into PKCE, and authenticates an https redirect with the client secret.
      pkce: "localhost",
      // The OpenID Connect endpoint redirects here with scope mapped to
      // user_scope and openid_connect=1, dropping any PKCE parameters.
      pkceAuthorize: Object.freeze({ url: "https://slack.com/oauth/v2/authorize", scopeParameter: "user_scope", parameters: Object.freeze({ openid_connect: "1" }) }),
      // A PKCE public client may reject the secret; these errors retry once without it.
      secretlessRetryErrors: Object.freeze(["invalid_client", "bad_client_secret", "invalid_auth", "internal_error"]),
    }),
    // Slack ID tokens expire five minutes after issue. The token is consumed
    // once to bind the session key, so the session is bounded by iat + 600
    // rather than by the token's own exp.
    sessionWithinTokenExpiry: false,
    ...files("slack"),
  }),
});

// The provider a demo tab or script uses when none is named.
export const DEFAULT_PROVIDER = "google";

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

// A provider's setting from the environment, e.g. SLACK_CLIENT_ID.
export const providerEnvName = (provider, name) => `${provider.envPrefix}_${name}`;
export const providerEnv = (provider, name, env = process.env) => env[providerEnvName(provider, name)];

// OAuth client IDs (token audiences) of the providers configured in env,
// optionally limited to the named providers.
export function configuredAudiences(env = process.env, only = []) {
  for (const id of only) providerById(id);
  return Object.fromEntries(
    Object.values(PROVIDERS)
      .filter((p) => !only.length || only.includes(p.id))
      .map((p) => [p.id, providerEnv(p, "CLIENT_ID", env)])
      .filter(([, audience]) => audience),
  );
}

// The wallet identity subject: sub, or "scope/sub" for workspace-scoped IDs.
export function identitySubject(provider, claims) {
  const { label, subjectScope: scope } = provider;
  if (typeof claims.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)) {
    throw new Error(`Invalid ${label} subject`);
  }
  if (!scope) return claims.sub;
  const value = claims[scope.claim];
  if (
    typeof value !== "string" ||
    !scope.pattern.test(value) ||
    value.length > scope.maxLength ||
    value.includes("/") ||
    value.length + 1 + claims.sub.length > 255
  ) {
    throw new Error(`Invalid ${label} ${scope.name} or subject`);
  }
  return `${value}/${claims.sub}`;
}
