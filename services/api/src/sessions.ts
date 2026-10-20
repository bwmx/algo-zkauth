// Login sessions, generalised from src/phase6/sessions.mjs (DemoSessions) to
// many apps. A session belongs to one app and one provider and binds the
// browser's session key in the login nonce. Its id is an unguessable capability:
// it is never logged. The token and the salt live here, in memory, until the
// session ends, expires or is deleted.
import { randomBytes } from "node:crypto";
import { fromBase64Url, identityCommitment, sessionNonce, verifyIdToken } from "../../../packages/protocol/src/node.ts";
import type { Identity, Jwks, Provider, ProofResult } from "../../../packages/protocol/src/node.ts";
import { pkcePair } from "../../../src/phase6/code-login.mjs";
import { ApiError, fail } from "./errors.ts";
import type { ErrorCode } from "./errors.ts";

export const SESSION_SECONDS = 600;

export type ProofStage = "queued" | "witness" | "proof" | "verification" | "ready" | "failed";
export type ProofJob = {
  id: string;
  stage: ProofStage;
  startedAt: number;          // ms
  finishedAt?: number;        // ms
  error?: ErrorCode;
  measurement?: { prover: "rapidsnark" | "snarkjs" | "browser"; witnessMs?: number; proveMs?: number; elapsedMs?: number };
};

export type Session = {
  id: string;
  app: string;
  provider: Provider;
  audience: string;
  genesisHash: Buffer;
  sessionPublicKey: Buffer;
  randomness: Buffer;
  expiresAt: number;          // unix seconds
  nonce: string;
  loggedIn: boolean;
  loginUsed: boolean;
  loginError?: ErrorCode;
  // Code flow: the callback's state, the PKCE verifier and the redirect the code is bound to.
  state?: string;
  codeVerifier?: string;
  codeChallenge?: string;
  redirect?: string;
  identity?: Identity;
  token?: string;
  jwks?: Jwks;
  verifiedAt?: number;
  salt?: Buffer;
  owner?: Buffer;
  job?: ProofJob;
  proof?: ProofResult;
  /** Actions the sponsor has paid for, and those submitted but not yet confirmed. */
  actions: number;
  pendingActions: number;
};

export type StartOptions = {
  app: string;
  provider: Provider;
  audience: string;
  genesisHash: Uint8Array;
  sessionPublicKey: unknown;
  randomness: unknown;
  /** Code flow: the redirect the provider returns to. */
  redirect?: string;
  /** Code flow: send a PKCE challenge. */
  pkce?: boolean;
};

const bytes32 = (value: unknown): Buffer => {
  try { return Buffer.from(fromBase64Url(value as string, 32)); } catch { return fail("bad_request", "Expected 32 bytes in base64url"); }
};

export class Sessions {
  readonly entries = new Map<string, Session>();
  readonly now: () => number;
  private readonly maxSessions: number;
  private readonly maxPerApp: number;

  constructor(o: { now?: () => number; maxSessions?: number; maxPerApp?: number } = {}) {
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.maxSessions = o.maxSessions ?? 10_000;
    this.maxPerApp = o.maxPerApp ?? 5_000;
  }

  private erase(s: Session) {
    s.salt?.fill(0); s.salt = undefined; s.token = undefined; s.owner = undefined; s.proof = undefined;
    s.state = undefined; s.codeVerifier = undefined;
  }

  clean() {
    const now = this.now();
    for (const [id, s] of this.entries) if (s.expiresAt <= now) { this.erase(s); this.entries.delete(id); }
  }

  start(o: StartOptions): Session {
    const sessionPublicKey = bytes32(o.sessionPublicKey);
    const randomness = bytes32(o.randomness);
    this.clean();
    if (this.entries.size >= this.maxSessions) fail("rate_limited", "Too many active sessions; retry later", 60);
    let forApp = 0;
    for (const s of this.entries.values()) if (s.app === o.app) forApp++;
    if (forApp >= this.maxPerApp) fail("rate_limited", "Too many active sessions for this app; retry later", 60);
    const genesisHash = Buffer.from(o.genesisHash);
    const expiresAt = this.now() + SESSION_SECONDS;
    const s: Session = {
      id: randomBytes(32).toString("base64url"), app: o.app, provider: o.provider, audience: o.audience,
      genesisHash, sessionPublicKey, randomness, expiresAt,
      nonce: sessionNonce({ genesisHash, sessionPublicKey, expiresAt, randomness }),
      loggedIn: false, loginUsed: false, actions: 0, pendingActions: 0,
    };
    // The callback's state ties the redirect to this session; the PKCE verifier never leaves the service.
    if (o.redirect) {
      s.state = randomBytes(32).toString("base64url");
      s.redirect = o.redirect;
      if (o.pkce) ({ verifier: s.codeVerifier, challenge: s.codeChallenge } = pkcePair());
    }
    this.entries.set(s.id, s);
    return s;
  }

  /** The session, if it exists and has not expired; `app` restricts it to one app. */
  get(id: unknown, o: { requireLogin?: boolean } = {}): Session {
    this.clean();
    const s = typeof id === "string" ? this.entries.get(id) : undefined;
    if (!s) return fail("session_expired");
    if (o.requireLogin && !s.loggedIn) fail("not_signed_in");
    return s;
  }

  byState(state: unknown): Session {
    this.clean();
    if (typeof state !== "string" || !state) return fail("session_expired");
    for (const s of this.entries.values()) if (s.state === state) return s;
    return fail("session_expired");
  }

  /** Checks an ID token against the session's nonce and time window. A session's login is used once, pass or fail. */
  login(id: string, token: unknown, jwks: Jwks): Session {
    const s = this.get(id);
    if (s.loggedIn || s.loginUsed) fail("login_consumed");
    s.loginUsed = true;
    s.state = undefined;
    const now = this.now();
    let verified;
    try {
      verified = verifyIdToken(token as string, { provider: s.provider, audience: s.audience, nonce: s.nonce, jwks, nowSeconds: now });
    } catch { return this.loginFailed(s, "token_invalid"); }
    // The circuit's window: the session ends within 600 s of issue (and, for some providers, before the token expires).
    if ((s.provider.sessionWithinTokenExpiry && s.expiresAt > verified.expiresAt) || s.expiresAt > verified.issuedAt + SESSION_SECONDS || s.expiresAt <= verified.issuedAt)
      return this.loginFailed(s, "token_invalid", "The ID token was issued outside this session's window; start a new session");
    s.identity = { issuer: s.provider.issuer, audience: s.audience, subject: verified.subject };
    s.token = token as string;
    s.jwks = jwks;
    s.verifiedAt = now;
    s.loggedIn = true;
    s.loginError = undefined;
    return s;
  }

  private loginFailed(s: Session, code: ErrorCode, message?: string): never {
    s.loginError = code;
    throw new ApiError(code, message);
  }

  /** Binds the wallet salt (once; the same salt again is accepted) and computes the identity commitment. */
  bindSalt(id: string, encoded: unknown): Session {
    const s = this.get(id, { requireLogin: true });
    const salt = bytes32(encoded);
    if (s.salt && !s.salt.equals(salt)) { salt.fill(0); fail("salt_conflict"); }
    if (!s.salt) { s.salt = salt; s.owner = identityCommitment({ ...s.identity!, salt }).digest; }
    return s;
  }

  delete(id: unknown) {
    const s = typeof id === "string" ? this.entries.get(id) : undefined;
    if (s) { this.erase(s); this.entries.delete(s.id); }
  }

  close() {
    for (const s of this.entries.values()) this.erase(s);
    this.entries.clear();
  }
}

/** The public view of a session (openapi Session). */
/** `networkTime` is now on the clock `expiresAt` uses (the chain's), so clients can measure their skew. */
export function sessionView(s: Session, networkTime: number) {
  return {
    sessionId: s.id, app: s.app, provider: s.provider.id, expiresAt: s.expiresAt, networkTime, loggedIn: s.loggedIn,
    ...(s.identity ? { identity: s.identity } : {}),
    ...(s.loginError ? { loginError: s.loginError } : {}),
    hasSalt: !!s.salt, proofReady: !!s.proof,
  };
}
