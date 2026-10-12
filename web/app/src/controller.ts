import { decodeAddress, getApplicationAddress, isValidAddress } from "algosdk";
import * as api from "./api";
import { fetchAssetUnit, fetchHistory, type HistoryItem } from "./indexer";
import {
  OPERATION_LABELS, decodeSignals, formatAlgo, hex, parseAlgo, parseUnits, proofBindingChecks, spendable, summarizeToken,
  type BindingCheck, type DecodedSignals, type TokenSummary,
} from "./protocol";
import {
  MAX_PACKAGE_BYTES, browserActionDigest, browserSessionNonce, createRecoveryPackage, enrollPasskey, fromBase64Url,
  generateRecoverySecret, generateWalletSalt, parsePackage, recoveryCommitment, restoreRecoveryPackage, toBase64Url,
  unlockPasskey, validateActionPlan, type Passkey, type RecoveryBinding,
} from "./shared";
import type { ActionPlan, Config, Identity, Measurement, Operation, ProofMeasurement, Wallet } from "./types";

declare global {
  interface Window { google?: any }
}

type Prepared = { plan: ActionPlan; digest: Uint8Array<ArrayBuffer>; digestHex: string; preparedAt: number };
type LoginResult = { identity: Identity; accountCase: string; expiresAt: number };

export type Session = { sessionId: string; nonce: string; expiresAt: number; publicKey: string; randomness: string };
export type StatusKind = "" | "error" | "success";
export type ActivityEntry = { at: number; text: string; kind: "info" | "success" | "error"; txId?: string };
export type ProofState = { stage: string; elapsedMs: number; ready: boolean; decoded?: DecodedSignals; checks?: BindingCheck[]; measurement?: ProofMeasurement };
export type SignedAction = { plan: ActionPlan; digestHex: string; signature: string; measurement: Measurement };
export type BackupState = {
  packageText?: string;
  stage?: "pre-enrollment" | "wallet";
  secret?: string;
  passkey: boolean;
  downloaded: boolean;
  downloadedStage?: "pre-enrollment" | "wallet";
  secretSaved: boolean;
  imported?: string;
  importedHasPasskey: boolean;
  verified: boolean;
  note: string;
};

export type DemoState = {
  config?: Config;
  assetUnit?: string;
  status: { text: string; kind: StatusKind };
  busy?: string;
  loginReady: boolean;
  session?: Session;
  identity?: Identity;
  accountCase?: string;
  token?: TokenSummary;
  commitment?: string;
  hasSalt: boolean;
  saltSentToServer: boolean;
  backup: BackupState;
  proof: ProofState;
  lastProofMs?: number;
  wallet?: Wallet;
  lastExecution: boolean;
  lastAction?: SignedAction;
  review?: { plan: ActionPlan; digestHex: string; preparedAt: number };
  history: { items: HistoryItem[]; loading: boolean; error?: string; updatedAt?: number };
  activity: ActivityEntry[];
};

const emptyProof: ProofState = { stage: "none", elapsedMs: 0, ready: false };
const initialState: DemoState = {
  status: { text: "Loading the local demo…", kind: "" },
  loginReady: false,
  hasSalt: false,
  saltSentToServer: false,
  backup: { passkey: false, downloaded: false, secretSaved: false, importedHasPasskey: false, verified: false, note: "Backup not yet verified." },
  proof: emptyProof,
  lastExecution: false,
  history: { items: [], loading: false },
  activity: [],
};

// Server action plans expire after 120 seconds; leave margin for submission.
const PLAN_REVIEW_MS = 110_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function loadGoogle(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google sign-in library failed to load"));
    document.head.append(script);
  });
}

/**
 * The demo flow as an external store for React.
 * Secrets (salt, session key, recovery secret input, PRF output) live in
 * private fields, never in rendered state, and are cleared on dispose().
 */
export class DemoController {
  state: DemoState = initialState;
  private listeners = new Set<() => void>();
  private salt?: Uint8Array;
  private keyPair?: CryptoKeyPair;
  private passkey?: Passkey;
  private pendingLogin?: { key: CryptoKeyPair; session: Session };
  private prepared?: Prepared;
  private loginContainer?: HTMLElement | null;
  private pollMs: number;
  private historyRetryMs: number;
  private started = false;

  constructor({ pollMs = 2000, historyRetryMs = 5000 }: { pollMs?: number; historyRetryMs?: number } = {}) {
    this.pollMs = pollMs;
    this.historyRetryMs = historyRetryMs;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.state;

  private set(patch: Partial<DemoState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private patchBackup(patch: Partial<BackupState>) { this.set({ backup: { ...this.state.backup, ...patch } }); }
  private setStatus(text: string, kind: StatusKind = "") { this.set({ status: { text, kind } }); }
  private log(text: string, kind: ActivityEntry["kind"] = "info", txId?: string) {
    this.set({ activity: [...this.state.activity, { at: Date.now(), text, kind, txId }] });
  }
  private get sessionId() { return this.state.session?.sessionId; }
  private get config() {
    if (!this.state.config) throw new Error("TestNet deployment configuration unavailable");
    return this.state.config;
  }
  private activeSession() {
    const s = this.state.session;
    return !!this.state.identity && !!s && s.expiresAt > Math.floor(Date.now() / 1000);
  }

  private async run(label: string, task: () => Promise<void>) {
    if (this.state.busy) return;
    this.set({ busy: label });
    try { await task(); }
    catch (error) {
      const message = error instanceof Error && error.message ? error.message : "Demo action failed";
      this.setStatus(message, "error");
      this.log(message, "error");
    }
    finally { this.set({ busy: undefined }); }
  }

  setLoginContainer = (element: HTMLElement | null) => { this.loginContainer = element; };
  setSecretSaved = (saved: boolean) => this.patchBackup({ secretSaved: saved });

  async start() {
    if (this.started) return;
    this.started = true;
    try {
      const config = await api.getConfig();
      if (config.network !== "testnet-v1.0" || !config.registryId || !config.clientId) throw new Error("TestNet Google deployment configuration unavailable");
      this.set({ config });
      fetchAssetUnit(config.demoAssetId).then(unit => unit && this.set({ assetUnit: unit }), () => {});
      await loadGoogle();
      await this.login();
      this.setStatus("Sign in with Google to prepare this account's wallet.");
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : "Demo failed to start", "error");
    }
  }

  private async login() {
    const config = this.config;
    const key = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
    const randomness = crypto.getRandomValues(new Uint8Array(32));
    const pending = await api.post<{ sessionId: string; nonce: string; expiresAt: number }>("login-start", this.sessionId, { sessionPublicKey: toBase64Url(publicKey), randomness: toBase64Url(randomness) });
    // Recompute the nonce here: Google signs it, and it must bind this tab's key.
    const nonce = await browserSessionNonce({ genesisHash: fromBase64Url(config.genesisHash, 32), sessionPublicKey: publicKey, expiresAt: pending.expiresAt, randomness });
    if (nonce !== pending.nonce) throw new Error("Server nonce does not bind this tab's session key; reload the demo");
    const session = { sessionId: pending.sessionId, nonce, expiresAt: pending.expiresAt, publicKey: toBase64Url(publicKey), randomness: toBase64Url(randomness) };
    this.pendingLogin = { key, session };
    this.set({ loginReady: true });
    window.google.accounts.id.initialize({
      client_id: config.clientId, nonce, auto_select: false,
      callback: ({ credential }: { credential: string }) => { this.completeLogin(credential, key, session); },
    });
    this.loginContainer?.replaceChildren();
    if (this.loginContainer) window.google.accounts.id.renderButton(this.loginContainer, { theme: "outline", size: "large", text: "signin_with" });
  }

  private async completeLogin(credential: string, key: CryptoKeyPair, session: Session) {
    try {
      if (this.pendingLogin?.key !== key) throw new Error("This login was replaced by a newer one; use the current Google button");
      const result = await api.post<LoginResult>("login", session.sessionId, { token: credential, userAgent: navigator.userAgent });
      const { identity } = this.state;
      if (identity && JSON.stringify(identity) !== JSON.stringify(result.identity)) throw new Error("Renew using the original Google account. Open a separate tab for a different account.");
      this.keyPair = key;
      this.pendingLogin = undefined;
      // A plan prepared under the previous session cannot be signed by the new key.
      this.prepared = undefined;
      this.set({ identity: result.identity, accountCase: result.accountCase, session, token: summarizeToken(credential), loginReady: false, proof: emptyProof, lastExecution: false, review: undefined });
      if (this.salt) await this.discover();
      this.setStatus(this.salt ? "Session renewed. The original salt is preserved; generate a fresh proof." : "Google identity verified. Create and verify a backup, or restore an existing backup.");
      this.log(`Account ${result.accountCase}: fresh Google login verified.`);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : "Google login failed", "error");
    }
  }

  renew = () => this.run("Renewing session", async () => {
    await this.login();
    this.setStatus("Choose the original account to renew this tab's session.");
  });

  private pendingBinding(): RecoveryBinding {
    return { stage: "pre-enrollment", networkGenesisHash: this.config.genesisHash, registryAppId: "0", walletAppId: "0", walletAddress: null };
  }
  private currentBinding(): RecoveryBinding {
    const wallet = this.state.wallet;
    return wallet?.enrolled
      ? { stage: "wallet", networkGenesisHash: this.config.genesisHash, registryAppId: this.config.registryId, walletAppId: wallet.walletId, walletAddress: wallet.address }
      : this.pendingBinding();
  }

  private showWallet(wallet: Wallet) {
    if (wallet.enrolled && getApplicationAddress(BigInt(wallet.walletId)).toString() !== wallet.address) throw new Error("Wallet address does not match its application ID");
    const previous = this.state.wallet;
    this.set({ wallet });
    const changed = !previous || previous.walletId !== wallet.walletId || previous.nonce !== wallet.nonce || previous.balanceMicroAlgos !== wallet.balanceMicroAlgos || JSON.stringify(previous.assets) !== JSON.stringify(wallet.assets);
    if (wallet.enrolled && changed) {
      this.refreshHistory();
      // The indexer trails algod by a few rounds; look again shortly.
      if (this.historyRetryMs) setTimeout(() => this.refreshHistory(), this.historyRetryMs);
    }
  }

  private async discover(restored = false) {
    const result = await api.post<{ wallet: Wallet; commitment: string }>("discover", this.sessionId, { salt: toBase64Url(this.salt!), restored });
    this.set({ saltSentToServer: true });
    if (result.commitment !== this.state.commitment) throw new Error("Server identity commitment differs from the browser");
    this.showWallet(result.wallet);
    return result.wallet;
  }

  refreshHistory = async () => {
    const wallet = this.state.wallet;
    if (!wallet?.enrolled || !wallet.address) return;
    this.set({ history: { ...this.state.history, loading: true, error: undefined } });
    try {
      const items = await fetchHistory(wallet.address, wallet.walletId);
      this.set({ history: { items, loading: false, updatedAt: Date.now() } });
    } catch (error) {
      this.set({ history: { ...this.state.history, loading: false, error: error instanceof Error ? error.message : "History unavailable" } });
    }
  };

  private async seal() {
    const secret = this.state.backup.secret;
    const packageText = await createRecoveryPackage({ salt: this.salt!, identity: this.state.identity!, binding: this.currentBinding(), recoverySecret: secret!, passkeys: this.passkey ? [this.passkey] : [] });
    this.patchBackup({ packageText, stage: parsePackage(packageText).header.binding.stage, downloaded: false, note: "Download this package and import/restore it with the separately saved secret to verify the export." });
  }

  createBackup = () => this.run("Creating backup", async () => {
    this.salt = generateWalletSalt();
    const secret = await generateRecoverySecret();
    const commitment = toBase64Url(await recoveryCommitment(this.state.identity!, this.salt));
    this.set({ commitment, hasSalt: true });
    this.patchBackup({ secret, verified: false });
    await this.discover();
    await this.seal();
    this.setStatus("Backup created. Save its secret separately, download the encrypted file, and import/restore that file below.");
  });

  copySecret = () => this.run("Copying secret", async () => {
    await navigator.clipboard.writeText(this.state.backup.secret!);
    this.setStatus("Secret copied. Save it privately, then clear the clipboard.");
  });

  addPasskey = () => this.run("Adding passkey", async () => {
    this.setStatus("Approve passkey creation and then its PRF verification prompt…");
    const passkey = await enrollPasskey();
    this.passkey?.output.fill(0);
    this.passkey = passkey;
    await this.seal();
    this.patchBackup({ passkey: true, verified: false });
    this.setStatus("Passkey added. Download and verify the updated package. The recovery secret remains the fallback.");
  });

  download = () => this.run("Downloading backup", async () => {
    const { packageText, stage } = this.state.backup;
    const url = URL.createObjectURL(new Blob([packageText + "\n"], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `algo-zkauth-${parsePackage(packageText!).header.packageId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.patchBackup({ downloaded: true, downloadedStage: stage });
    this.setStatus("Backup download started. Import that exact file and restore with your saved secret to verify it.");
  });

  importFile = (file: File | undefined) => this.run("Reading backup", async () => {
    this.patchBackup({ imported: undefined, importedHasPasskey: false });
    if (!file) return;
    if (file.size > MAX_PACKAGE_BYTES) throw new Error("Recovery package is too large");
    const text = await file.text();
    const parsed = parsePackage(text);
    const binding = parsed.header.binding;
    if (binding.networkGenesisHash !== this.config.genesisHash || (binding.stage === "wallet" && binding.registryAppId !== this.config.registryId)) throw new Error("Backup belongs to a different network/registry. Use its original deployment.");
    this.patchBackup({ imported: text, importedHasPasskey: parsed.slots.some(s => s.kind === "prf") });
    this.setStatus("Package selected. Use its saved secret or original passkey to restore.");
  });

  restore = (usePasskey: boolean, secretText = "") => this.run("Restoring backup", async () => {
    const { backup, identity } = this.state;
    const imported = backup.imported!;
    const parsed = parsePackage(imported);
    let key: Passkey | undefined;
    try {
      const binding = parsed.header.binding.stage === "wallet" ? await api.post<RecoveryBinding>("wallet-binding", this.sessionId, { commitment: parsed.header.commitment }) : this.pendingBinding();
      if (usePasskey) {
        const slot = parsed.slots.find(s => s.kind === "prf" && s.rpId === location.hostname);
        if (!slot) throw new Error("No passkey for this hostname; use the secret");
        key = await unlockPasskey(slot);
      }
      const recovered = await restoreRecoveryPackage({ packageText: imported, identity: identity!, expectedBinding: binding, ...(usePasskey ? { passkey: key } : { recoverySecret: secretText.trim() }) });
      if (this.salt && toBase64Url(this.salt) !== toBase64Url(recovered.salt)) {
        recovered.salt.fill(0);
        throw new Error("Imported backup differs from this tab's identity. Use a fresh tab to restore it.");
      }
      const verifyingNew = !!this.salt && !!backup.packageText && imported.trimEnd() === backup.packageText;
      if (verifyingNew && (!backup.downloaded || !backup.secretSaved || usePasskey)) {
        recovered.salt.fill(0);
        throw new Error("Confirm separate secret storage and verify the downloaded file using the secret before enrollment.");
      }
      this.salt?.fill(0);
      this.salt = recovered.salt;
      this.set({ commitment: toBase64Url(recovered.commitment), hasSalt: true });
      const packageText = backup.packageText ?? imported.trimEnd();
      this.patchBackup({
        verified: true, packageText, stage: parsePackage(packageText).header.binding.stage,
        secret: usePasskey ? backup.secret : secretText.trim(),
        downloaded: backup.downloaded || !backup.packageText, downloadedStage: backup.downloadedStage ?? parsed.header.binding.stage,
        note: "Export/import restoration verified. Preserve the backup and separate secret.",
      });
      const wallet = await this.discover(true);
      this.setStatus(wallet.enrolled ? "Original wallet discovered. Its owner, address and policy match. Generate a fresh proof to authorize transfers." : "Backup verified. Generate the proof, then enroll this identity.", "success");
      this.log(wallet.enrolled ? `Backup restored; original wallet ${wallet.walletId} discovered.` : "Backup restored and verified.", "success");
    } finally {
      key?.output.fill(0);
    }
  });

  refresh = () => this.run("Refreshing wallet", async () => {
    await this.discover();
    this.setStatus("Wallet refreshed from TestNet.");
  });

  prove = () => this.run("Generating proof", async () => {
    const config = this.config;
    this.set({ proof: { stage: "queued", elapsedMs: 0, ready: false } });
    this.setStatus("Preparing the full JWT witness on this Mac…");
    const { jobId } = await api.post<{ jobId: string }>("proof", this.sessionId, { salt: toBase64Url(this.salt!), backupVerified: this.state.backup.verified });
    while (true) {
      await sleep(this.pollMs);
      const result = await api.proofStatus(jobId, this.sessionId!);
      this.set({ proof: { ...this.state.proof, stage: result.stage, elapsedMs: result.elapsedMs } });
      if (result.stage === "failed") throw new Error("The local proof worker failed. Check the local server status, then renew the session and retry.");
      if (result.ready) {
        const decoded = decodeSignals(result.publicSignals!);
        // Independently check the public bindings before any browser signing.
        const sessionKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", this.keyPair!.publicKey)));
        const checks = proofBindingChecks(decoded, { commitment: this.state.commitment!, audienceHash: config.audienceHash, genesisHash: config.genesisHash, sessionKey, expiresAt: this.state.session!.expiresAt, approvedKeys: config.approvedKeys ?? [] });
        const measurement = result.measurement!;
        const ready = checks.every(c => c.ok || !c.required);
        this.set({ proof: { stage: "ready", elapsedMs: measurement.elapsedMs, ready, decoded, checks, measurement }, lastProofMs: measurement.elapsedMs });
        if (!ready) throw new Error("Proof public bindings differ from this browser session");
        await this.discover();
        const summary = `Verified full proof in ${(measurement.elapsedMs / 1000).toFixed(1)} seconds. Peak Node RSS ${(measurement.peakRssBytes / 1024 / 1024).toFixed(0)} MiB.`;
        this.setStatus("Proof verified. Run this account's ALGO / ASA demo, or use individual wallet actions.", "success");
        this.log(summary, "success");
        return;
      }
      this.setStatus(`Local proof: ${result.stage}. Keep this tab open; ${(result.elapsedMs / 1000).toFixed(0)} seconds elapsed.`);
    }
  });

  private async prepareAction(operation: Operation, recipient: string, assetId: string, amount: string): Promise<Prepared> {
    if (!this.activeSession() || !this.state.proof.ready || !this.state.backup.verified) throw new Error("A verified backup and active proof are required");
    await this.discover();
    const { wallet, commitment, session } = this.state;
    const enrollment = operation === "0";
    const expected = { walletId: enrollment ? "0" : wallet!.walletId, operation, recipient, assetId, amount, nonce: enrollment ? "0" : wallet!.nonce, owner: commitment, sessionExpiresAt: String(session!.expiresAt) };
    const plan: ActionPlan = validateActionPlan(await api.post("prepare", this.sessionId, { operation, recipient, assetId, amount }), expected, this.config, decodeAddress);
    const digest = await browserActionDigest(plan);
    return { plan, digest, digestHex: hex(digest), preparedAt: Date.now() };
  }

  private async submitAction({ plan, digest, digestHex }: Prepared) {
    const signature = toBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", this.keyPair!.privateKey, digest)));
    this.setStatus(`Submitting signed ${plan.operation === "0" ? "enrollment" : "wallet action"} to TestNet…`);
    const result = await api.post<{ wallet: Wallet; measurement: Measurement }>("submit", this.sessionId, { planId: plan.planId, signature });
    this.showWallet(result.wallet);
    const m = result.measurement;
    this.set({ lastExecution: plan.operation !== "0" || this.state.lastExecution, lastAction: { plan, digestHex, signature, measurement: m } });
    this.log(`Confirmed ${OPERATION_LABELS[plan.operation]} in round ${m.confirmedRound}; fee ${formatAlgo(m.groupFeeMicroAlgos)}.`, "success", m.transactionIds[0]);
    if (plan.operation === "0" && this.state.backup.secret) {
      await this.seal();
      this.patchBackup({ note: "Wallet enrolled. Download and verify the updated wallet-bound backup. Your earlier verified salt backup also remains usable." });
    }
    return result;
  }

  private async execute(operation: Operation, recipient: string, assetId: string, amount: string) {
    return this.submitAction(await this.prepareAction(operation, recipient, assetId, amount));
  }

  enroll = () => this.run("Enrolling wallet", async () => {
    await this.execute("0", this.config.sponsor, "0", this.config.enrollmentDeposit);
    this.setStatus("Wallet enrolled. Download the updated backup before closing this tab.", "success");
  });

  fund = () => this.run("Funding wallet", async () => {
    this.showWallet((await api.post<{ wallet: Wallet }>("fund", this.sessionId)).wallet);
    this.setStatus("One-time test funding is available.", "success");
  });

  optIn = () => this.run("Opting in", async () => {
    await this.execute("2", this.state.wallet!.address!, this.config.demoAssetId, "0");
    this.setStatus("Demo ASA opt-in confirmed.", "success");
  });

  seed = () => this.run("Receiving demo ASA", async () => {
    this.showWallet((await api.post<{ wallet: Wallet }>("seed", this.sessionId)).wallet);
    this.setStatus("Demo ASA funding is available.", "success");
  });

  /** Prepares and validates a transfer, then waits for the user to review it before signing. */
  prepareTransfer = (form: { assetId: string; amount: string; recipient: string }) => this.run("Preparing transfer", async () => {
    const recipient = form.recipient.trim();
    if (!isValidAddress(recipient)) throw new Error("Enter a valid Algorand destination address");
    const algo = form.assetId === "0";
    const amount = algo ? parseAlgo(form.amount) : parseUnits(form.amount);
    const wallet = this.state.wallet!;
    if (algo && BigInt(amount) > spendable(wallet.balanceMicroAlgos, wallet.minBalanceMicroAlgos)) throw new Error(`Amount exceeds the wallet's spendable ${formatAlgo(spendable(wallet.balanceMicroAlgos, wallet.minBalanceMicroAlgos), true)} above its minimum balance`);
    if (!algo) {
      const holding = wallet.assets.find(a => a.id === form.assetId);
      if (!holding) throw new Error("Opt in to the demo ASA before transferring it");
      if (BigInt(amount) > BigInt(holding.amount)) throw new Error("Amount exceeds the wallet's demo ASA balance");
    }
    this.prepared = await this.prepareAction(algo ? "1" : "3", recipient, form.assetId, amount);
    const { plan, digestHex, preparedAt } = this.prepared;
    this.set({ review: { plan, digestHex, preparedAt } });
    this.setStatus("The server's plan matches your request. Review it, then sign in this tab.");
  });

  confirmTransfer = () => this.run("Signing transfer", async () => {
    const prepared = this.prepared;
    this.prepared = undefined;
    this.set({ review: undefined });
    if (!prepared) throw new Error("Prepare the transfer again");
    if (Date.now() - prepared.preparedAt > PLAN_REVIEW_MS) throw new Error("Action plan expired after two minutes; prepare the transfer again");
    await this.submitAction(prepared);
    this.setStatus("Transfer confirmed and wallet balance refreshed.", "success");
  });

  cancelTransfer = () => {
    this.prepared = undefined;
    this.set({ review: undefined });
    this.setStatus("Transfer cancelled before signing. Nothing was submitted.");
  };

  private async checkReplay() {
    const result = await api.post<{ replayRejectedByNode: boolean; noncePreserved: boolean }>("replay", this.sessionId);
    if (!result.replayRejectedByNode || !result.noncePreserved) throw new Error("Replay rejection check did not pass");
    this.log("Node rejected replay at the wallet's nonce check; nonce unchanged.", "success");
  }

  replay = () => this.run("Checking replay", async () => {
    await this.checkReplay();
    this.setStatus("Replay rejected by TestNet. Wallet nonce is unchanged.", "success");
  });

  runDemo = () => this.run("Running ALGO / ASA demo", async () => {
    const config = this.config;
    if (!this.state.wallet?.enrolled) await this.execute("0", config.sponsor, "0", config.enrollmentDeposit);
    this.showWallet((await api.post<{ wallet: Wallet }>("fund", this.sessionId)).wallet);
    await this.execute("1", config.sponsor, "0", "10000");
    if (!this.state.wallet!.assets.some(a => a.id === config.demoAssetId)) await this.execute("2", this.state.wallet!.address!, config.demoAssetId, "0");
    this.showWallet((await api.post<{ wallet: Wallet }>("seed", this.sessionId)).wallet);
    await this.execute("3", config.sponsor, config.demoAssetId, "7");
    await this.checkReplay();
    const isolation = await api.post<{ available: boolean; wrongOwnerRejectedByNode?: boolean; otherNonceAndBalancePreserved?: boolean; otherWalletId?: string }>("isolation", this.sessionId);
    if (isolation.available) {
      if (!isolation.wrongOwnerRejectedByNode || !isolation.otherNonceAndBalancePreserved) throw new Error("Wallet isolation check did not pass");
      this.log(`TestNet rejected this identity at the other wallet's owner check; wallet ${isolation.otherWalletId} remained unchanged.`, "success");
    }
    this.setStatus("This account's TestNet demo passed: original wallet discovery, ALGO transfer, ASA opt-in/transfer and replay rejection. Download and retain your updated wallet-bound backup.", "success");
  });

  dispose() {
    this.salt?.fill(0);
    this.passkey?.output.fill(0);
    this.salt = undefined;
    this.passkey = undefined;
    this.keyPair = undefined;
    this.pendingLogin = undefined;
    this.prepared = undefined;
  }
}
