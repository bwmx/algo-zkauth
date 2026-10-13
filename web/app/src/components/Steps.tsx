import { useEffect, useState } from "react";
import { isValidAddress } from "algosdk";
import type { DemoController, DemoState, ProofState } from "../controller";
import { nextStep, type Gates, type Step } from "../gates";
import { DEMO_RUN_SECONDS, OPERATION_LABELS, PROVIDER_LABELS, formatAlgo, localTime, parseAlgo, parseUnits, shorten } from "../protocol";
import { Indicator, mmss } from "./ui";

type Props = { s: DemoState; g: Gates; c: DemoController; now: number };

export function Stepper({ steps }: { steps: Step[] }) {
  return (
    <ol className="stepper" aria-label="Progress">
      {steps.map((step, i) => (
        <li key={step.id} className={step.state}>
          <a href={`#${step.id}`}><span className="bubble">{step.state === "done" ? "✓" : step.state === "attention" ? "!" : i + 1}</span>{step.title}</a>
        </li>
      ))}
    </ol>
  );
}

export function LoginStep({ s, g, c }: Props) {
  return (
    <section id="step-login" className="card">
      <h2><span className="step-num">1</span>Sign in or renew your session</h2>
      {s.provider === "slack"
        ? s.loginReady && <div className="actions"><button onClick={c.signInWithSlack} disabled={s.slackWaiting}>{s.slackWaiting ? "Waiting for Slack…" : "Sign in with Slack"}</button></div>
        : <div ref={c.setLoginContainer} className="google-button" hidden={!s.loginReady} />}
      <p>
        {s.identity
          ? `Account ${s.accountCase} verified. The session signing key stays in this tab.`
          : s.loginReady ? `Choose the ${s.label} account for this tab. Login expires in ten minutes.` : "Preparing a fresh nonce-bound login…"}
      </p>
      <div className="actions">
        <button className="secondary" disabled={!g.renew} onClick={c.renew}>Renew login session</button>
      </div>
      <p className="muted">For Account B, open this page in a separate tab and choose the second account. Renewal in an existing tab must use its original account.</p>
      {s.provider === "slack" && <p className="muted">Slack opens a login window. The localhost server exchanges its code for the ID token, so this tab never receives the token.</p>}
      {s.config?.providers.filter(p => p !== s.provider).map(p => (
        <p key={p} className="muted">Each login provider has its own wallets. <a href={`/demo/?provider=${p}`} target="_blank" rel="noreferrer">Use {PROVIDER_LABELS[p]} in a new tab</a></p>
      ))}
    </section>
  );
}

export function BackupStep({ s, g, c }: Props) {
  const [showSecret, setShowSecret] = useState(false);
  const [restoreSecret, setRestoreSecret] = useState("");
  const b = s.backup;
  return (
    <section id="step-backup" className="card">
      <h2><span className="step-num">2</span>Create or restore your recovery backup</h2>
      <p>Your wallet is found by a commitment to your {s.label} identity and a random salt. {s.label} login alone cannot recover that salt. Save the encrypted file outside this browser and keep its generated secret separately. Import and successfully restore that exported file before enrolling.</p>
      <ol className="compact">
        <li>Create a backup and save its recovery secret separately.</li>
        <li>Download the encrypted backup and tick the separate-storage checkbox.</li>
        <li>Select that downloaded file below, enter the saved secret, and click <strong>Restore using secret</strong>.</li>
      </ol>
      <div className="actions">
        <button disabled={!g.create} onClick={c.createBackup}>Create new salt and backup</button>
      </div>
      {b.packageText && (
        <div className="subpanel">
          <label htmlFor="new-secret">Recovery secret — keep private and separate from the backup</label>
          <div className="input-row">
            <input id="new-secret" type={showSecret ? "text" : "password"} readOnly value={b.secret ?? ""} autoComplete="off" />
            <button className="secondary" type="button" onClick={() => setShowSecret(v => !v)}>{showSecret ? "Hide" : "Show"}</button>
            <button className="secondary" type="button" disabled={!b.secret || g.busy} onClick={c.copySecret}>Copy secret</button>
          </div>
          <div className="actions">
            <button disabled={!g.download} onClick={c.download}>Download {b.stage === "wallet" ? "wallet-bound" : "encrypted"} backup</button>
            <button className="secondary" disabled={!g.addPasskey} onClick={c.addPasskey}>Add optional passkey</button>
          </div>
          <label className="check">
            <input type="checkbox" checked={b.secretSaved} onChange={e => c.setSecretSaved(e.target.checked)} />
            I saved the secret separately and can retrieve the encrypted file after browser/device loss.
          </label>
          <p className={b.verified ? "ok-text" : "muted"}>{b.note}</p>
        </div>
      )}
      <div className="grid-2">
        <label>Import encrypted backup<input type="file" accept=".json,application/json" aria-label="Import encrypted backup" onChange={e => c.importFile(e.target.files?.[0])} /></label>
        <label>Saved recovery secret<input type="password" aria-label="Saved recovery secret" value={restoreSecret} autoComplete="off" spellCheck={false} onChange={e => setRestoreSecret(e.target.value)} /></label>
      </div>
      <div className="actions">
        <button disabled={!g.restoreSecret} onClick={() => c.restore(false, restoreSecret).then(() => { if (c.state.backup.verified) setRestoreSecret(""); })}>Restore using secret</button>
        <button className="secondary" disabled={!g.restorePasskey} onClick={() => c.restore(true)}>Restore using passkey</button>
      </div>
      <p className="label">Identity commitment (public)</p>
      <output className="mono">{s.commitment ?? "No salt selected."}</output>
    </section>
  );
}

const STAGES = [["queued", "Queued"], ["witness", "Witness"], ["proof", "Groth16 proof"], ["verification", "Verify"], ["ready", "Ready"]] as const;

function ProofProgress({ proof, expectedMs }: { proof: ProofState; expectedMs: number }) {
  if (proof.stage === "none") return null;
  const index = STAGES.findIndex(([id]) => id === proof.stage);
  const failed = proof.stage === "failed";
  const fraction = proof.stage === "ready" ? 1 : Math.min(proof.elapsedMs / expectedMs, 0.97);
  return (
    <div className="proof-progress" aria-label="Proof progress">
      <ol className="stages">
        {STAGES.map(([id, label], i) => (
          <li key={id} className={failed ? "failed" : i < index || proof.stage === "ready" ? "done" : i === index ? "current" : ""}>{label}</li>
        ))}
      </ol>
      <div className={`bar ${failed ? "failed" : ""}`}><span style={{ width: `${(fraction * 100).toFixed(1)}%` }} /></div>
      <p className="muted">
        {failed ? "The local proof worker failed." : proof.stage === "ready"
          ? `Finished in ${(proof.elapsedMs / 1000).toFixed(1)} s${proof.measurement?.proveMs ? ` (witness ${(proof.measurement.witnessMs! / 1000).toFixed(1)} s, Groth16 ${(proof.measurement.proveMs / 1000).toFixed(1)} s)` : ""}.`
          : `${(proof.elapsedMs / 1000).toFixed(0)} s elapsed; usually about ${Math.round(expectedMs / 1000)} s.`}
      </p>
    </div>
  );
}

export function ProofStep({ s, g, c }: Props) {
  const next = nextStep(s, g);
  return (
    <section id="step-proof" className="card">
      <h2><span className="step-num">3</span>Prove your identity and session</h2>
      <p className="next-step" role="status" aria-live="polite">
        {next.text} {next.target && <a href={`#${next.target}`}>Go there</a>}
      </p>
      <p>The full JWT proof runs on this Mac. It verifies {s.label}'s signature and binds this salt, network, expiry and browser session key. Proofs expire with the ten-minute session.</p>
      {g.proofWouldBeTight && (
        <p className="callout warn">Only {mmss(g.remaining)} left in this session. A proof takes about {Math.round(g.expectedProofMs / 1000)} s and would leave too little time to use it. Renew the session first.</p>
      )}
      <div className="actions">
        <button disabled={!g.prove} onClick={c.prove}>Generate local proof</button>
        <button className="secondary" disabled={!g.refresh} onClick={c.refresh}>Refresh wallet</button>
      </div>
      <ProofProgress proof={s.proof} expectedMs={g.expectedProofMs} />
      {s.proof.checks && (
        <ul className="checks" aria-label="Proof binding checks">
          {s.proof.checks.map(check => (
            <li key={check.label}><Indicator mark={check.ok ? "yes" : check.required ? "warn" : "info"} /><strong>{check.label}</strong> <span className="muted">{check.detail}</span></li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReviewPanel({ s, g, c, now }: Props) {
  const review = s.review!;
  const plan = review.plan;
  const left = Math.max(0, 110 - Math.floor((now * 1000 - review.preparedAt) / 1000));
  const amount = plan.assetId === "0" ? formatAlgo(plan.amount, true) : `${plan.amount} ${s.assetUnit ?? "demo ASA"} units`;
  return (
    <div className="subpanel review" role="dialog" aria-label="Review transfer">
      <h3>Review before signing</h3>
      <p>The server's plan matches your request on every field. Your session key will sign this digest:</p>
      <dl className="fields">
        <div className="field"><dt>Operation</dt><dd>{OPERATION_LABELS[plan.operation]}</dd></div>
        <div className="field"><dt>Amount</dt><dd>{amount}</dd></div>
        <div className="field"><dt>To</dt><dd className="mono">{shorten(plan.recipient, 10)}{plan.recipient === s.config?.sponsor ? " (sponsor)" : ""}</dd></div>
        <div className="field"><dt>From wallet</dt><dd>{plan.walletId}</dd></div>
        <div className="field"><dt>Wallet nonce</dt><dd>{plan.nonce}</dd></div>
        <div className="field"><dt>Valid until</dt><dd>{localTime(Number(plan.sessionExpiresAt))}</dd></div>
        <div className="field"><dt>Action digest</dt><dd className="mono">{shorten(review.digestHex, 12)}</dd></div>
      </dl>
      <div className="actions">
        <button type="button" disabled={!g.ready || left === 0} onClick={c.confirmTransfer}>Sign and submit</button>
        <button type="button" className="secondary" onClick={c.cancelTransfer}>Cancel</button>
        <span className="muted">Plan expires in {mmss(left)}</span>
      </div>
    </div>
  );
}

function TransferForm(props: Props) {
  const { s, g, c } = props;
  const [assetId, setAssetId] = useState("0");
  const [amount, setAmount] = useState("0.01");
  const [recipient, setRecipient] = useState("");
  const sponsor = s.config?.sponsor;
  useEffect(() => { if (sponsor) setRecipient(r => r || sponsor); }, [sponsor]);
  let preview = "";
  try { preview = assetId === "0" ? `= ${BigInt(parseAlgo(amount)).toLocaleString("en-US")} µALGO` : `${parseUnits(amount)} whole units`; }
  catch (error) { preview = (error as Error).message; }
  const recipientOk = isValidAddress(recipient.trim());
  return (
    <form className="subpanel" onSubmit={e => { e.preventDefault(); c.prepareTransfer({ assetId, amount, recipient }); }}>
      <h3>Custom transfer</h3>
      <label>Destination address
        <input value={recipient} spellCheck={false} autoComplete="off" aria-invalid={!recipientOk} onChange={e => setRecipient(e.target.value)} />
      </label>
      <p className={recipientOk ? "muted" : "error-text"}>{recipientOk ? (recipient.trim() === sponsor ? "The demo sponsor account." : "Valid Algorand address.") : "Enter a valid 58-character Algorand address."}</p>
      <div className="grid-2">
        <label>Asset
          <select value={assetId} onChange={e => { setAssetId(e.target.value); setAmount(e.target.value === "0" ? "0.01" : "1"); }}>
            <option value="0">ALGO</option>
            {s.config && <option value={s.config.demoAssetId}>{s.assetUnit ?? "Demo ASA"} ({s.config.demoAssetId})</option>}
          </select>
        </label>
        <label>Amount {assetId === "0" ? "in ALGO" : "in whole units"}
          <input value={amount} inputMode="decimal" autoComplete="off" onChange={e => setAmount(e.target.value)} />
        </label>
      </div>
      <p className="muted">{preview}</p>
      <div className="actions">
        <button type="submit" disabled={!g.walletActions || !!s.review}>Review transfer</button>
      </div>
      {s.review && <ReviewPanel {...props} />}
    </form>
  );
}

export function WalletStep(props: Props) {
  const { s, g, c } = props;
  return (
    <section id="step-wallet" className="card">
      <h2><span className="step-num">4</span>Enroll and transact</h2>
      {g.demoTimeShort && (
        <p className="callout warn">Only {mmss(g.remaining)} left in this session; the full demo needs about {DEMO_RUN_SECONDS} seconds. Renew the session in step 1 and generate a fresh proof first.</p>
      )}
      <p>The complete demo enrolls if needed, funds 1 test ALGO once, sends 0.01 ALGO to the sponsor, opts into the demo ASA, receives 100 units, sends 7 units back and checks that the last signed action cannot be replayed. Each action is signed in this browser. Run it once for each account.</p>
      <div className="actions">
        <button disabled={!g.runDemo} onClick={c.runDemo}>Run ALGO / ASA demo</button>
        <button className="secondary" disabled={!g.enroll} onClick={c.enroll}>Enroll wallet</button>
        <button className="secondary" disabled={!g.walletActions} onClick={c.fund}>Fund test ALGO</button>
        <button className="secondary" disabled={!g.walletActions} onClick={c.optIn}>Opt in to demo ASA</button>
        <button className="secondary" disabled={!g.walletActions} onClick={c.seed}>Receive demo ASA</button>
        <button className="secondary" disabled={!g.replay} onClick={c.replay}>Check replay rejection</button>
      </div>
      <TransferForm {...props} />
      <p className="muted">The browser checks that the server's plan matches this network, wallet, destination, asset, amount, nonce and expiry before signing. A failed transaction does not advance the wallet's nonce.</p>
    </section>
  );
}
