// An in-memory implementation of services/api/openapi.yaml's semantics, injected through the SDK's `fetch` option.
// It does real work where the SDK relies on it: nonce binding, identity commitments, action digests and
// Ed25519 signature checks. Chain effects are simulated.
import {
  actionDigest, browserSessionNonce, fromBase64Url, recoveryCommitment, toBase64Url,
} from "@bwmx/algo-zkauth-protocol";
import type { ActionPlan } from "@bwmx/algo-zkauth-protocol";
import { decodeAddress, encodeAddress, getApplicationAddress } from "algosdk";

const ISSUER = "https://accounts.google.com";
const enc = new TextEncoder();
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
const limbs = (bytes: Uint8Array) => [bytes.subarray(0, 16), bytes.subarray(16)].map((p) => BigInt(`0x${Array.from(p, (b) => b.toString(16).padStart(2, "0")).join("")}`).toString());
const MIN_BALANCE = 100_000n;
/** The fake service's proofs are not real; the SDK passes them on (sign-ins) without checking them. */
export const FAKE_PROOF = { pi_a: ["1", "2", "1"], pi_b: [["1", "2"], ["3", "4"], ["1", "0"]], pi_c: ["5", "6", "1"], protocol: "groth16", curve: "bn128" } as const;

export type FakeWallet = { id: bigint; address: string; nonce: bigint; balance: bigint; min: bigint; assets: Map<bigint, bigint> };
type FakeSession = {
  id: string; publicKey: string; randomness: string; nonce: string; expiresAt: number; loggedIn: boolean; identity?: { issuer: string; audience: string; subject: string };
  salt?: string; commitment?: string; proofReady: boolean; polls: number; loginError?: string;
};
type Injected = { match: RegExp; status: number; code: string; message?: string; retryAfter?: number; times: number };

export type FakeOptions = { loginFlow?: "in-page" | "code"; deposit?: bigint; proofPolls?: number; network?: "localnet" | "testnet" };

export const token = (nonce: string, subject = "alice", audience = "client-1.apps.example") =>
  toBase64Url(enc.encode(JSON.stringify({ iss: ISSUER, aud: audience, sub: subject, nonce })));

export class FakeApi {
  readonly sponsor = encodeAddress(new Uint8Array(32).fill(7));
  readonly genesisHash = toBase64Url(new Uint8Array(32).fill(3));
  readonly clientId = "client-1.apps.example";
  readonly deposit: bigint;
  readonly sessions = new Map<string, FakeSession>();
  readonly wallets = new Map<string, FakeWallet>();   // by commitment (base64url)
  readonly plans = new Map<string, { plan: ActionPlan & { expiresAt: number }; sessionId: string; used: boolean }>();
  readonly submitted: { planId: string; operation: string; amount: string }[] = [];
  readonly requests: { method: string; path: string; body?: any }[] = [];
  /** Rewrites the plan the service returns (to simulate a malicious or buggy service). */
  tamper?: (plan: ActionPlan & { expiresAt: number }) => ActionPlan & { expiresAt: number };
  /** What the fake indexer returns for any account. */
  indexerTxns: unknown[] = [];
  private injected: Injected[] = [];
  private nextWallet = 5000n;
  private counter = 0;
  private options: Required<FakeOptions>;

  constructor(options: FakeOptions = {}) {
    this.options = { loginFlow: "in-page", deposit: 200_000n, proofPolls: 1, network: "testnet", ...options };
    this.deposit = this.options.deposit;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, path: url.pathname, body });
    if (url.hostname === "idx.example") return this.json(200, { transactions: this.indexerTxns });
    const hit = this.injected.find((i) => i.match.test(`${method} ${url.pathname}`));
    if (hit) {
      if (--hit.times <= 0) this.injected.splice(this.injected.indexOf(hit), 1);
      return this.error(hit.status, hit.code, hit.message ?? "injected", hit.retryAfter);
    }
    try {
      return await this.route(method, url.pathname, body);
    } catch (e) {
      if (e instanceof Failure) return this.error(e.status, e.code, e.message, e.retryAfter);
      throw e;
    }
  };

  // ---- test controls --------------------------------------------------------------------------

  /** The next `times` requests matching "METHOD /path" fail with this error. */
  fail(match: RegExp, code: string, o: { status?: number; message?: string; retryAfter?: number; times?: number } = {}) {
    this.injected.push({ match, status: o.status ?? 400, code, ...(o.message ? { message: o.message } : {}), ...(o.retryAfter === undefined ? {} : { retryAfter: o.retryAfter }), times: o.times ?? 1 });
  }
  /** Finishes a code-flow login as the provider's redirect would. */
  async completeCodeLogin(sessionId: string, subject = "alice") {
    const s = this.sessions.get(sessionId)!;
    s.loggedIn = true;
    s.identity = { issuer: ISSUER, audience: this.clientId, subject };
  }
  fund(address: string, micro: bigint) {
    const w = [...this.wallets.values()].find((x) => x.address === address)!;
    w.balance += micro;
  }
  giveAsset(address: string, assetId: bigint, amount: bigint) {
    const w = [...this.wallets.values()].find((x) => x.address === address)!;
    w.assets.set(assetId, (w.assets.get(assetId) ?? 0n) + amount);
  }
  walletFor(address: string) { return [...this.wallets.values()].find((x) => x.address === address)!; }
  get lastSessionId() { return [...this.sessions.keys()].at(-1)!; }

  // ---- implementation -------------------------------------------------------------------------

  private json(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  }
  private error(status: number, code: string, message: string, retryAfter?: number) {
    return this.json(status, { error: { code, message, ...(retryAfter === undefined ? {} : { retryAfter }) } });
  }
  private session(id: string): FakeSession {
    const s = this.sessions.get(id);
    if (!s) throw new Failure(404, "not_found", "unknown session");
    return s;
  }
  private live(id: string): FakeSession {
    const s = this.session(id);
    if (s.expiresAt <= Math.floor(Date.now() / 1000)) throw new Failure(401, "session_expired", "session expired");
    return s;
  }
  private config() {
    return {
      app: "demo", provider: "google", providers: ["google"], loginFlow: this.options.loginFlow, clientId: this.clientId, network: this.options.network,
      genesisHash: this.genesisHash, audienceHash: "", registryId: "1001", keyRegistryId: "1002", verifier: "VERIFIER",
      enrollmentDeposit: this.deposit.toString(), groupFeeMicroAlgos: "4000", sponsor: this.sponsor,
      indexerUrl: "https://idx.example",
    };
  }
  private async audienceHash() { return toBase64Url(await sha256(enc.encode(this.clientId))); }
  private wire(w: FakeWallet | undefined) {
    if (!w) return { walletId: "0", address: null, nonce: "0", balanceMicroAlgos: "0", minBalanceMicroAlgos: "0", assets: [], enrolled: false };
    return {
      walletId: w.id.toString(), address: w.address, nonce: w.nonce.toString(), balanceMicroAlgos: w.balance.toString(), minBalanceMicroAlgos: w.min.toString(),
      assets: [...w.assets].map(([id, amount]) => ({ id: id.toString(), amount: amount.toString() })), enrolled: true,
    };
  }
  private view(s: FakeSession) {
    return { sessionId: s.id, app: "demo", provider: "google", expiresAt: s.expiresAt, loggedIn: s.loggedIn, ...(s.identity ? { identity: s.identity } : {}), ...(s.loginError ? { loginError: s.loginError } : {}), hasSalt: !!s.salt, proofReady: s.proofReady };
  }

  private async route(method: string, path: string, body: any): Promise<Response> {
    let m: RegExpExecArray | null;
    if (method === "GET" && path === "/v1/apps/demo/config") return this.json(200, { ...this.config(), audienceHash: await this.audienceHash() });
    if (method === "POST" && path === "/v1/sessions") return this.createSession(body);
    if ((m = /^\/v1\/sessions\/([^/]+)$/.exec(path))) {
      const s = this.session(m[1]!);
      if (method === "GET") return this.json(200, this.view(s));
      if (method === "DELETE") { this.sessions.delete(s.id); return this.json(204, null); }
    }
    if (method === "POST" && (m = /^\/v1\/sessions\/([^/]+)\/token$/.exec(path))) return this.login(this.live(m[1]!), body);
    if (method === "POST" && (m = /^\/v1\/sessions\/([^/]+)\/salt$/.exec(path))) return this.bindSalt(this.live(m[1]!), body);
    if (method === "POST" && (m = /^\/v1\/sessions\/([^/]+)\/proofs$/.exec(path))) {
      const s = this.live(m[1]!);
      if (!s.salt) throw new Failure(409, "salt_required", "bind a salt first");
      s.polls = 0;
      return this.json(202, { jobId: "job-1" });
    }
    if (method === "GET" && (m = /^\/v1\/sessions\/([^/]+)\/proofs\/([^/]+)$/.exec(path))) {
      const s = this.live(m[1]!);
      if (++s.polls <= this.options.proofPolls) return this.json(200, { stage: "witness", elapsedMs: s.polls * 1000 });
      s.proofReady = true;
      return this.json(200, { stage: "ready", elapsedMs: 9000, publicSignals: await this.signals(s), proof: FAKE_PROOF, measurement: { prover: "rapidsnark" } });
    }
    if (method === "POST" && (m = /^\/v1\/sessions\/([^/]+)\/circuit-input$/.exec(path))) {
      const s = this.live(m[1]!);
      if (!s.salt) throw new Failure(409, "salt_required", "bind a salt first");
      return this.json(200, { fake: "circuit input" });
    }
    if (method === "PUT" && (m = /^\/v1\/sessions\/([^/]+)\/proof$/.exec(path))) {
      const s = this.live(m[1]!);
      const expected = await this.signals(s);
      if (JSON.stringify(body?.publicSignals) !== JSON.stringify(expected)) throw new Failure(400, "proof_failed", "public signals mismatch");
      s.proofReady = true;
      return this.json(200, { stage: "ready", elapsedMs: 1, publicSignals: expected });
    }
    if (method === "POST" && path === "/v1/actions") return this.prepare(body);
    if (method === "POST" && (m = /^\/v1\/actions\/([^/]+)\/submit$/.exec(path))) return this.submit(m[1]!, body);
    if (method === "GET" && (m = /^\/v1\/apps\/demo\/wallets\/([A-Z2-7]+)$/.exec(path))) return this.json(200, this.wire(this.wallets.get([...this.wallets].find(([, w]) => w.address === m![1])?.[0] ?? "")));
    throw new Failure(404, "not_found", `no route ${method} ${path}`);
  }

  private async createSession(body: any): Promise<Response> {
    if (body.app !== "demo") throw new Failure(404, "app_unknown", "unknown app");
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const id = `sess-${++this.counter}-${toBase64Url(crypto.getRandomValues(new Uint8Array(6)))}`;
    const nonce = await browserSessionNonce({
      genesisHash: fromBase64Url(this.genesisHash, 32), sessionPublicKey: fromBase64Url(body.sessionPublicKey, 32), expiresAt, randomness: fromBase64Url(body.randomness, 32),
    });
    this.sessions.set(id, { id, publicKey: body.sessionPublicKey, randomness: body.randomness, nonce, expiresAt, loggedIn: false, proofReady: false, polls: 0 });
    return this.json(201, {
      sessionId: id, nonce, expiresAt, loginFlow: this.options.loginFlow,
      ...(this.options.loginFlow === "code" ? { authorizeUrl: `https://provider.example/authorize?state=${id}` } : {}),
    });
  }

  private login(s: FakeSession, body: any): Response {
    let claims: { iss: string; aud: string; sub: string; nonce: string };
    try { claims = JSON.parse(new TextDecoder().decode(fromBase64Url(body.idToken, 1, 4096))); } catch { throw new Failure(400, "token_invalid", "malformed token"); }
    if (claims.nonce !== s.nonce || claims.aud !== this.clientId) throw new Failure(400, "token_invalid", "token does not match the session");
    if (s.loggedIn) throw new Failure(409, "login_consumed", "already used");
    s.loggedIn = true;
    s.identity = { issuer: claims.iss, audience: claims.aud, subject: claims.sub };
    return this.json(200, this.view(s));
  }

  private async bindSalt(s: FakeSession, body: any): Promise<Response> {
    if (!s.loggedIn || !s.identity) throw new Failure(401, "not_signed_in", "sign in first");
    const salt = fromBase64Url(body.salt, 32);
    if (s.salt && s.salt !== body.salt) throw new Failure(409, "salt_conflict", "a different salt is bound");
    s.salt = body.salt;
    s.commitment = toBase64Url(await recoveryCommitment(s.identity, salt));
    return this.json(200, { commitment: s.commitment, wallet: this.wire(this.wallets.get(s.commitment)) });
  }

  async expectedSignals(sessionId: string) { return this.signals(this.sessions.get(sessionId)!); }
  async signals(s: FakeSession): Promise<string[]> {
    const part = (b64: string) => limbs(fromBase64Url(b64, 32));
    return [
      ...part(s.commitment!), ...part(toBase64Url(new Uint8Array(32).fill(9))), ...part(await this.audienceHash()),
      ...part(s.publicKey), ...part(this.genesisHash), String(s.expiresAt), String(s.expiresAt - 600),
    ];
  }

  private async prepare(body: any): Promise<Response> {
    const s = this.live(body.sessionId);
    if (!s.proofReady) throw new Failure(409, "proof_pending", "no proof for this session", 2);
    const operation = body.operation as string;
    const wallet = this.wallets.get(s.commitment!);
    if (operation === "0" && wallet) throw new Failure(409, "wallet_exists", "already enrolled");
    if (operation !== "0" && !wallet) throw new Failure(409, "not_enrolled", "enroll first");
    const recipient = operation === "0" ? this.sponsor : body.recipient;
    let plan: ActionPlan & { expiresAt: number } = {
      planId: `plan-${++this.counter}`, version: 1, genesisHash: this.genesisHash, registryId: "1001",
      walletId: wallet ? wallet.id.toString() : "0", owner: s.commitment!, operation: operation as ActionPlan["operation"], recipient,
      recipientPublicKey: toBase64Url(decodeAddress(recipient).publicKey), assetId: operation === "0" ? "0" : body.assetId,
      amount: operation === "0" ? this.deposit.toString() : body.amount, nonce: wallet ? wallet.nonce.toString() : "0",
      sessionExpiresAt: String(s.expiresAt), expiresAt: Math.floor(Date.now() / 1000) + 120,
    };
    this.plans.set(plan.planId, { plan, sessionId: s.id, used: false });
    if (this.tamper) plan = this.tamper(plan);
    return this.json(201, plan);
  }

  private async submit(planId: string, body: any): Promise<Response> {
    const entry = this.plans.get(planId);
    if (!entry || entry.sessionId !== body.sessionId) throw new Failure(404, "not_found", "unknown plan");
    const s = this.live(entry.sessionId);
    if (entry.used) throw new Failure(409, "replay", "plan already used");
    const { plan } = entry;
    if (plan.expiresAt <= Math.floor(Date.now() / 1000)) throw new Failure(410, "plan_expired", "plan expired");
    const key = await crypto.subtle.importKey("raw", fromBase64Url(s.publicKey, 32) as BufferSource, "Ed25519", false, ["verify"]);
    const ok = await crypto.subtle.verify("Ed25519", key, fromBase64Url(body.signature, 64) as BufferSource, (await actionDigest(plan)) as BufferSource);
    if (!ok) throw new Failure(400, "unauthorized", "bad signature");
    const wallet = this.wallets.get(s.commitment!);
    const amount = BigInt(plan.amount);
    if (plan.operation === "0") {
      const id = this.nextWallet++;
      const created: FakeWallet = { id, address: getApplicationAddress(id).toString(), nonce: 1n, balance: this.deposit, min: MIN_BALANCE, assets: new Map() };
      this.wallets.set(s.commitment!, created);
    } else {
      if (!wallet || wallet.nonce.toString() !== plan.nonce) throw new Failure(409, "replay", "stale nonce");
      if (plan.operation === "1") {
        if (wallet.balance - amount < wallet.min) throw new Failure(402, "insufficient_funds", "insufficient funds");
        wallet.balance -= amount;
      } else if (plan.operation === "2") {
        wallet.assets.set(BigInt(plan.assetId), wallet.assets.get(BigInt(plan.assetId)) ?? 0n);
        wallet.min += MIN_BALANCE;
      } else {
        const held = wallet.assets.get(BigInt(plan.assetId)) ?? 0n;
        if (held < amount) throw new Failure(402, "insufficient_funds", "insufficient asset");
        wallet.assets.set(BigInt(plan.assetId), held - amount);
      }
      wallet.nonce += 1n;
    }
    entry.used = true;
    this.submitted.push({ planId, operation: plan.operation, amount: plan.amount });
    return this.json(200, {
      txId: `TX${this.counter}${planId}`.toUpperCase().replace(/[^A-Z0-9]/g, ""), transactionIds: ["a", "b"], groupId: "GROUP" + this.counter,
      confirmedRound: String(1000 + this.submitted.length), groupFeeMicroAlgos: "4000", wallet: this.wire(this.wallets.get(s.commitment!)),
    });
  }
}

class Failure extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfter?: number) { super(message); }
}
