// The reference dApp: everything a dApp needs from @algozkauth/sdk in one page.
// Sign in → back up or restore → enroll → fund → send ALGO / assets.
import { useState, type FormEvent, type ReactNode } from "react";
import { algo, downloadBackup, formatAlgo, isZkAuthError, type TxResult } from "@algozkauth/sdk";
import { useSession, useWallet, useZkAuth } from "@algozkauth/sdk/react";

type Activity = { at: string; text: string; tx?: TxResult };

export function App({ service, app }: { service: string; app: string }) {
  const { config } = useZkAuth();
  const { session, status, error: signInError, signIn, signOut, secondsLeft, expiring, expired, renew, renewing } = useSession();
  const [activity, setActivity] = useState<Activity[]>([]);
  const log = (text: string, tx?: TxResult) => setActivity((a) => [{ at: new Date().toLocaleTimeString(), text, ...(tx ? { tx } : {}) }, ...a]);

  return (
    <main>
      <header>
        <h1>AlgoZKAuth demo</h1>
        <p className="muted">
          {config ? <>App <code>{app}</code> on <strong>{config.network}</strong> · sign in with {config.provider} · service <code>{service}</code></> : "Loading configuration…"}
        </p>
      </header>

      <Card n={1} title="Sign in">
        {!session ? (
          <>
            <button data-testid="sign-in" disabled={status === "signing-in" || !config} onClick={() => void signIn().catch(() => {})}>
              {status === "signing-in" ? "Signing in…" : `Sign in with ${config?.provider ?? "your account"}`}
            </button>
            <p className="muted">A login window opens. Your browser makes a signing key for this session only.</p>
          </>
        ) : (
          <>
            <p>Signed in as <strong data-testid="subject">{session.identity.subject}</strong>{" "}
              <span className={expiring ? "warn" : "muted"}>· session {expired ? "expired" : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")} left`}</span></p>
            <div className="row">
              {(expiring || expired) && <button disabled={renewing} onClick={() => void renew().catch(() => {})}>{renewing ? "Renewing…" : "Stay signed in"}</button>}
              <button className="secondary" onClick={() => signOut()}>Sign out</button>
            </div>
          </>
        )}
        <ErrorLine error={signInError} />
      </Card>

      {session && <BackupCard onLog={log} />}
      {session && <WalletCard network={config?.network} service={service} app={app} onLog={log} />}

      {activity.length > 0 && (
        <section className="card">
          <h2>Activity</h2>
          <ul className="activity" data-testid="activity">
            {activity.map((a, i) => (
              <li key={i}><span className="muted">{a.at}</span> {a.text}{a.tx && <> · <code data-testid="tx-id">{a.tx.txId}</code> (round {String(a.tx.confirmedRound)})</>}</li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function BackupCard({ onLog }: { onLog: (text: string) => void }) {
  const { session } = useSession();
  const [secret, setSecret] = useState<string>();
  const [passkey, setPasskey] = useState(false);
  const [file, setFile] = useState<File>();
  const [restoreSecret, setRestoreSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  if (!session) return null;
  const backup = session.backup;
  const run = async (task: () => Promise<void>) => { setBusy(true); setError(undefined); try { await task(); } catch (e) { setError(e); } finally { setBusy(false); } };

  if (backup.hasSalt) {
    return (
      <Card n={2} title="Backup">
        <p className="ok" data-testid="backup-ready">This session has your wallet salt.</p>
        {secret && <SecretBox secret={secret} />}
        {backup.needsExport && (
          <button className="secondary" onClick={() => void run(async () => { downloadBackup(await backup.export()); onLog("Downloaded the wallet-bound backup"); })}>
            Download the updated backup (now names your wallet)
          </button>
        )}
      </Card>
    );
  }
  return (
    <Card n={2} title="Create or restore your backup">
      <p className="muted">Your wallet is found from your login <em>and</em> a random salt that exists only in your backup. Keep the file and the secret in different places.</p>
      <div className="split">
        <div>
          <h3>New here</h3>
          <label className="check"><input type="checkbox" checked={passkey} onChange={(e) => setPasskey(e.target.checked)} /> Also unlock with a passkey</label>
          <button data-testid="create-backup" disabled={busy} onClick={() => void run(async () => {
            const made = await backup.create({ passkey });
            downloadBackup(made);
            setSecret(made.secret);
            onLog(made.passkey ? "Created a backup (secret and passkey)" : "Created a backup");
          })}>Create wallet backup</button>
        </div>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (file) void run(async () => { const r = await backup.restore(file, { secret: restoreSecret.trim() }); onLog(r.enrolled ? `Restored wallet ${r.walletId}` : "Restored the backup"); }); }}>
          <h3>Returning</h3>
          <input data-testid="restore-file" type="file" accept=".json,application/json" onChange={(e) => setFile(e.target.files?.[0])} />
          <input data-testid="restore-secret" type="password" placeholder="Recovery secret (ZKR1:…)" value={restoreSecret} onChange={(e) => setRestoreSecret(e.target.value)} autoComplete="off" />
          <div className="row">
            <button data-testid="restore" type="submit" disabled={busy || !file || !restoreSecret}>Restore with secret</button>
            <button type="button" className="secondary" disabled={busy || !file} onClick={() => file && void run(async () => { const r = await backup.restore(file, { passkey: true }); onLog(r.enrolled ? `Restored wallet ${r.walletId} with a passkey` : "Restored the backup with a passkey"); })}>Use passkey</button>
          </div>
        </form>
      </div>
      <ErrorLine error={error} />
    </Card>
  );
}

function SecretBox({ secret }: { secret: string }) {
  return (
    <div className="secret">
      <p><strong>Your recovery secret.</strong> Save it now, apart from the downloaded file. It is not shown again.</p>
      <code data-testid="recovery-secret">{secret}</code>
      <button className="secondary" onClick={() => void navigator.clipboard?.writeText(secret)}>Copy</button>
    </div>
  );
}

function WalletCard({ network, service, app, onLog }: { network?: string; service: string; app: string; onLog: (text: string, tx?: TxResult) => void }) {
  const { wallet, balance, address, enrolled, busy, error, enroll, sendAlgo, optIn, sendAsset, refresh } = useWallet({ pollMs: 10_000 });
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("0.1");
  const [assetId, setAssetId] = useState("");
  const [units, setUnits] = useState("1");
  const [funding, setFunding] = useState<string>();
  if (!wallet) return null;
  const idle = busy === "idle";
  const act = (label: string, task: () => Promise<TxResult | null>) => () => void task().then((tx) => tx && onLog(label, tx)).catch(() => {});

  const fund = async () => {
    setFunding("Requesting test ALGO…");
    try {
      const r = await fetch(`${service}/v1/apps/${encodeURIComponent(app)}/dev/fund`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error?.message ?? "Faucet unavailable");
      setFunding(undefined); onLog("Received 5 test ALGO from the LocalNet faucet"); await refresh();
    } catch (e) { setFunding((e as Error).message); }
  };

  return (
    <Card n={3} title="Wallet">
      {!enrolled ? (
        <>
          <p className="muted">No wallet on chain yet. Enrolling creates it; the service pays the deposit and fees.</p>
          <button data-testid="enroll" disabled={!idle} onClick={act("Enrolled the wallet", enroll)}>{idle ? "Create wallet on chain" : `${busy}…`}</button>
        </>
      ) : (
        <>
          <p>Address <code data-testid="wallet-address">{address}</code></p>
          <p>Balance <strong data-testid="balance">{balance ? formatAlgo(balance.microAlgos) : "…"}</strong> ALGO
            {balance && <span className="muted"> ({formatAlgo(balance.spendable)} spendable)</span>}
            {balance && balance.assets.length > 0 && <span className="muted"> · assets {balance.assets.map((a) => `${a.id}: ${a.amount}`).join(", ")}</span>}</p>
          {network === "localnet" && <p><button data-testid="faucet" className="secondary" onClick={() => void fund()}>Get 5 test ALGO</button> <span className="muted">{funding}</span></p>}

          <form className="row" onSubmit={(e) => { e.preventDefault(); act(`Sent ${amount} ALGO`, () => sendAlgo({ to: to.trim(), amount: algo(amount) }))(); }}>
            <input data-testid="send-to" placeholder="Recipient address" value={to} onChange={(e) => setTo(e.target.value)} />
            <input data-testid="send-amount" className="short" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <button data-testid="send" type="submit" disabled={!idle || !to}>{idle ? "Send ALGO" : `${busy}…`}</button>
          </form>
          <form className="row" onSubmit={(e) => { e.preventDefault(); act(`Sent ${units} of asset ${assetId}`, () => sendAsset({ assetId: BigInt(assetId), to: to.trim(), amount: BigInt(units) }))(); }}>
            <input placeholder="Asset id" className="short" value={assetId} onChange={(e) => setAssetId(e.target.value)} />
            <input className="short" value={units} onChange={(e) => setUnits(e.target.value)} />
            <button type="button" className="secondary" disabled={!idle || !assetId} onClick={act(`Opted in to asset ${assetId}`, () => optIn(BigInt(assetId)))}>Opt in</button>
            <button type="submit" disabled={!idle || !assetId || !to}>Send asset</button>
          </form>
        </>
      )}
      <ErrorLine error={error} />
    </Card>
  );
}

function Card({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return <section className="card"><h2><span className="step">{n}</span>{title}</h2>{children}</section>;
}

function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  const text = isZkAuthError(error)
    ? `${error.message}${error.retryAfter ? ` (retry in ${error.retryAfter} s)` : ""}`
    : (error as Error).message ?? "Something went wrong";
  return <p className="error" role="alert" data-testid="error">{text}</p>;
}
