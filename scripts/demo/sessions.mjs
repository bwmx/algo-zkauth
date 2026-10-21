import { randomBytes, randomUUID } from "node:crypto";
import { sessionNonce } from "../../packages/protocol/src/session-nonce.mjs";
import { verifyIdToken } from "../../packages/protocol/src/id-token.mjs";
import { identityCommitment } from "../../packages/protocol/src/identity-commitment.mjs";
import { DEFAULT_PROVIDER, providerById } from "../../packages/protocol/src/oidc-providers.mjs";
import { fromBase64Url } from "../../packages/protocol/src/recovery.mjs";
import { pkcePair } from "../../packages/protocol/src/code-login.mjs";
export class DemoSessions {
  constructor({ genesisHash, audience, audiences = { [DEFAULT_PROVIDER]: audience }, now = () => Math.floor(Date.now() / 1000) }) {
    this.genesisHash = Buffer.from(genesisHash); this.audiences = audiences; this.now = now; this.entries = new Map();
  }
  clean() {
    for (const [id, s] of this.entries) if (s.expiresAt <= this.now()) { s.salt?.fill(0); s.token = undefined; this.entries.delete(id); }
  }
  start({ provider: requested = DEFAULT_PROVIDER, sessionPublicKey, randomness }) {
    const provider = providerById(requested); const providerId = provider.id;
    if (!this.audiences[providerId]) throw new Error("Login provider is not configured");
    this.clean(); if (this.entries.size >= 20) throw new Error("Too many active demo sessions");
    const s = { id: randomUUID(), provider: providerId, genesisHash: this.genesisHash, sessionPublicKey: Buffer.from(fromBase64Url(sessionPublicKey, 32)), randomness: Buffer.from(fromBase64Url(randomness, 32)), expiresAt: this.now() + 600, loggedIn: false };
    s.nonce = sessionNonce(s);
    // Redirect-based logins return through the browser; state ties the callback
    // to this session and the PKCE verifier stays on this server.
    if (provider.login.flow === "code") { s.state = randomBytes(32).toString("base64url"); ({ verifier: s.codeVerifier, challenge: s.codeChallenge } = pkcePair()); }
    this.entries.set(s.id, s);
    return { sessionId: s.id, provider: providerId, nonce: s.nonce, expiresAt: s.expiresAt };
  }
  get(id, requireLogin = true) {
    this.clean(); const s = this.entries.get(id);
    if (!s) throw new Error("Session expired; renew login");
    if (requireLogin && !s.loggedIn) throw new Error(`Sign in to ${providerById(s.provider).label} first`); return s;
  }
  byState(state) {
    this.clean();
    const s = typeof state === "string" ? [...this.entries.values()].find(v => v.state === state) : undefined;
    if (!s) throw new Error("Session expired or login state unknown; renew login");
    return s;
  }
  login(id, token, jwks) {
    const s = this.get(id, false); const provider = providerById(s.provider);
    if (s.loginUsed) throw new Error(`Login challenge already consumed; renew ${provider.label} login`);
    s.loginUsed = true;
    const audience = this.audiences[s.provider]; const now = this.now();
    const verified = verifyIdToken(token, { provider, audience, nonce: s.nonce, jwks, nowSeconds: now });
    if ((provider.sessionWithinTokenExpiry && s.expiresAt > verified.expiresAt) || s.expiresAt > verified.issuedAt + 600 || s.expiresAt <= verified.issuedAt) throw new Error(`Session is outside the ${provider.label} token window; renew login`);
    s.identity = { issuer: provider.issuer, audience, subject: verified.subject }; s.token = token; s.verifiedAt = now; s.loggedIn = true;
    return s;
  }
  salt(id, encodedSalt) {
    const s = this.get(id); const salt = Buffer.from(fromBase64Url(encodedSalt, 32));
    if (s.salt && !s.salt.equals(salt)) throw new Error("Session already bound to another salt; reload to change identity");
    s.salt = salt; s.owner = identityCommitment({ ...s.identity, salt }).digest; return s;
  }
  close() { for (const s of this.entries.values()) { s.salt?.fill(0); s.token = undefined; } this.entries.clear(); }
}
