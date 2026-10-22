// The reference dApp: everything a dApp needs from @bwmx/algo-zkauth in one page.
// Sign in → back up or restore → enroll → fund → send ALGO / assets.
import { useState, type FormEvent, type ReactNode } from "react";
import { algo, connectWallet, downloadBackup, formatAlgo, isZkAuthError, type HostedWallet, type TxResult } from "@bwmx/algo-zkauth";
import { useSession, useWallet, useZkAuth } from "@bwmx/algo-zkauth/react";

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

      <SharedWalletCard network={config?.network} onLog={log} />

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
  const { config } = useZkAuth();
  const { wallet, balance, address, enrolled, busy, error, enroll, sendAlgo, optIn, sendAsset, refresh } = useWallet({ pollMs: 10_000 });
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("0.1");
  const [assetId, setAssetId] = useState("");
  const [units, setUnits] = useState("1");
  const [funding, setFunding] = useState<string>();
  const [claimed, setClaimed] = useState(false);
  if (!wallet) return null;
  const idle = busy === "idle";
  const act = (label: string, task: () => Promise<TxResult | null>) => () => void task().then((tx) => tx && onLog(label, tx)).catch(() => {});
  // The service's wallet faucet, when its config offers one (TestNet): once per wallet.
  const faucetAlgo = config?.faucet ? String(Number(BigInt(config.faucet.amountMicroAlgos)) / 1e6) : undefined;

  // path: dev/fund (the LocalNet faucet, any address) or faucet (the wallet faucet).
  const fund = async (path: string, received: string) => {
    setFunding("Requesting test ALGO…");
    try {
      const r = await fetch(`${service}/v1/apps/${encodeURIComponent(app)}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error?.message ?? "Faucet unavailable");
      setFunding(undefined); onLog(received); await refresh();
      return true;
    } catch (e) { setFunding((e as Error).message); return false; }
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
          <p>Balance <strong data-testid="balance">{balance ? formatAlgo(balance.microAlgos, { trim: true }) : "…"}</strong>
            {balance && <span className="muted"> ({formatAlgo(balance.spendable, { trim: true })} spendable)</span>}
            {balance && balance.assets.length > 0 && <span className="muted"> · assets {balance.assets.map((a) => `${a.id}: ${a.amount}`).join(", ")}</span>}</p>
          {(network === "localnet" || faucetAlgo) ? (
            <p className="row">
              {network === "localnet" && <button data-testid="faucet" className="secondary" onClick={() => void fund("dev/fund", "Received 5 test ALGO from the LocalNet faucet")}>Get 5 test ALGO</button>}
              {faucetAlgo && !claimed && !(balance && balance.spendable >= BigInt(config!.faucet!.amountMicroAlgos)) && <button data-testid="faucet-claim" className="secondary" title="Once per wallet, from the service's sponsor"
                onClick={() => void fund("faucet", `Received ${faucetAlgo} test ALGO from the faucet`).then((ok) => ok && setClaimed(true))}>Get {faucetAlgo} test ALGO</button>}
              <span className="muted">{funding}</span>
            </p>
          ) : <p className="muted">Send this address some test ALGO before transferring.</p>}

          <form className="row" onSubmit={(e) => { e.preventDefault(); act(`Sent ${amount} ALGO`, () => sendAlgo({ to: to.trim(), amount: algo(amount) }))(); }}>
            <input data-testid="send-to" placeholder="Recipient address" value={to} onChange={(e) => setTo(e.target.value)} />
            <input data-testid="send-amount" className="short" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <button data-testid="send" type="submit" disabled={!idle || !to}>{idle ? "Send ALGO" : `${busy}…`}</button>
          </form>
          <Recipient to={to} self={address} sponsor={config?.sponsor} onPick={setTo} />
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

// The other integration: the hosted AlgoZKAuth Wallet, one wallet across dApps.
// This page never sees the login, salt or key; the user approves each action there.
const walletOrigin = import.meta.env.VITE_ZKAUTH_WALLET ?? "http://localhost:8770";

function SharedWalletCard({ network, onLog }: { network?: string; onLog: (text: string, tx?: TxResult) => void }) {
  // One service sponsors every app on it, the shared wallet's too.
  const { config } = useZkAuth();
  const [hosted, setHosted] = useState<HostedWallet>();
  const [balance, setBalance] = useState<bigint>();
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = (task: () => Promise<void>) => { setBusy(true); setError(undefined); task().catch(setError).finally(() => setBusy(false)); };
  return (
    <section className="card" data-testid="shared-wallet">
      <h2><span className="step">or</span>Use the shared AlgoZKAuth Wallet</h2>
      <p className="muted">One wallet for every dApp: it opens in its own window at <code>{walletOrigin}</code>, which holds your login and keys. This page sees only the address.</p>
      {!hosted ? (
        <button data-testid="connect-wallet" disabled={busy} onClick={() => {
          setError(undefined);
          // connectWallet opens the window synchronously, so call it inside the click.
          let pending: Promise<HostedWallet>;
          try { pending = connectWallet({ walletOrigin, ...(network ? { network } : {}) }); } catch (e) { setError(e); return; }
          run(async () => { const w = await pending; setHosted(w); setBalance((await w.account()).balance.microAlgos); onLog(`Connected the shared wallet ${w.address}`); });
        }}>{busy ? "Waiting for the wallet…" : "Connect wallet"}</button>
      ) : (
        <>
          <p>Address <code data-testid="shared-address">{hosted.address}</code>{balance !== undefined && <> · {formatAlgo(balance, { trim: true })}</>}</p>
          <form className="row" onSubmit={(e) => { e.preventDefault(); run(async () => { const tx = await hosted.sendAlgo({ to: to.trim(), amount: algo("0.1") }); onLog("Sent 0.1 ALGO from the shared wallet", tx); setBalance((await hosted.account()).balance.microAlgos); }); }}>
            <input data-testid="shared-to" placeholder="Recipient address" value={to} onChange={(e) => setTo(e.target.value)} />
            <button data-testid="shared-send" type="submit" disabled={busy || !to}>{busy ? "Approve in the wallet…" : "Send 0.1 ALGO"}</button>
            <button type="button" className="secondary" onClick={() => run(async () => { await hosted.disconnect(); setHosted(undefined); })}>Disconnect</button>
          </form>
          <Recipient to={to} self={hosted.address} sponsor={config?.sponsor} onPick={setTo} testIdPrefix="shared-" />
        </>
      )}
      <ErrorLine error={error} />
    </section>
  );
}

// Where test ALGO can go: back to the service's sponsor in one click (it paid this
// wallet's deposit and fees, and any faucet ALGO). Sending to the wallet's own
// address is allowed but moves nothing anywhere, so it is pointed out.
function Recipient({ to, self, sponsor, onPick, testIdPrefix = "" }: { to: string; self: string | null | undefined; sponsor?: string; onPick: (address: string) => void; testIdPrefix?: string }) {
  const recipient = to.trim();
  return (
    <>
      {sponsor && (recipient === sponsor
        ? <p className="muted" data-testid={`${testIdPrefix}to-sponsor-chosen`}>Sending back to the service's sponsor.</p>
        : <p className="row"><button type="button" className="secondary" data-testid={`${testIdPrefix}to-sponsor`} onClick={() => onPick(sponsor)}>Send back to the sponsor</button>
            <span className="muted">the service's account that paid this wallet's deposit and fees</span></p>)}
      {self && recipient === self && <p className="warn" data-testid={`${testIdPrefix}self-send-warning`}>This is the wallet's own address: the ALGO would come straight back to it.</p>}
    </>
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
