import { actionDigest, toBase64Url, validateActionPlan } from "@algozkauth/protocol";
import type { ActionPlan } from "@algozkauth/protocol";
import { decodeAddress, getApplicationAddress, isValidAddress } from "./address.ts";
import type { WalletWire } from "./context.ts";
import { SERVICE_CODES, ZkAuthError } from "./errors.ts";
import { fetchHistory } from "./indexer.ts";
import { checkProofBindings } from "./proving.ts";
import type { SessionImpl } from "./session.ts";
import type {
  AssetId, Balance, HistoryItem, MicroAlgos, PlanSummary, TxResult, Units, Wallet, WalletStatus, ZkAuthErrorCode,
} from "./types.ts";
import { Emitter, nowSeconds, sleep, toAssetId, toMicroAlgos } from "./util.ts";

type ProofJob = { stage: "queued" | "witness" | "proof" | "verification" | "ready" | "failed"; elapsedMs: number; publicSignals?: string[]; error?: string };
type Submitted = { txId: string; groupId: string; confirmedRound: string; wallet: WalletWire };
type Kind = PlanSummary["kind"];
const OPERATION: Record<Kind, "0" | "1" | "2" | "3"> = { enroll: "0", sendAlgo: "1", optIn: "2", sendAsset: "3" };
const U64_MAX = 0xffffffffffffffffn;

export class WalletImpl implements Wallet {
  status: WalletStatus = "idle";
  progress: string | null = null;
  private state: WalletWire | null = null;
  private readonly events = new Emitter();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly session: SessionImpl) {}

  get enrolled() { return this.state?.enrolled === true; }
  get id() { return this.enrolled ? BigInt(this.state!.walletId) : null; }
  get address() { return this.enrolled ? this.state!.address : null; }

  apply(wire: WalletWire) {
    if (wire.enrolled && (!wire.address || getApplicationAddress(BigInt(wire.walletId)).toString() !== wire.address)) {
      throw new ZkAuthError("wallet_mismatch", "The wallet address does not match its application id");
    }
    this.state = wire;
    this.events.emit("change");
  }

  on(event: "plan" | "change", listener: (...args: any[]) => void) { return this.events.on(event, listener); }

  private set(status: WalletStatus, progress: string | null = null) {
    this.status = status;
    this.progress = progress;
    this.events.emit("change");
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  // ---- reads ----------------------------------------------------------------------------------

  async refresh(): Promise<void> {
    const s = this.session;
    if (this.enrolled && this.state!.address) {
      this.apply(await s.ctx.api.get<WalletWire>(`/v1/apps/${encodeURIComponent(s.ctx.config.app)}/wallets/${this.state!.address}`));
    } else {
      await s.discover();
    }
  }

  private snapshot(): Balance {
    const w = this.state;
    const microAlgos = BigInt(w?.balanceMicroAlgos ?? "0");
    const minBalance = BigInt(w?.minBalanceMicroAlgos ?? "0");
    return {
      microAlgos, minBalance, spendable: microAlgos > minBalance ? microAlgos - minBalance : 0n,
      assets: (w?.assets ?? []).map((a) => ({ id: BigInt(a.id), amount: BigInt(a.amount) })),
    };
  }

  async balance(): Promise<Balance> {
    await this.refresh();
    return this.snapshot();
  }

  async history(o: { limit?: number } = {}): Promise<HistoryItem[]> {
    const { ctx } = this.session;
    const url = ctx.options.indexerUrl ?? ctx.config.indexerUrl;
    if (!url) throw new ZkAuthError("not_supported", "No indexer is configured: pass indexerUrl to createZkAuth");
    if (!this.enrolled || !this.state?.address) return [];
    return fetchHistory(ctx.fetchFn(), url, this.state.address, BigInt(this.state.walletId), Math.min(Math.max(o.limit ?? 25, 1), 100));
  }

  async waitForFunds(o: { microAlgos: bigint; timeoutMs?: number }): Promise<void> {
    if (!this.enrolled) throw new ZkAuthError("not_enrolled", "The wallet has no address to fund yet: call wallet.enroll() first");
    const deadline = Date.now() + (o.timeoutMs ?? 120_000);
    for (;;) {
      await this.refresh();
      if (this.snapshot().microAlgos >= o.microAlgos) return;
      if (Date.now() >= deadline) throw new ZkAuthError("timeout", `The wallet did not receive ${o.microAlgos} µALGO in time`);
      await sleep(this.session.ctx.pollMs);
    }
  }

  // ---- proof ----------------------------------------------------------------------------------

  /** Requests (or computes in the browser) the session's proof once; cached until the session is renewed. */
  private async ensureProof(): Promise<void> {
    const s = this.session;
    if (s.proofReady) return;
    const { api, config, options, prover } = s.ctx;
    this.set("proving", "Preparing the proof…");
    try {
      let signals: string[] | undefined;
      if (options.proving === "browser") {
        if (!prover) throw new ZkAuthError("bad_request", "proving: \"browser\" needs the browserProver option");
        const input = await api.post<Record<string, unknown>>(`/v1/sessions/${s.id}/circuit-input`);
        const result = await prover(input, (message) => this.set("proving", message));
        checkProofBindings(result.publicSignals, this.expectedSignals());
        const job = await api.put<ProofJob>(`/v1/sessions/${s.id}/proof`, result);
        if (job.stage !== "ready") throw this.jobError(job);
        signals = job.publicSignals ?? result.publicSignals;
      } else {
        const { jobId } = await api.post<{ jobId: string }>(`/v1/sessions/${s.id}/proofs`);
        const deadline = Date.now() + s.ctx.proofTimeoutMs;
        for (;;) {
          const job = await api.get<ProofJob>(`/v1/sessions/${s.id}/proofs/${jobId}`);
          if (job.stage === "ready") { signals = job.publicSignals; break; }
          if (job.stage === "failed") throw this.jobError(job);
          if (Date.now() >= deadline) throw new ZkAuthError("timeout", "The proof took too long", { retryAfter: 5 });
          this.set("proving", `Proof ${job.stage} (${Math.round(job.elapsedMs / 1000)} s)`);
          await sleep(s.ctx.pollMs);
        }
      }
      if (!signals) throw new ZkAuthError("proof_failed", "The service returned a proof without public signals");
      checkProofBindings(signals, this.expectedSignals());
      s.proofReady = true;
    } finally {
      this.set("idle");
    }
  }

  private expectedSignals() {
    const s = this.session;
    return {
      commitment: s.commitment!, genesisHash: s.ctx.config.genesisHash, sessionKey: s.publicKey, expiresAt: s.expiresAt,
      ...(s.ctx.config.audienceHash ? { audienceHash: s.ctx.config.audienceHash } : {}),
    };
  }

  private jobError(job: ProofJob): ZkAuthError {
    const code = typeof job.error === "string" && SERVICE_CODES.has(job.error) ? (job.error as ZkAuthErrorCode) : "proof_failed";
    return new ZkAuthError(code, "The proof could not be produced");
  }

  // ---- actions --------------------------------------------------------------------------------

  enroll(): Promise<TxResult | null> {
    return this.serial(() => this.perform("enroll", {}));
  }

  async sendAlgo(o: { to: string; amount: MicroAlgos }): Promise<TxResult> {
    const to = this.address_(o.to);
    const amount = toMicroAlgos(o.amount);
    if (amount <= 0n) throw new ZkAuthError("bad_request", "The amount must be greater than zero");
    return this.withEnrollment(() => this.perform("sendAlgo", { to, amount }));
  }

  async optIn(assetId: AssetId): Promise<TxResult> {
    const asset = toAssetId(assetId);
    return this.withEnrollment(() => this.perform("optIn", { asset }));
  }

  async sendAsset(o: { assetId: AssetId; to: string; amount: Units }): Promise<TxResult> {
    const to = this.address_(o.to);
    const asset = toAssetId(o.assetId);
    if (typeof o.amount !== "bigint" || o.amount <= 0n || o.amount > U64_MAX) throw new ZkAuthError("bad_request", "The amount must be a positive bigint of asset base units");
    return this.withEnrollment(() => this.perform("sendAsset", { to, asset, amount: o.amount }));
  }

  private address_(address: string): string {
    if (typeof address !== "string" || !isValidAddress(address)) throw new ZkAuthError("bad_request", "Enter a valid Algorand address");
    return address;
  }

  /** First action on a fresh wallet enrolls it, in the same serialized step. */
  private withEnrollment(action: () => Promise<TxResult | null>): Promise<TxResult> {
    return this.serial(async () => {
      if (!this.enrolled) await this.perform("enroll", {});
      return (await action())!;
    });
  }

  private async perform(kind: Kind, p: { to?: string; asset?: bigint; amount?: bigint }): Promise<TxResult | null> {
    const s = this.session;
    s.assertActive();
    const { api, config, options } = s.ctx;
    await this.ensureProof();
    try {
      this.set(kind === "enroll" ? "enrolling" : "preparing");
      const wire = await s.discover();
      if (kind === "enroll" && wire.enrolled) return null;
      if (kind !== "enroll" && !wire.enrolled) throw new ZkAuthError("not_enrolled", "The wallet is not enrolled");
      const enroll = kind === "enroll";
      const balance = this.snapshot();
      if (kind === "sendAlgo" && p.amount! > balance.spendable) {
        throw new ZkAuthError("insufficient_funds", `The wallet can spend ${balance.spendable} µALGO above its minimum balance; fund ${wire.address}`);
      }
      if (kind === "sendAsset" && (balance.assets.find((a) => a.id === p.asset)?.amount ?? 0n) < p.amount!) {
        throw new ZkAuthError("insufficient_funds", "The wallet holds less of this asset than requested");
      }

      const operation = OPERATION[kind];
      const recipient = enroll ? config.sponsor : kind === "optIn" ? wire.address! : p.to!;
      const assetId = enroll || kind === "sendAlgo" ? "0" : String(p.asset);
      const amount = enroll ? config.enrollmentDeposit : kind === "optIn" ? "0" : String(p.amount);
      const raw = await api.post<ActionPlan & { expiresAt?: number }>("/v1/actions", { sessionId: s.id, version: 1, operation, recipient, assetId, amount });

      let plan: ActionPlan;
      try {
        plan = validateActionPlan(raw, {
          walletId: enroll ? "0" : wire.walletId, operation, recipient, assetId, amount, nonce: enroll ? "0" : wire.nonce,
          owner: s.commitment!, sessionExpiresAt: String(s.expiresAt),
        }, { genesisHash: config.genesisHash, registryId: config.registryId }, decodeAddress);
        if (plan.version !== 1 || typeof plan.planId !== "string" || !plan.planId) throw new Error("Action plan has an unsupported version");
      } catch (error) {
        throw new ZkAuthError("plan_mismatch", error instanceof Error ? error.message : "The service's plan does not match the request", { cause: error });
      }
      if (typeof raw.expiresAt === "number" && raw.expiresAt <= nowSeconds()) throw new ZkAuthError("plan_expired", "The plan expired before it could be signed");

      const summary: PlanSummary = { kind, recipient, assetId: BigInt(assetId), amount: BigInt(amount), planId: plan.planId };
      this.events.emit("plan", summary);
      if (options.approve && !(await options.approve(summary))) throw new ZkAuthError("user_rejected", "The action was not approved; nothing was signed");

      this.set("signing");
      const digest = await actionDigest(plan);
      const signature = toBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", s.key!.privateKey, digest)));
      this.set("submitting");
      const done = await api.post<Submitted>(`/v1/actions/${encodeURIComponent(plan.planId)}/submit`, { sessionId: s.id, signature });
      this.apply(done.wallet);
      if (enroll) s.emitChange();
      return {
        txId: done.txId, groupId: done.groupId, confirmedRound: BigInt(done.confirmedRound),
        explorerUrl: (options.explorerUrl ?? ((id, network) => `https://lora.algokit.io/${network}/transaction/${id}`))(done.txId, config.network),
      };
    } finally {
      this.set("idle");
    }
  }
}
