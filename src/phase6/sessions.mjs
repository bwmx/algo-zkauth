import { randomUUID } from "node:crypto";
import { sessionNonce } from "../phase3/session-nonce.mjs";
import { verifyGoogleIdToken } from "../phase3/google-id-token.mjs";
import { identityCommitment } from "../phase3/identity-commitment.mjs";
import { fromBase64Url } from "../phase5/recovery.mjs";
export class DemoSessions {
  constructor({ genesisHash, audience, now = () => Math.floor(Date.now() / 1000) }) {
    this.genesisHash = Buffer.from(genesisHash); this.audience = audience; this.now = now; this.entries = new Map();
  }
  clean() {
    for (const [id, s] of this.entries) if (s.expiresAt <= this.now()) { s.salt?.fill(0); s.token = undefined; this.entries.delete(id); }
  }
  start({ sessionPublicKey, randomness }) {
    this.clean(); if (this.entries.size >= 20) throw new Error("Too many active demo sessions");
    const s = { id: randomUUID(), genesisHash: this.genesisHash, sessionPublicKey: Buffer.from(fromBase64Url(sessionPublicKey, 32)), randomness: Buffer.from(fromBase64Url(randomness, 32)), expiresAt: this.now() + 600, loggedIn: false };
    s.nonce = sessionNonce(s); this.entries.set(s.id, s);
    return { sessionId: s.id, nonce: s.nonce, expiresAt: s.expiresAt };
  }
  get(id, requireLogin = true) {
    this.clean(); const s = this.entries.get(id);
    if (!s) throw new Error("Session expired; renew Google login");
    if (requireLogin && !s.loggedIn) throw new Error("Sign in to Google first"); return s;
  }
  login(id, token, jwks) {
    const s = this.get(id, false);
    if (s.loginUsed) throw new Error("Login challenge already consumed; renew Google login");
    s.loginUsed = true;
    const verified = verifyGoogleIdToken(token, { audience: this.audience, nonce: s.nonce, jwks, nowSeconds: this.now() });
    if (s.expiresAt > verified.expiresAt || s.expiresAt > verified.issuedAt + 600 || s.expiresAt <= verified.issuedAt) throw new Error("Session is outside the Google token window; renew login");
    s.identity = { issuer: "https://accounts.google.com", audience: this.audience, subject: verified.subject }; s.token = token; s.loggedIn = true;
    return s;
  }
  salt(id, encodedSalt) {
    const s = this.get(id); const salt = Buffer.from(fromBase64Url(encodedSalt, 32));
    if (s.salt && !s.salt.equals(salt)) throw new Error("Session already bound to another salt; reload to change identity");
    s.salt = salt; s.owner = identityCommitment({ ...s.identity, salt }).digest; return s;
  }
  close() { for (const s of this.entries.values()) { s.salt?.fill(0); s.token = undefined; } this.entries.clear(); }
}
