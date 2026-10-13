import type { DemoState } from "../controller";
import type { Gates } from "../gates";
import { SESSION_SECONDS, explorer, formatAlgo, shorten, spendable } from "../protocol";
import { Copy, ExtLink, Indicator, mmss, type Mark } from "./ui";

type Props = { s: DemoState; g: Gates };

export function SessionCard({ s, g }: Props) {
  const total = SESSION_SECONDS;
  const fraction = s.session ? Math.min(1, g.remaining / total) : 0;
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const tone = !g.active ? "expired" : g.remaining < 120 ? "low" : "ok";
  return (
    <section className="card side" aria-label="Session">
      <h2>Session</h2>
      <div className="session">
        <svg viewBox="0 0 80 80" className={`ring ${tone}`} role="img" aria-label={g.active ? `${g.remaining} seconds left` : "No active session"}>
          <circle cx="40" cy="40" r={radius} className="track" />
          <circle cx="40" cy="40" r={radius} className="value" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - fraction)} transform="rotate(-90 40 40)" />
          <text x="40" y="45" textAnchor="middle">{g.active ? mmss(g.remaining) : "—"}</text>
        </svg>
        <div>
          <p><strong>{!s.identity ? "Not signed in" : g.active ? `Account ${s.accountCase} · active` : "Expired"}</strong></p>
          <p className="muted">
            {!s.identity ? "A login binds a fresh browser key for at most ten minutes."
              : !g.active ? "Renew the login and generate a fresh proof. The salt and wallet stay the same."
              : s.proof.ready ? `Proof valid for ${mmss(g.remaining)} more.` : "No proof for this session yet."}
          </p>
        </div>
      </div>
      {g.proofWouldBeTight && <p className="callout warn">Too little time for a ~{Math.round(g.expectedProofMs / 1000)} s proof. Renew first.</p>}
      {s.session && (
        <ul className="checks small">
          <li><Indicator mark="yes" />Ed25519 key is nonextractable and stays in this tab</li>
          <li><Indicator mark="yes" />Nonce recomputed here: TestNet, this key, expiry</li>
          {s.token?.nonce && <li><Indicator mark={s.token.nonce === s.session.nonce ? "yes" : "warn"} />{s.label} signed this nonce</li>}
        </ul>
      )}
    </section>
  );
}

export function WalletCard({ s }: Props) {
  const config = s.config;
  const w = s.wallet;
  const asset = w?.assets.find(a => a.id === config?.demoAssetId);
  return (
    <section className="card side" aria-label="Wallet">
      <h2>Wallet</h2>
      {!w?.enrolled ? (
        <p className="muted">
          {s.hasSalt ? "No wallet is enrolled for this commitment yet." : "Your wallet appears here once a salt is selected."}
          {config && ` Enrollment deposit ${formatAlgo(config.enrollmentDeposit, true)}; each action's ${formatAlgo(config.groupFeeMicroAlgos, true)} group fee is paid by the local sponsor.`}
        </p>
      ) : (
        <>
          <div className="balance">
            <span className="amount">{formatAlgo(w.balanceMicroAlgos, true)}</span>
            <span className="muted">{formatAlgo(spendable(w.balanceMicroAlgos, w.minBalanceMicroAlgos), true)} spendable · {formatAlgo(w.minBalanceMicroAlgos, true)} minimum</span>
          </div>
          <dl className="fields">
            <div className="field"><dt>Demo ASA</dt><dd>{asset ? `${asset.amount} ${s.assetUnit ?? "units"}` : "Not opted in"}</dd></div>
            <div className="field"><dt>Wallet app</dt><dd><ExtLink href={explorer.app(w.walletId)}>{w.walletId}</ExtLink></dd></div>
            <div className="field"><dt>Address</dt><dd className="mono"><ExtLink href={explorer.account(w.address!)}>{shorten(w.address!, 6)}</ExtLink> <Copy value={w.address!} /></dd></div>
            <div className="field"><dt>Replay nonce</dt><dd>{w.nonce}</dd></div>
          </dl>
        </>
      )}
      {config && (
        <p className="muted small">
          Registry <ExtLink href={explorer.app(config.registryId)}>{config.registryId}</ExtLink> · key policy <ExtLink href={explorer.app(config.keyRegistryId)}>{config.keyRegistryId}</ExtLink> · ASA <ExtLink href={explorer.asset(config.demoAssetId)}>{config.demoAssetId}</ExtLink>
        </p>
      )}
    </section>
  );
}

export function SaltLocation({ s }: Props) {
  const b = s.backup;
  const enrolled = !!s.wallet?.enrolled;
  const rows: [Mark, string, string][] = [
    [s.hasSalt ? "yes" : "no", "In this tab's memory", s.hasSalt ? "Cleared when the tab closes." : "No salt selected yet."],
    [b.downloadedStage ? "yes" : s.hasSalt ? "warn" : "no", "Encrypted file outside the browser", b.downloadedStage ? "AES-256-GCM package; keep copies somewhere durable." : "Download the backup and keep it outside this browser."],
    [b.verified ? "yes" : s.hasSalt ? "warn" : "no", "Backup verified by restore", b.verified ? "The exported file decrypted with the saved secret." : "Import and restore it before enrolling."],
    ...(enrolled ? [[b.downloadedStage === "wallet" ? "yes" : "warn", "Wallet-bound backup saved", b.downloadedStage === "wallet" ? "Includes this wallet's ID and address." : "Download the updated backup after enrollment."] as [Mark, string, string]] : []),
    [b.passkey ? "yes" : "info", "Passkey slot (optional)", b.passkey ? "PRF-wrapped key added to the package." : "The recovery secret is the fallback."],
    [s.saltSentToServer ? "info" : "no", "Localhost demo server", s.saltSentToServer ? "Received the salt to compute the commitment and build the proof witness; held until the session expires." : "Not shared yet."],
    ["info", "On-chain", "Only the SHA-256 commitment. The salt never appears in a transaction."],
  ];
  return (
    <section className="card side" aria-label="Where your salt lives">
      <h2>Where your salt lives</h2>
      <ul className="checks salt">
        {rows.map(([mark, title, detail]) => <li key={title}><Indicator mark={mark} /><span><strong>{title}</strong><br /><span className="muted">{detail}</span></span></li>)}
      </ul>
      <p className="muted small">Losing every backup copy, or both the secret and usable passkeys, loses this wallet. {s.label} login alone cannot recover it. The <strong>Salt strategies</strong> tab compares this with Aptos Keyless and Sui zkLogin.</p>
    </section>
  );
}
