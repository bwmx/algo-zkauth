// @bwmx/algo-zkauth — sign in with an OpenID provider, control an Algorand app wallet.
// The default import has no snarkjs and no UI framework: browser proving lives in ./prover-worker
// (hosted by the dApp) and React bindings in ./react.
import type { Ctx } from "./context.ts";
import { ZkAuthError } from "./errors.ts";
import { Api } from "./http.ts";
import { createBrowserProver } from "./proving.ts";
import { SessionImpl } from "./session.ts";
import { openLoginWindow, startLogin } from "./signin.ts";
import type { AppConfig, ProviderId, Session, SignInOptions, ZkAuth, ZkAuthOptions } from "./types.ts";
import { Emitter, algo, downloadBackup, formatAlgo } from "./util.ts";

export type * from "./types.ts";
export { ZkAuthError, isZkAuthError } from "./errors.ts";
export { algo, downloadBackup, formatAlgo };
// The hosted shared wallet: one wallet for every dApp that connects to it.
export { connectWallet } from "./hosted.ts";
export type { ConnectWalletOptions, HostedWallet, HostedAccountInfo } from "./hosted.ts";

class ZkAuthImpl implements ZkAuth {
  session: SessionImpl | null = null;
  private readonly api: Api;
  private cached: AppConfig | undefined;
  private pending: Promise<AppConfig> | undefined;
  private attempt: AbortController | undefined;
  private readonly events = new Emitter();

  constructor(readonly options: ZkAuthOptions) {
    this.api = new Api(options.service, options.fetch);
  }

  config(): Promise<AppConfig> {
    if (this.cached) return Promise.resolve(this.cached);
    this.pending ??= (async () => {
      try {
        const config = await this.api.get<AppConfig>(`/v1/apps/${encodeURIComponent(this.options.app)}/config`);
        if (this.options.network && config.network !== this.options.network) {
          throw new ZkAuthError("network_mismatch", `This app is deployed on ${config.network}, not ${this.options.network}`);
        }
        this.cached = config;
        return config;
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }

  private context(config: AppConfig): Ctx {
    const { options } = this;
    const prover = options.proving === "browser"
      ? createBrowserProver(options.browserProver ?? (() => { throw new ZkAuthError("bad_request", "proving: \"browser\" needs the browserProver option"); })())
      : undefined;
    return {
      options, api: this.api, config, fetchFn: () => options.fetch ?? globalThis.fetch.bind(globalThis),
      ...(prover ? { prover } : {}),
      pollMs: options.pollMs ?? 1000, proofTimeoutMs: options.proofTimeoutMs ?? 300_000, expiringSeconds: options.expiringSeconds ?? 60,
    };
  }

  async signIn(provider?: ProviderId, options: SignInOptions = {}): Promise<Session> {
    // Everything before the first await runs inside the caller's click, which code-flow pop-ups need.
    const popup = openLoginWindow(this.cached, provider, options.login ?? this.options.login);
    this.attempt?.abort();
    const attempt = (this.attempt = new AbortController());
    const signal = options.signal ? AbortSignal.any([options.signal, attempt.signal]) : attempt.signal;
    try {
      const config = await this.config();
      const login = await startLogin(this.context(config), provider, { ...options, signal }, popup);
      const session = new SessionImpl(this.context(config), login);
      const previous = this.session;
      this.session = session;
      void previous?.close();
      this.events.emit("session", session);
      return session;
    } catch (error) {
      if (popup && !popup.closed) popup.close();
      throw error;
    } finally {
      if (this.attempt === attempt) this.attempt = undefined;
    }
  }

  async signOut(): Promise<void> {
    this.attempt?.abort();
    const session = this.session;
    this.session = null;
    this.events.emit("session", null);
    await session?.close();
  }

  on(event: "session", listener: (session: Session | null) => void): () => void {
    return this.events.on(event, listener);
  }
}

/** Creates the SDK client. Cheap: nothing touches the network until config() or signIn(). */
export function createZkAuth(options: ZkAuthOptions): ZkAuth {
  if (!options?.service || !options.app) throw new ZkAuthError("bad_request", "createZkAuth needs the service URL and the app id");
  if (options.proving === "browser" && !options.browserProver) {
    throw new ZkAuthError("bad_request", "proving: \"browser\" needs the browserProver option (wasmUrl, zkeyUrl, snarkjsUrl)");
  }
  return new ZkAuthImpl(options);
}
