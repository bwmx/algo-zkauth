import { MAX_SIGN_IN_SECONDS, recoveryCommitment, signInBytes, toBase64Url, validateSignInFields } from "@bwmx/algo-zkauth-protocol";
import type { Identity, ProofResult, ProviderId, SignIn, SignInFields } from "@bwmx/algo-zkauth-protocol";
import { BackupImpl } from "./backup.ts";
import type { Ctx, LoginOutcome, WalletWire } from "./context.ts";
import { ZkAuthError } from "./errors.ts";
import { openLoginWindow, startLogin } from "./signin.ts";
import type { Session, SignInOptions, SignInRequest, Wallet } from "./types.ts";
import { Emitter, nowSeconds } from "./util.ts";
import { WalletImpl } from "./wallet.ts";

export class SessionImpl implements Session {
  readonly backup: BackupImpl;
  readonly walletImpl: WalletImpl;
  id: string;
  provider: ProviderId;
  readonly identity: Identity;
  expiresAt: number;
  clockSkew: number;
  key: CryptoKeyPair | null;
  publicKey: string;
  salt: Uint8Array | null = null;
  commitment: string | null = null;
  proofReady = false;
  /** The session's proof once ready (not secret: only this session key can use it). */
  proof: ProofResult | null = null;
  closed = false;
  expired = false;
  private readonly events = new Emitter();
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(readonly ctx: Ctx, login: LoginOutcome) {
    this.id = login.sessionId;
    this.provider = login.provider;
    this.identity = login.identity;
    this.expiresAt = login.expiresAt;
    this.clockSkew = login.clockSkew;
    this.key = login.key;
    this.publicKey = login.publicKey;
    this.backup = new BackupImpl(this);
    this.walletImpl = new WalletImpl(this);
    this.arm();
  }

  get secondsLeft() { return Math.max(0, this.expiresAt - (nowSeconds() + this.clockSkew)); }

  /** Throws unless this session can still be used to sign. */
  assertActive() {
    if (this.closed || !this.key) throw new ZkAuthError("not_signed_in", "This session was closed; sign in again");
    if (this.expired || this.secondsLeft <= 0) throw new ZkAuthError("session_expired", "The session expired; call session.renew()");
  }
  assertOpen() {
    if (this.closed) throw new ZkAuthError("not_signed_in", "This session was closed; sign in again");
  }

  async wallet(): Promise<Wallet> {
    this.assertOpen();
    if (!this.salt) throw new ZkAuthError("salt_required", "Create or restore a backup first: session.backup.create() or session.backup.restore()");
    return this.walletImpl;
  }

  /** Binds the wallet salt to the service session (the only way the salt leaves the browser) and discovers the wallet. */
  async bindSalt(salt: Uint8Array, restored: boolean): Promise<WalletWire> {
    this.assertOpen();
    const local = toBase64Url(await recoveryCommitment(this.identity, salt));
    const discovery = await this.ctx.api.post<{ commitment: string; wallet: WalletWire }>(`/v1/sessions/${this.id}/salt`, { salt: toBase64Url(salt), restored });
    if (discovery.commitment !== local) throw new ZkAuthError("commitment_mismatch", "The service computed a different identity commitment than this page");
    this.walletImpl.apply(discovery.wallet);
    this.salt = salt;
    this.commitment = local;
    this.emitChange();
    return discovery.wallet;
  }

  async discover(): Promise<WalletWire> {
    if (!this.salt) throw new ZkAuthError("salt_required", "Create or restore a backup first");
    return this.bindSalt(this.salt, false);
  }

  async renew(options: SignInOptions = {}): Promise<Session> {
    this.assertOpen();
    const popup = openLoginWindow(this.ctx.config, this.provider, options.login ?? this.ctx.options.login);
    const next = await startLogin(this.ctx, this.provider, options, popup);
    if (JSON.stringify(next.identity) !== JSON.stringify(this.identity)) {
      void this.ctx.api.delete(`/v1/sessions/${next.sessionId}`).catch(() => {});
      throw new ZkAuthError("wrong_account", "Renew with the account you signed in with originally");
    }
    const previous = this.id;
    this.id = next.sessionId;
    this.key = next.key;
    this.publicKey = next.publicKey;
    this.expiresAt = next.expiresAt;
    this.clockSkew = next.clockSkew;
    this.expired = false;
    this.proofReady = false;
    this.proof = null;
    this.arm();
    if (this.salt) await this.bindSalt(this.salt, false);
    void this.ctx.api.delete(`/v1/sessions/${previous}`).catch(() => {});
    this.emitChange();
    return this;
  }

  async createSignIn(request: SignInRequest): Promise<SignIn> {
    this.assertActive();
    if (!this.salt) throw new ZkAuthError("salt_required", "Create or restore a backup first: session.backup.create() or session.backup.restore()");
    const origin = request?.origin ?? (typeof location !== "undefined" ? location.origin : undefined);
    if (!origin) throw new ZkAuthError("bad_request", "Pass origin: the site the backend expects");
    await this.walletImpl.ensureProof();
    const wallet = await this.discover();
    this.assertActive();
    // On the network's clock, as the backend checks it.
    const issuedAt = nowSeconds() + this.clockSkew;
    const expiresAt = Math.min(this.expiresAt, issuedAt + Math.min(request.expiresIn ?? 300, MAX_SIGN_IN_SECONDS));
    if (expiresAt - issuedAt < 30) throw new ZkAuthError("session_expired", "The session ends too soon to sign in with; call session.renew()");
    const { config } = this.ctx;
    let fields: SignInFields;
    try {
      fields = validateSignInFields({
        version: 1, origin, address: wallet.enrolled ? wallet.address : null, statement: request.statement ?? null,
        network: config.network, genesisHash: config.genesisHash, app: config.registryId, provider: this.provider,
        nonce: request.nonce, issuedAt, expiresAt,
      });
    } catch (error) {
      throw new ZkAuthError("bad_request", (error as Error).message, { cause: error });
    }
    const signature = toBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", this.key!.privateKey, signInBytes(fields))));
    return { fields, signature, proof: structuredClone(this.proof!) };
  }

  private arm() {
    for (const t of this.timers) clearTimeout(t);
    const remaining = (this.expiresAt - this.clockSkew) * 1000 - Date.now();
    const warn = remaining - this.ctx.expiringSeconds * 1000;
    this.timers = [
      setTimeout(() => { if (!this.closed && !this.expired) this.events.emit("expiring", this.secondsLeft); }, Math.max(0, warn)),
      setTimeout(() => {
        if (this.closed) return;
        this.expired = true;
        this.events.emit("expired");
        this.emitChange();
      }, Math.max(0, remaining)),
    ];
    // Expiry timers must not keep a Node process (tests, scripts) alive; browsers have no unref.
    for (const t of this.timers) (t as { unref?: () => void }).unref?.();
  }

  on(event: "expiring" | "expired" | "change", listener: (...args: any[]) => void): () => void {
    return this.events.on(event, listener);
  }
  emitChange() { this.events.emit("change"); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    const id = this.id;
    this.salt?.fill(0);
    this.salt = null;
    this.key = null;
    this.backup.dispose();
    this.emitChange();
    this.events.clear();
    try { await this.ctx.api.delete(`/v1/sessions/${id}`); } catch { /* the service expires it anyway */ }
  }
}
