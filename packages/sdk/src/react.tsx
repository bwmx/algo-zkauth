// React bindings: <ZkAuthProvider>, useZkAuth, useSession, useWallet. Optional; needs react >= 18.
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createZkAuth } from "./index.ts";
import type {
  AppConfig, AssetId, Balance, HistoryItem, MicroAlgos, ProviderId, Session, SignInOptions, TxResult, Units, Wallet, WalletStatus, ZkAuth, ZkAuthOptions,
} from "./types.ts";

export type AuthStatus = "signed-out" | "signing-in" | "signed-in";

type AuthState = {
  zk: ZkAuth;
  session: Session | null;
  config: AppConfig | null;
  status: AuthStatus;
  error: Error | null;
  signIn(provider?: ProviderId, options?: SignInOptions): Promise<Session>;
  signOut(): Promise<void>;
};

const Context = createContext<AuthState | null>(null);

export type ZkAuthProviderProps = { children?: ReactNode } & ({ zk: ZkAuth } | ({ zk?: undefined } & ZkAuthOptions));

export function ZkAuthProvider(props: ZkAuthProviderProps) {
  const { children, zk: given, ...options } = props as { children?: ReactNode; zk?: ZkAuth } & ZkAuthOptions;
  // A client created from props lives as long as the provider; changing service/app starts a new one.
  const created = useRef<{ key: string; zk: ZkAuth } | null>(null);
  const key = `${options.service}\n${options.app}`;
  if (!given && created.current?.key !== key) created.current = { key, zk: createZkAuth(options) };
  const zk = given ?? created.current!.zk;

  const [session, setSession] = useState<Session | null>(zk.session);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setSession(zk.session);
    const off = zk.on("session", setSession);
    let live = true;
    zk.config().then((c) => { if (live) setConfig(c); }, (e: unknown) => { if (live) setError(e as Error); });
    return () => { live = false; off(); };
  }, [zk]);

  const signIn = useCallback(async (provider?: ProviderId, o?: SignInOptions) => {
    setSigningIn(true);
    setError(null);
    try { return await zk.signIn(provider, o); }
    catch (e) { setError(e as Error); throw e; }
    finally { setSigningIn(false); }
  }, [zk]);
  const signOut = useCallback(() => zk.signOut(), [zk]);

  const value = useMemo<AuthState>(() => ({
    zk, session, config, error, signIn, signOut,
    status: signingIn ? "signing-in" : session ? "signed-in" : "signed-out",
  }), [zk, session, config, error, signingIn, signIn, signOut]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The client, public config and sign-in state. */
export function useZkAuth(): AuthState {
  const value = useContext(Context);
  if (!value) throw new Error("useZkAuth must be used inside <ZkAuthProvider>");
  return value;
}

/** Re-renders when the session (or an object it owns) emits "change". */
function useChanges(source: { on(event: "change", listener: () => void): () => void } | null | undefined) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => (source ? source.on("change", bump) : undefined), [source]);
}

export type UseSession = {
  session: Session | null;
  status: AuthStatus;
  error: Error | null;
  /** True from the "expiring" event until the session is renewed or expires. */
  expiring: boolean;
  expired: boolean;
  secondsLeft: number;
  renewing: boolean;
  signIn: AuthState["signIn"];
  signOut: AuthState["signOut"];
  renew(options?: SignInOptions): Promise<Session>;
};

export function useSession(): UseSession {
  const { session, status, error: authError, signIn, signOut } = useZkAuth();
  const [expiring, setExpiring] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [renewError, setRenewError] = useState<Error | null>(null);
  useChanges(session);
  useEffect(() => {
    setExpiring(false);
    if (!session) return;
    const offs = [session.on("expiring", () => setExpiring(true)), session.on("expired", () => setExpiring(false))];
    return () => offs.forEach((off) => off());
  }, [session]);

  const renew = useCallback(async (options?: SignInOptions) => {
    if (!session) throw new Error("There is no session to renew");
    setRenewing(true);
    setRenewError(null);
    try { const renewed = await session.renew(options); setExpiring(false); return renewed; }
    catch (e) { setRenewError(e as Error); throw e; }
    finally { setRenewing(false); }
  }, [session]);

  return {
    session, status, error: renewError ?? authError, expiring, renewing, signIn, signOut, renew,
    expired: session?.expired ?? false, secondsLeft: session?.secondsLeft ?? 0,
  };
}

export type UseWallet = {
  /** null until a salt exists (session.backup.create()/restore()). */
  wallet: Wallet | null;
  /** true while loading the wallet or running an action. */
  loading: boolean;
  /** Which step an action is in: proving, enrolling, preparing, signing, submitting. */
  busy: WalletStatus;
  progress: string | null;
  error: Error | null;
  enrolled: boolean;
  address: string | null;
  balance: Balance | null;
  refresh(): Promise<void>;
  enroll(): Promise<TxResult | null>;
  sendAlgo(o: { to: string; amount: MicroAlgos }): Promise<TxResult>;
  optIn(assetId: AssetId): Promise<TxResult>;
  sendAsset(o: { assetId: AssetId; to: string; amount: Units }): Promise<TxResult>;
  history(o?: { limit?: number }): Promise<HistoryItem[]>;
};

/** The session's wallet with loading/error state; re-renders when its balance or status changes. */
export function useWallet(o: { pollMs?: number } = {}): UseWallet {
  const { session } = useZkAuth();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const hasSalt = session?.backup.hasSalt ?? false;
  useChanges(session);
  useChanges(wallet);

  useEffect(() => {
    setWallet(null);
    setBalance(null);
    if (!session || !hasSalt) return;
    let live = true;
    setLoading(true);
    setError(null);
    session.wallet()
      .then(async (w) => { if (!live) return; setWallet(w); const b = await w.balance(); if (live) setBalance(b); })
      .catch((e: unknown) => { if (live) setError(e as Error); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [session, hasSalt]);

  const refresh = useCallback(async () => {
    if (!wallet) return;
    try { setBalance(await wallet.balance()); setError(null); }
    catch (e) { setError(e as Error); throw e; }
  }, [wallet]);

  useEffect(() => {
    if (!wallet || !o.pollMs) return;
    const timer = setInterval(() => { refresh().catch(() => {}); }, o.pollMs);
    return () => clearInterval(timer);
  }, [wallet, o.pollMs, refresh]);

  const [acting, setActing] = useState(0);
  const act = useCallback(async <T,>(run: (w: Wallet) => Promise<T>): Promise<T> => {
    if (!wallet) throw new Error("The wallet is not ready: create or restore a backup first");
    setActing((n) => n + 1);
    setError(null);
    try {
      const result = await run(wallet);
      await wallet.balance().then(setBalance, () => {});
      return result;
    } catch (e) { setError(e as Error); throw e; }
    finally { setActing((n) => n - 1); }
  }, [wallet]);

  return {
    wallet, balance, error, refresh,
    loading: loading || acting > 0,
    busy: wallet?.status ?? "idle", progress: wallet?.progress ?? null,
    enrolled: wallet?.enrolled ?? false, address: wallet?.address ?? null,
    enroll: () => act((w) => w.enroll()),
    sendAlgo: (a) => act((w) => w.sendAlgo(a)),
    optIn: (id) => act((w) => w.optIn(id)),
    sendAsset: (a) => act((w) => w.sendAsset(a)),
    history: (h) => (wallet ? wallet.history(h) : Promise.reject(new Error("The wallet is not ready"))),
  };
}
