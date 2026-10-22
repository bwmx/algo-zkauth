// connectWallet: use the hosted AlgoZKAuth wallet from any dApp. The wallet runs
// in its own window at its own origin and holds the login session, the salt and
// the signing key; the dApp sees the wallet's address and the results of actions
// the user approved there. One wallet serves every dApp that connects to it.
import { ZkAuthError } from "./errors.ts";
import { isReady, isResponse, PROTOCOL_VERSION, REQUEST, type HostedAccount, type HostedMethod, type HostedParams, type HostedResults, type HostedTx } from "./hosted-protocol.ts";
import type { AssetId, MicroAlgos, SignIn, TxResult, Units } from "./types.ts";
import { toAssetId, toMicroAlgos } from "./util.ts";

export type ConnectWalletOptions = {
  /** The hosted wallet's origin, e.g. "https://wallet.example" or "http://localhost:8770". */
  walletOrigin: string;
  /** Refuse a wallet on another network (localnet | testnet). */
  network?: string;
  /** How long to wait for the user in the wallet window (default 10 minutes). */
  timeoutMs?: number;
  /** For tests: opens the wallet window. Default window.open. */
  open?: (url: string) => Window | null;
};

export type HostedAccountInfo = {
  address: string;
  walletId: bigint;
  provider: string;
  network: string;
  balance: { microAlgos: bigint; spendable: bigint; assets: { id: bigint; amount: bigint }[] };
};

export interface HostedWallet {
  readonly address: string;
  readonly walletId: bigint;
  readonly provider: string;
  readonly network: string;
  /** Each action opens (or focuses) the wallet window, where the user approves it. Call from a click. */
  sendAlgo(o: { to: string; amount: MicroAlgos }): Promise<TxResult>;
  optIn(assetId: AssetId): Promise<TxResult>;
  sendAsset(o: { assetId: AssetId; to: string; amount: Units }): Promise<TxResult>;
  /**
   * Proves to this dApp's backend which wallet the user controls, as session.createSignIn does;
   * the user approves it in the wallet window, which signs for this page's origin. The backend
   * verifies it with @bwmx/algo-zkauth-verify against the hosted wallet's app settings.
   */
  createSignIn(o: { nonce: string; statement?: string }): Promise<SignIn>;
  /** Current address and balance, from the wallet window. */
  account(): Promise<HostedAccountInfo>;
  /** Forgets this dApp in the wallet and closes the window. */
  disconnect(): Promise<void>;
}

const WINDOW = "algozkauth-wallet";
const FEATURES = "popup,width=440,height=760";

/** Opens the hosted wallet and asks the user to connect this dApp. Call it from a click handler. */
export function connectWallet(options: ConnectWalletOptions): Promise<HostedWallet> {
  const origin = new URL(options.walletOrigin).origin;
  const channel = new Channel(origin, options);
  // Opened synchronously so pop-up blockers allow it.
  channel.open();
  return channel.request("connect", options.network ? { network: options.network } : {}).then((account) => new HostedWalletImpl(channel, account));
}

class Channel {
  private popup: Window | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  constructor(readonly origin: string, private readonly options: ConnectWalletOptions) {}

  open() {
    if (this.popup && !this.popup.closed) { this.popup.focus(); return; }
    const url = `${this.origin}/`;
    this.popup = (this.options.open ?? ((u: string) => window.open(u, WINDOW, FEATURES)))(url);
    if (!this.popup) throw new ZkAuthError("popup_blocked", "The browser blocked the wallet window; allow pop-ups for this site");
    this.ready = this.waitFor((data) => isReady(data), "The wallet window did not load").then(() => undefined);
  }

  async request<M extends HostedMethod>(method: M, params: HostedParams[M]): Promise<HostedResults[M]> {
    if (!this.popup || this.popup.closed) this.open();
    await this.ready;
    const id = `${Date.now().toString(36)}-${++this.seq}`;
    const reply = this.waitFor((data) => isResponse(data) && data.id === id, "The wallet did not answer");
    this.popup!.postMessage({ type: REQUEST, v: PROTOCOL_VERSION, id, method, params }, this.origin);
    const response = await reply as { result?: unknown; error?: { code: string; message: string; retryAfter?: number } };
    if (response.error) {
      const error = new ZkAuthError(response.error.code as never, response.error.message);
      if (typeof response.error.retryAfter === "number") (error as { retryAfter?: number }).retryAfter = response.error.retryAfter;
      throw error;
    }
    return response.result as HostedResults[M];
  }

  close() { if (this.popup && !this.popup.closed) this.popup.close(); this.popup = null; }

  /** The next message from the wallet window, at its origin, that `match` accepts. */
  private waitFor(match: (data: unknown) => boolean, timeoutMessage: string): Promise<unknown> {
    const popup = this.popup!;
    return new Promise((resolve, reject) => {
      const timeoutMs = this.options.timeoutMs ?? 600_000;
      const done = () => { window.removeEventListener("message", onMessage); clearTimeout(timer); clearInterval(closed); };
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== this.origin || event.source !== popup || !match(event.data)) return;
        done(); resolve(event.data);
      };
      const timer = setTimeout(() => { done(); reject(new ZkAuthError("timeout", timeoutMessage)); }, timeoutMs);
      const closed = setInterval(() => { if (popup.closed) { done(); reject(new ZkAuthError("wallet_closed", "The wallet window was closed")); } }, 500);
      window.addEventListener("message", onMessage);
    });
  }
}

const tx = (t: HostedTx): TxResult => ({ txId: t.txId, groupId: t.groupId, confirmedRound: BigInt(t.confirmedRound), explorerUrl: t.explorerUrl });
const info = (a: HostedAccount): HostedAccountInfo => ({
  address: a.address, walletId: BigInt(a.walletId), provider: a.provider, network: a.network,
  balance: { microAlgos: BigInt(a.balanceMicroAlgos), spendable: BigInt(a.spendableMicroAlgos), assets: a.assets.map((x) => ({ id: BigInt(x.id), amount: BigInt(x.amount) })) },
});

class HostedWalletImpl implements HostedWallet {
  readonly address: string;
  readonly walletId: bigint;
  readonly provider: string;
  readonly network: string;
  constructor(private readonly channel: Channel, account: HostedAccount) {
    this.address = account.address; this.walletId = BigInt(account.walletId); this.provider = account.provider; this.network = account.network;
  }
  async sendAlgo(o: { to: string; amount: MicroAlgos }) { return tx(await this.channel.request("sendAlgo", { to: o.to, amount: String(toMicroAlgos(o.amount)) })); }
  async optIn(assetId: AssetId) { return tx(await this.channel.request("optIn", { assetId: String(toAssetId(assetId)) })); }
  async sendAsset(o: { assetId: AssetId; to: string; amount: Units }) {
    return tx(await this.channel.request("sendAsset", { assetId: String(toAssetId(o.assetId)), to: o.to, amount: String(o.amount) }));
  }
  async createSignIn(o: { nonce: string; statement?: string }) {
    return this.channel.request("signIn", { nonce: o.nonce, ...(o.statement !== undefined ? { statement: o.statement } : {}) });
  }
  async account() { return info(await this.channel.request("account", {})); }
  async disconnect() { try { await this.channel.request("disconnect", {}); } finally { this.channel.close(); } }
}
