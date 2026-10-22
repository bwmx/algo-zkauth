// The hosted AlgoZKAuth wallet. dApps open this page with connectWallet(); it
// holds the login session, the salt and the signing key, shows every request
// to the user, and answers only the dApp that opened it (serveWallet).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { downloadBackup, formatAlgo, isZkAuthError, ZkAuthError, type Balance, type TxResult, type Wallet } from "@algozkauth/sdk";
import { useSession, useWallet, useZkAuth } from "@algozkauth/sdk/react";
import { serveWallet, type HostedAccount, type HostedMethod, type HostedTx } from "@algozkauth/sdk/wallet-host";

type Pending = { id: number; origin: string; method: HostedMethod; params: Record<string, string>; resolve: (approved: boolean) => void };

// What this browser remembers at the wallet's origin. The backup entry is opt-in:
// it keeps the backup file and its secret together, so anyone using this browser
// profile with the same login can open the wallet.
const SITES = "algozkauth.wallet.sites";
const backupKey = (provider: string, subject: string) => `algozkauth.wallet.backup:${provider}:${subject}`;
const read = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? "") as T; } catch { return fallback; } };
const write = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } };

const hostedTx = (t: TxResult): HostedTx => ({ txId: t.txId, groupId: t.groupId, confirmedRound: String(t.confirmedRound), explorerUrl: t.explorerUrl });
const describe = (p: Pending) => {
  switch (p.method) {
    case "connect": return "wants to connect to your wallet. It will see your wallet address and balance, and can ask you to approve transfers.";
    case "sendAlgo": return `asks you to send ${formatAlgo(BigInt(p.params.amount!), { trim: true })}`;
    case "optIn": return `asks you to opt in to asset ${p.params.assetId}`;
    case "sendAsset": return `asks you to send ${p.params.amount} units of asset ${p.params.assetId}`;
    case "signIn": return "asks you to sign in. Its server will learn your wallet address, not the account you log in with.";
    default: return `asks for ${p.method}`;
  }
};

export function App() {
  const { config } = useZkAuth();
  const { session, status, error: signInError, signIn, signOut } = useSession();
  const { wallet, address, enrolled, balance, busy, error: walletError, refresh } = useWallet({ pollMs: 15_000 });
  const [pending, setPending] = useState<Pending[]>([]);
  const [sites, setSites] = useState<string[]>(() => read(SITES, []));
  const [remember, setRemember] = useState(false);
  const live = useRef({ wallet, config, sites, session });
  live.current = { wallet, config, sites, session };
  const opened = typeof window !== "undefined" && !!window.opener;

  // Answer the dApp that opened this window.
  useEffect(() => {
    if (!window.opener) return;
    let seq = 0;
    const ask = (origin: string, method: HostedMethod, params: Record<string, string>) =>
      new Promise<boolean>((resolve) => setPending((p) => [...p, { id: ++seq, origin, method, params, resolve }]));
    const approved = async (origin: string, method: HostedMethod, params: Record<string, string>) => {
      if (!(await ask(origin, method, params))) throw new ZkAuthError("user_rejected", "Declined in the wallet");
      const w = live.current.wallet;
      if (!w) throw new ZkAuthError("not_signed_in", "Sign in to the wallet and open your backup first");
      if (!w.enrolled) await w.enroll();
      return w;
    };
    const account = async (): Promise<HostedAccount> => {
      const w = live.current.wallet as Wallet | null;
      if (!w?.address || w.id === null) throw new ZkAuthError("not_enrolled", "The wallet is not ready");
      const b = await w.balance();
      return {
        address: w.address, walletId: String(w.id), provider: live.current.config!.provider, network: live.current.config!.network,
        balanceMicroAlgos: String(b.microAlgos), spendableMicroAlgos: String(b.spendable), assets: b.assets.map((a) => ({ id: String(a.id), amount: String(a.amount) })),
      };
    };
    const setSitesBoth = (next: string[]) => { write(SITES, next); setSites(next); };
    return serveWallet({
      isConnected: (origin) => live.current.sites.includes(origin),
      connect: async (origin, params) => {
        if (params.network && live.current.config && params.network !== live.current.config.network)
          throw new ZkAuthError("network_mismatch", `This wallet is on ${live.current.config.network}`);
        await approved(origin, "connect", params as Record<string, string>);
        if (!live.current.sites.includes(origin)) setSitesBoth([...live.current.sites, origin]);
        live.current.sites = [...new Set([...live.current.sites, origin])];
        return account();
      },
      account: () => account(),
      sendAlgo: async (origin, p) => hostedTx(await (await approved(origin, "sendAlgo", p)).sendAlgo({ to: p.to, amount: BigInt(p.amount) })),
      optIn: async (origin, p) => hostedTx(await (await approved(origin, "optIn", p)).optIn(BigInt(p.assetId))),
      sendAsset: async (origin, p) => hostedTx(await (await approved(origin, "sendAsset", p)).sendAsset({ assetId: BigInt(p.assetId), to: p.to, amount: BigInt(p.amount) })),
      // The message names the origin this window saw the request come from, never one the dApp chose.
      signIn: async (origin, p) => {
        await approved(origin, "signIn", p as Record<string, string>);
        return live.current.session!.createSignIn({ origin, nonce: p.nonce, ...(p.statement !== undefined ? { statement: p.statement } : {}) });
      },
      disconnect: async (origin) => { const next = live.current.sites.filter((s) => s !== origin); live.current.sites = next; setSitesBoth(next); },
    });
  }, []);

  // A backup remembered on this device opens the wallet right after sign-in.
  useEffect(() => {
    if (!session || session.backup.hasSalt) return;
    const saved = read<{ packageText: string; secret: string } | null>(backupKey(session.provider, session.identity.subject), null);
    if (saved) void session.backup.restore(saved.packageText, { secret: saved.secret }).catch(() => {});
  }, [session]);

  // After enrollment the backup names the wallet; keep the remembered copy current.
  useEffect(() => {
    if (!session || !enrolled || !session.backup.needsExport) return;
    const key = backupKey(session.provider, session.identity.subject);
    const saved = read<{ packageText: string; secret: string } | null>(key, null);
    if (saved) void session.backup.export({ secret: saved.secret }).then(async (b) => write(key, { ...saved, packageText: await b.file.text() })).catch(() => {});
  }, [session, enrolled]);

  const settle = (p: Pending, ok: boolean) => { p.resolve(ok); setPending((all) => all.filter((x) => x.id !== p.id)); };
  const current = pending[0];
  const walletReady = !!wallet;

  return (
    <main>
      <header>
        <h1>AlgoZKAuth Wallet</h1>
        <p className="muted">{config ? <>{config.network} · sign in with {config.provider}</> : "Loading…"}{opened ? " · connected to the page that opened this window" : " · dApps open this page with connectWallet()"}</p>
      </header>

      {current && (
        <section className="card request" data-testid="request">
          <h2>{current.method === "connect" ? "Connection request" : current.method === "signIn" ? "Sign-in request" : "Approve a transaction"}</h2>
          <p><strong data-testid="request-origin">{current.origin}</strong> {describe(current)}</p>
          {current.params.statement && <p data-testid="request-statement">“{current.params.statement}”</p>}
          {current.params.to && <dl><dt>To</dt><dd><code>{current.params.to}</code></dd></dl>}
          {current.params.to && current.params.to === address && <p className="warn" data-testid="request-self">This is your wallet's own address: the transfer would come straight back to it.</p>}
          {!walletReady && <p className="warn">Sign in and open your wallet below to approve.</p>}
          <div className="row">
            <button data-testid="approve" disabled={!walletReady || busy !== "idle"} onClick={() => settle(current, true)}>{current.method === "connect" ? "Connect" : current.method === "signIn" ? "Sign in" : "Approve"}</button>
            <button data-testid="reject" className="secondary" onClick={() => settle(current, false)}>Reject</button>
          </div>
        </section>
      )}

      <Card title="Sign in">
        {!session ? (
          <button data-testid="sign-in" disabled={status === "signing-in" || !config} onClick={() => void signIn().catch(() => {})}>
            {status === "signing-in" ? "Signing in…" : `Sign in with ${config?.provider ?? "your account"}`}
          </button>
        ) : (
          <div className="row"><span>Signed in as <strong data-testid="subject">{session.identity.subject}</strong></span><button className="secondary" onClick={() => signOut()}>Sign out</button></div>
        )}
        <ErrorLine error={signInError} />
      </Card>

      {session && !session.backup.hasSalt && <BackupCard remember={remember} setRemember={setRemember} />}

      {wallet && (
        <Card title="Your wallet">
          {address ? <p>Address <code data-testid="wallet-address">{address}</code></p> : <p className="muted">Created on chain when you first connect a dApp.</p>}
          {balance && <p>Balance <strong>{formatAlgo(balance.microAlgos, { trim: true })}</strong></p>}
          {address && <Faucet address={address} balance={balance} refresh={refresh} />}
          <ErrorLine error={walletError} />
        </Card>
      )}

      {sites.length > 0 && (
        <Card title="Connected sites">
          <ul className="sites">
            {sites.map((s) => <li key={s}><code>{s}</code><button className="secondary" onClick={() => { const next = sites.filter((x) => x !== s); write(SITES, next); setSites(next); }}>Disconnect</button></li>)}
          </ul>
        </Card>
      )}
    </main>
  );
}

function BackupCard({ remember, setRemember }: { remember: boolean; setRemember: (v: boolean) => void }) {
  const { session } = useSession();
  const [secret, setSecret] = useState<string>();
  const [file, setFile] = useState<File>();
  const [restoreSecret, setRestoreSecret] = useState("");
  const [error, setError] = useState<unknown>();
  if (!session) return null;
  const key = backupKey(session.provider, session.identity.subject);
  const run = (task: () => Promise<void>) => { setError(undefined); void task().catch(setError); };
  return (
    <Card title="Open your wallet">
      <p className="muted">One wallet for every dApp you connect. It is found from your login and the salt in your backup.</p>
      <label className="check"><input data-testid="remember" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember the backup on this device (anyone using this browser profile and your login can then open the wallet)</label>
      <div className="split">
        <div>
          <h3>New wallet</h3>
          <button data-testid="create-backup" onClick={() => run(async () => {
            const made = await session.backup.create();
            downloadBackup(made); setSecret(made.secret);
            if (remember) write(key, { packageText: await made.file.text(), secret: made.secret });
          })}>Create wallet backup</button>
          {secret && <p className="secret">Recovery secret, keep it apart from the file: <code data-testid="recovery-secret">{secret}</code></p>}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); if (file) run(async () => {
          await session.backup.restore(file, { secret: restoreSecret.trim() });
          if (remember) write(key, { packageText: await file.text(), secret: restoreSecret.trim() });
        }); }}>
          <h3>Existing wallet</h3>
          <input data-testid="restore-file" type="file" accept=".json,application/json" onChange={(e) => setFile(e.target.files?.[0])} />
          <input data-testid="restore-secret" type="password" placeholder="Recovery secret (ZKR1:…)" value={restoreSecret} onChange={(e) => setRestoreSecret(e.target.value)} />
          <button data-testid="restore" type="submit" disabled={!file || !restoreSecret}>Restore</button>
        </form>
      </div>
      <ErrorLine error={error} />
    </Card>
  );
}

// The service's wallet faucet, when its config offers one (TestNet): test ALGO
// from its sponsor, once per wallet, so the wallet can pay for what dApps ask.
function Faucet({ address, balance, refresh }: { address: string; balance: Balance | null | undefined; refresh: () => Promise<void> }) {
  const { zk, config } = useZkAuth();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [message, setMessage] = useState<string>();
  if (!config?.faucet || state === "done" || (balance && balance.spendable >= BigInt(config.faucet.amountMicroAlgos))) return null;
  const amount = String(Number(BigInt(config.faucet.amountMicroAlgos)) / 1e6);
  const claim = async () => {
    setState("busy"); setMessage(undefined);
    try {
      const r = await fetch(`${zk.options.service}/v1/apps/${encodeURIComponent(zk.options.app)}/faucet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error?.message ?? "Faucet unavailable");
      setState("done"); await refresh();
    } catch (e) { setState("idle"); setMessage((e as Error).message); }
  };
  return (
    <p className="row">
      <button data-testid="faucet-claim" className="secondary" disabled={state === "busy"} onClick={() => void claim()}>{state === "busy" ? "Requesting…" : `Get ${amount} test ALGO`}</button>
      <span className="muted">{message ?? "once per wallet"}</span>
    </p>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section className="card"><h2>{title}</h2>{children}</section>;
}

function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="error" role="alert">{isZkAuthError(error) ? error.message : (error as Error).message ?? "Something went wrong"}</p>;
}
