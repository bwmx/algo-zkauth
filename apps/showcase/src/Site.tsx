import { useRef, useState, type ReactNode } from "react";
import originalData from "./data/recorded-run.json";
import stackData from "./data/service-stack-run.json";
import { OPERATION_LABELS, SIGNAL_LAYOUT, explorer, formatAlgo, localTime, shorten } from "./format";
import { ExtLink, Field, Indicator } from "./ui";
import { decodeAuthorization, fetchTransaction, fetchWalletOwner, providerOf, verifyAuthorization, type Authorization, type Check, type Deployment } from "./verify";

const REPO = "https://github.com/bwmx/algo-zkauth";
const doc = (path: string) => `${REPO}/blob/main/${path}`;
const GLYPH = `${import.meta.env.BASE_URL}glyph.svg`;
const SLACK_WALLETS = ["774125965", "774127169"];
const sentence = (title: string) => title[0].toLowerCase() + title.slice(1);
const day = (iso: string) => iso.slice(0, 10);
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (n: number) => WORDS[n] ?? String(n);
const longDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "long" });
const dateTime = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** One proof-carrying transaction that the Verify panel can re-check. */
type Target = {
  txId: string;
  option: string;
  walletId: string;
  walletAddress: string;
  round: string;
  deployment: Deployment & { sponsor: string };
  /** For an enrollment in the original run, the owner recorded by its acceptance check. */
  enrollOwner?: string;
  amount: (assetId: string, amount: string) => string;
};

// ---------------------------------------------------------------------------
// The original demo's run: two Google accounts, 2026-10-09 (benchmarks/phase6-*).

type Step = {
  account: string;
  kind: "login" | "backup" | "proof" | "action" | "fund" | "seed" | "replay" | "isolation" | "restore";
  at: string;
  seconds?: number;
  peakMiB?: number;
  usedBeforeExpiry?: boolean;
  operation?: string;
  amount?: string;
  round?: string;
  transactionIds?: string[];
  feeMicroAlgos?: string;
  confirmationMs?: number;
  afterRestore?: boolean;
  rejectedByNode?: boolean;
  otherWalletId?: string;
  walletId?: string;
};
const original = originalData as unknown as Omit<typeof originalData, "steps"> & { steps: Step[] };
const originalDeployment = { ...original.deployment, provider: "google" };
const UNIT = "ZK6";

// The proof-carrying call is the registry call for enrollment, the wallet call otherwise.
const callOf = (step: Step) => step.transactionIds![step.operation === "0" ? 1 : 0];
const walletOf = (account: string) => original.wallets.find(w => w.accountCase === account)!;

function describe(step: Step): { title: string; detail: string } {
  switch (step.kind) {
    case "login": return { title: "Signed in with Google", detail: "The browser made a fresh session key and bound it into the login's nonce, which Google signed." };
    case "backup": return { title: "Backed up the salt", detail: "Downloaded the encrypted backup, then proved it restores with its separately saved secret." };
    case "proof": return step.usedBeforeExpiry
      ? { title: `Generated the zero-knowledge proof in ${step.seconds} s`, detail: `Full Google JWT circuit on a laptop with the snarkjs prover used at the time, peaking at ${((step.peakMiB ?? 0) / 1024).toFixed(1)} GiB of memory.` }
      : { title: `A proof finished in ${step.seconds} s, but the session ran out`, detail: "Sessions last ten minutes, so the account signed in again and proved afresh." };
    case "fund": return { title: "The sponsor sent 1 test ALGO", detail: "One-time demo funding for the new wallet." };
    case "seed": return { title: `The sponsor sent 100 ${UNIT}`, detail: "One-time funding with the demo asset." };
    case "replay": return { title: "Replaying the last action was rejected", detail: "TestNet refused the resubmitted group at the wallet's nonce check. Rejected transactions never reach a block, so this comes from the local record." };
    case "isolation": return { title: `This identity's proof was rejected by wallet ${step.otherWalletId}`, detail: "The other account's wallet refused it at its owner check and stayed unchanged." };
    case "restore": return { title: "Reloaded the browser and restored the backup", detail: `Signed in again, decrypted the backup with its secret and found the original wallet ${step.walletId}.` };
    case "action": {
      const amount = step.operation === "1" ? formatAlgo(step.amount!, true) : `${step.amount} ${UNIT}`;
      const title = { "0": "Enrolled the wallet", "1": `Sent ${amount} to the sponsor`, "2": "Opted in to the demo asset", "3": `Sent ${amount} to the sponsor` }[step.operation!]!;
      const extra = step.operation === "0" ? `Paid the ${formatAlgo(original.deployment.enrollmentDeposit, true)} deposit; the registry created the wallet. ` : "";
      return { title, detail: `${extra}Round ${step.round}, confirmed in ${((step.confirmationMs ?? 0) / 1000).toFixed(1)} s; the sponsor paid the ${formatAlgo(step.feeMicroAlgos!, true)} group fee.${step.afterRestore ? " Signed by a new session key after the restore." : ""}` };
    }
  }
}

const originalActions = original.steps.filter(s => s.kind === "action");
const originalTargets: Target[] = originalActions.map(s => ({
  txId: callOf(s),
  option: `Account ${s.account}: ${sentence(describe(s).title)}${s.afterRestore ? " (after restore)" : ""}`,
  walletId: walletOf(s.account).walletId,
  walletAddress: walletOf(s.account).address,
  round: s.round!,
  deployment: originalDeployment,
  enrollOwner: walletOf(s.account).ownerCommitment,
  amount: (assetId, amount) => (assetId === "0" ? formatAlgo(amount, true) : `${amount} ${UNIT}`),
}));
const originalDefault = callOf(originalActions.find(s => s.afterRestore) ?? originalActions[0]);

function OriginalRun({ onVerify }: { onVerify: (txId: string) => void }) {
  const [account, setAccount] = useState("A");
  const wallet = walletOf(account);
  const passed = original.checks.filter(c => c.passed).length;
  return (
    <>
      <p>On {longDate(original.recordedAt)}, two genuine Google accounts each created a wallet with the original single-process demo and moved ALGO and a test asset. Account A then reloaded its browser, restored its backup and kept using the same wallet. Every transfer below is a public TestNet transaction. {passed} of {original.checks.length} acceptance checks passed.</p>
      <div className="tabs" role="tablist">
        {original.wallets.map(w => (
          <button key={w.accountCase} role="tab" type="button" aria-selected={account === w.accountCase} className={account === w.accountCase ? "tab active" : "tab"} onClick={() => setAccount(w.accountCase)}>Account {w.accountCase}</button>
        ))}
      </div>
      <p className="muted small">Wallet <ExtLink href={explorer.app(wallet.walletId)}>{wallet.walletId}</ExtLink> at <ExtLink href={explorer.account(wallet.address)}><span className="mono">{shorten(wallet.address, 6)}</span></ExtLink></p>
      <ol className="timeline">
        {original.steps.filter(s => s.account === account).map((step, i) => {
          const { title, detail } = describe(step);
          const onChain = step.kind === "action";
          return (
            <li key={i} className={onChain ? "chain" : step.kind === "replay" || step.kind === "isolation" ? "rejected" : ""}>
              <div className="dot" aria-hidden="true" />
              <div>
                <strong>{title}</strong>
                <p className="muted small">{detail}</p>
                {onChain && <ChainLinks txId={callOf(step)} onVerify={onVerify} />}
              </div>
            </li>
          );
        })}
      </ol>
      <details>
        <summary>Acceptance checks</summary>
        <ul className="checks small">
          {original.checks.map(c => <li key={c.check}><Indicator mark={c.passed ? "yes" : "warn"} />{c.check}</li>)}
          {original.deferred.map(d => <li key={d}><Indicator mark="info" />Not yet demonstrated: {d.toLowerCase()}</li>)}
        </ul>
      </details>
    </>
  );
}

// ---------------------------------------------------------------------------
// The service stack's run (benchmarks/service-stack.testnet.json).

type StackAction = {
  txId: string;
  round: number;
  roundTime: number;
  walletId: string;
  operation: "enroll" | "send ALGO" | "opt in to asset" | "send asset";
  nonce: string;
  recipient: string;
  assetId: string;
  amount: string;
  selfTransfer: boolean;
  groupFeeMicroAlgos: string;
  passed?: boolean;
};
type Rejection = {
  kind: "replay" | "isolation";
  sourceTxId: string;
  walletId: string;
  otherWalletId?: string;
  simulated: boolean;
  rejectedBy?: string;
  passed: boolean;
};
type StackApp = {
  app: string;
  deployment: { provider: string; registryId: string; keyRegistryId: string; verifier: string; audienceHash: string; enrollmentDeposit: string; sponsor: string };
  wallets: { walletId: string; address: string }[];
  actions: StackAction[];
  rejections: Rejection[];
};
const stack = stackData as unknown as Omit<typeof stackData, "apps"> & { apps: StackApp[] };
const APP_LABELS: Record<string, string> = { demo: "Demo dApp", example: "Example dApp", wallet: "AlgoZKAuth Wallet (hosted)", "demo-slack": "Demo dApp with Slack" };
const APP_NOTES: Record<string, string> = {
  demo: "Embedded integration: the page holds the session and each user gets a wallet for this app.",
  example: "A second app with its own wallet registry, so the same login gets a separate wallet here.",
  wallet: "The hosted wallet that dApps connect to: one wallet per user across every connecting dApp.",
  "demo-slack": "The demo dApp signing in with Slack, on Slack's own circuit and deployment.",
};
const appLabel = (app: string) => APP_LABELS[app] ?? `App “${app}”`;
const stackDeployment = (app: StackApp) => ({ ...app.deployment, genesisHash: stack.genesisHash });
const stackAmount = (assetId: string, amount: string) => (assetId === "0" ? formatAlgo(amount, true) : `${amount} base units of asset ${assetId}`);

function describeStack(action: StackAction, app: StackApp): { title: string; detail: string } {
  const to = action.selfTransfer ? "to the wallet itself" : action.recipient === app.deployment.sponsor ? "to the sponsor" : `to ${shorten(action.recipient, 6)}`;
  const title = {
    enroll: "Enrolled the wallet",
    "send ALGO": `Sent ${stackAmount("0", action.amount)} ${to}`,
    "opt in to asset": `Opted in to asset ${action.assetId}`,
    "send asset": `Sent ${stackAmount(action.assetId, action.amount)} ${to}`,
  }[action.operation] ?? action.operation;
  const extra = action.operation === "enroll" ? `Paid the ${formatAlgo(app.deployment.enrollmentDeposit, true)} deposit; the registry created the wallet. ` : "";
  return { title, detail: `${extra}Round ${action.round}, ${dateTime(action.roundTime)}, nonce ${action.nonce}; the sponsor paid the ${formatAlgo(action.groupFeeMicroAlgos, true)} group fee.` };
}

function describeRejection(r: Rejection): { title: string; detail: string } {
  const reason = r.rejectedBy ? ` with “${r.rejectedBy}”` : "";
  if (!r.passed) return r.kind === "replay"
    ? { title: "A replay of a confirmed action was not rejected as expected", detail: "The checker expected the wallet's nonce check to reject it." }
    : { title: `Wallet ${r.otherWalletId ?? "of another identity"} did not reject this wallet's proof as expected`, detail: "The checker expected that wallet's owner check to reject it." };
  return r.kind === "replay"
    ? { title: "Replaying a confirmed action was rejected", detail: `The same signed action, resubmitted, was rejected at the wallet's nonce check${reason}.` }
    : { title: `This wallet's proof was rejected by wallet ${r.otherWalletId ?? "of another identity"}`, detail: `Aimed at the other wallet, it was rejected at that wallet's owner check${reason}.` };
}

const stackTargets: Target[] = stack.apps.flatMap(app => app.actions.map(a => ({
  txId: a.txId,
  option: `${appLabel(app.app)}, wallet ${a.walletId}: ${sentence(describeStack(a, app).title)}`,
  walletId: a.walletId,
  walletAddress: app.wallets.find(w => w.walletId === a.walletId)?.address ?? "",
  round: String(a.round),
  deployment: stackDeployment(app),
  amount: stackAmount,
})));
const stackActions = stack.apps.flatMap(a => a.actions);
const stackDefault = (stackActions.find(a => a.operation !== "enroll") ?? stackActions[0])?.txId;

function StackRun({ onVerify }: { onVerify: (txId: string) => void }) {
  const passed = stack.checks.filter(c => c.passed).length;
  const actions = stack.apps.reduce((n, a) => n + a.actions.length, 0);
  const wallets = stack.apps.reduce((n, a) => n + a.wallets.length, 0);
  // Only providers whose apps enrolled a wallet in this run.
  const providers = [...new Set(stack.apps.filter(a => a.wallets.length > 0).map(a => providerOf(a.deployment.provider).label))].join(" and ") || "provider";
  const simulated = stack.apps.some(a => a.rejections.length > 0);
  return (
    <>
      <p>On {longDate(stack.recordedAt)}, the service stack ran on TestNet from <ExtLink href={doc("compose.testnet.yaml")}><code>compose.testnet.yaml</code></ExtLink>: a genuine {providers} sign-in through <code>@algozkauth/sdk</code>, proofs from the prover service in Docker, and {count(stack.apps.length)} apps, each with its own wallet registry. The read-only checker, <ExtLink href={doc("evidence/check-service-stack.mjs")}><code>check-service-stack.mjs</code></ExtLink>, re-checked {wallets === 1 ? "the wallet" : `all ${count(wallets)} wallets`} and {actions === 1 ? "the action" : `all ${count(actions)} actions`} below against public chain data: {passed} of {stack.checks.length} checks passed. The backend sign-in happens off-chain, so it is not in this record.</p>
      {passed < stack.checks.length && <p className="callout warn small">Not every check passed in this record; the failed ones are marked under “Acceptance checks” below.</p>}
      {simulated && <p className="small"><Indicator mark="info" /> Rejected items marked <span className="simulated">simulated</span> were simulated against TestNet from public data; they were not submitted.</p>}
      {stack.apps.map(app => (
        <div className="app-block" key={app.app}>
          <h3>{appLabel(app.app)}</h3>
          <p className="muted small">{APP_NOTES[app.app] ? `${APP_NOTES[app.app]} ` : ""}Sign-in with {providerOf(app.deployment.provider).label}; wallet registry <ExtLink href={explorer.app(app.deployment.registryId)}>{app.deployment.registryId}</ExtLink>, key registry <ExtLink href={explorer.app(app.deployment.keyRegistryId)}>{app.deployment.keyRegistryId}</ExtLink>.</p>
          {app.wallets.length === 0 && <p className="small">No wallets were enrolled in this app.</p>}
          {app.wallets.map(wallet => {
            const items = app.actions.filter(a => a.walletId === wallet.walletId);
            const rejections = app.rejections.filter(r => r.walletId === wallet.walletId);
            return (
              <div className="wallet-block" key={wallet.walletId}>
                <p className="small">Wallet <ExtLink href={explorer.app(wallet.walletId)}>{wallet.walletId}</ExtLink> at <ExtLink href={explorer.account(wallet.address)}><span className="mono">{shorten(wallet.address, 6)}</span></ExtLink></p>
                <ol className="timeline">
                  {items.map(action => {
                    const { title, detail } = describeStack(action, app);
                    const flagged = action.passed === false;
                    return (
                      <TimelineItem key={action.txId} className={flagged ? "flagged" : "chain"} title={title} detail={detail}>
                        {flagged && <p className="small"><Indicator mark="warn" /> The checker flagged this action.</p>}
                        <ChainLinks txId={action.txId} onVerify={onVerify} />
                      </TimelineItem>
                    );
                  })}
                  {rejections.map((r, i) => {
                    const { title, detail } = describeRejection(r);
                    return (
                      <TimelineItem key={`r${i}`} className={r.passed ? "rejected" : "flagged"} title={<>{title}{r.simulated && <span className="simulated">simulated</span>}</>} detail={detail}>
                        {r.simulated && <p className="muted small">Simulated against TestNet from public data, not submitted.</p>}
                        <p className="small">Built from <ExtLink href={explorer.tx(r.sourceTxId)}><span className="mono">{shorten(r.sourceTxId, 6)}</span></ExtLink></p>
                      </TimelineItem>
                    );
                  })}
                </ol>
                {items.length === 0 && rejections.length === 0 && <p className="muted small">No actions recorded for this wallet.</p>}
              </div>
            );
          })}
        </div>
      ))}
      <details>
        <summary>Acceptance checks</summary>
        <ul className="checks small">
          {stack.checks.map(c => <li key={c.check}><Indicator mark={c.passed ? "yes" : "warn"} />{c.check}</li>)}
        </ul>
      </details>
    </>
  );
}

// ---------------------------------------------------------------------------

function TimelineItem({ className, title, detail, children }: { className: string; title: ReactNode; detail: string; children?: ReactNode }) {
  return (
    <li className={className}>
      <div className="dot" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p className="muted small">{detail}</p>
        {children}
      </div>
    </li>
  );
}

function ChainLinks({ txId, onVerify }: { txId: string; onVerify: (txId: string) => void }) {
  return (
    <div className="actions compact">
      <ExtLink href={explorer.tx(txId)}>View on explorer</ExtLink>
      <button type="button" className="secondary small-button" onClick={() => onVerify(txId)}>Verify in this browser</button>
    </div>
  );
}

function Hero() {
  return (
    <section className="hero">
      <p className="eyebrow"><img src={GLYPH} alt="" width="22" height="22" />AlgoZKAuth · proof of concept</p>
      <h1>Sign in with Google or Slack. Control an Algorand wallet.</h1>
      <p className="lede">No seed phrase. A zero-knowledge proof convinces Algorand that Google or Slack signed your login, without putting your account on-chain. Your browser holds a short-lived key that signs each transfer.</p>
      <div className="actions">
        <a className="button" href="#verify">Verify a real transaction</a>
        <a className="button secondary" href="#run">Run it yourself</a>
        <a className="button secondary" href="#build">Build on it</a>
        <ExtLink href={REPO}>Source on GitHub</ExtLink>
      </div>
      <p className="muted small">This page replays two recorded runs on Algorand TestNet: the original demo with two genuine Google accounts ({day(original.recordedAt)}) and the service stack through the SDK ({day(stack.recordedAt)}), with Google and Slack sign-in. Slack also has <a href="#slack">its own TestNet evidence</a> from the original demo.</p>
      <p className="muted small">Algorand TestNet only · development proving setup · not audited</p>
    </section>
  );
}

const HOW = [
  ["Sign in", "Your browser creates a temporary signing key and puts its fingerprint in the login request. The signed login from Google or Slack now vouches for that key for up to ten minutes."],
  ["Keep a salt", "A random secret salt, combined with your Google or Slack ID, decides which wallet is yours. Only a hash goes on-chain, so nobody can link the wallet to your account. You keep an encrypted backup of the salt."],
  ["Prove", "A zero-knowledge proof shows that the provider signed a login for that identity and key, without revealing the login token or who you are. Each provider has its own circuit and deployment. With the native rapidsnark prover a proof takes about ten seconds."],
  ["Sign actions", "The temporary key signs each transfer's exact recipient, amount and nonce. Algorand checks the proof and the signature together before the wallet moves funds."],
];

function HowItWorks() {
  return (
    <section className="card">
      <h2>How it works</h2>
      <ol className="how">
        {HOW.map(([title, text], i) => <li key={title}><span className="step-num">{i + 1}</span><div><h3>{title}</h3><p>{text}</p></div></li>)}
      </ol>
      <p className="small" id="slack"><strong>Slack:</strong> on 2026-10-12 two genuine Slack identities enrolled TestNet wallets {SLACK_WALLETS.map((id, i) => <span key={id}>{i > 0 && " and "}<ExtLink href={explorer.app(id)}>{id}</ExtLink></span>)}, transferred ALGO and a test asset, and were rejected at each other's wallets. Slack backup restore and session renewal have not been run yet. <ExtLink href={doc("docs/slack-oidc.md")}>Slack protocol and evidence</ExtLink></p>
      <p className="small muted">The recorded runs below use Google. The original demo's proofs used the snarkjs prover of the time, about two minutes each; the native prover has since proved genuine tokens in 8.5–10.4 s for Google and 9.7 s for Slack.</p>
    </section>
  );
}

type RunId = "original" | "stack";
const RUNS: { id: RunId; name: string; summary: string }[] = [
  { id: "original", name: "Original demo", summary: `${day(original.recordedAt)} · two Google accounts` },
  { id: "stack", name: "Service stack", summary: `${day(stack.recordedAt)} · SDK, hosted wallet and backend` },
];

function RecordedRuns({ runId, setRunId, onVerify }: { runId: RunId; setRunId: (id: RunId) => void; onVerify: (txId: string) => void }) {
  return (
    <section className="card" id="run-record">
      <h2>Recorded runs on Algorand TestNet</h2>
      <div className="run-switch" role="group" aria-label="Recorded run">
        {RUNS.map(r => (
          <button key={r.id} type="button" aria-pressed={runId === r.id} onClick={() => setRunId(r.id)}><strong>{r.name}</strong> <span>· {r.summary}</span></button>
        ))}
      </div>
      {runId === "original" ? <OriginalRun onVerify={onVerify} /> : <StackRun onVerify={onVerify} />}
    </section>
  );
}

type Result = { state: "idle" } | { state: "running" } | { state: "done"; auth: Authorization; checks: Check[] } | { state: "error"; message: string };

function Verify({ targets, target, setTxId, result, onRun }: { targets: Target[]; target: Target; setTxId: (id: string) => void; result: Result; onRun: () => void }) {
  return (
    <section className="card" id="verify">
      <h2>Verify it yourself</h2>
      <p>Pick a recorded transaction. This page fetches it from a public TestNet indexer and re-checks it here, in your browser: the zero-knowledge proof against the provider's published verification key, the network and app bindings, the wallet owner, and the session key's signature over the exact action. No server of ours is involved.</p>
      <div className="verify-controls">
        <label>Transaction
          <select value={target.txId} onChange={e => setTxId(e.target.value)}>
            {targets.map(t => <option key={t.txId} value={t.txId}>{t.option}</option>)}
          </select>
        </label>
        <button type="button" onClick={onRun} disabled={result.state === "running"}>{result.state === "running" ? "Verifying…" : "Verify in this browser"}</button>
      </div>
      <p className="muted small">Wallet {target.walletId} · round {target.round} · <ExtLink href={explorer.tx(target.txId)}><span className="mono">{shorten(target.txId, 6)}</span></ExtLink></p>
      {result.state === "error" && <p className="callout warn">{result.message}</p>}
      {result.state === "done" && <VerifyResult target={target} auth={result.auth} checks={result.checks} />}
    </section>
  );
}

function VerifyResult({ target, auth, checks }: { target: Target; auth: Authorization; checks: Check[] }) {
  const all = checks.every(c => c.ok);
  const plan = auth.plan;
  const amount = target.amount(plan.assetId, plan.amount);
  const recipientNote = plan.recipient === target.deployment.sponsor ? " (sponsor)" : plan.recipient === target.walletAddress ? " (the wallet itself)" : "";
  return (
    <div className="verify-result">
      <p className={`status ${all ? "success" : "error"}`}>{all ? `All ${checks.length} checks passed in your browser.` : `${checks.filter(c => !c.ok).length} of ${checks.length} checks failed.`}</p>
      <ul className="checks">
        {checks.map(c => <li key={c.label}><Indicator mark={c.ok ? "yes" : "warn"} /><span><strong>{c.label}</strong><br /><span className="muted small">{c.detail}</span></span></li>)}
      </ul>
      <div className="inspector">
        <article>
          <h3>The signed action</h3>
          <dl className="fields">
            <Field label="Operation">{OPERATION_LABELS[plan.operation]}</Field>
            <Field label="Amount">{auth.method === "enroll" ? `${amount} deposit` : amount}</Field>
            <Field label="Recipient"><span className="mono">{shorten(plan.recipient, 6)}</span>{recipientNote}</Field>
            <Field label="Wallet / nonce">{plan.walletId === "0" ? "new" : plan.walletId} / {plan.nonce}</Field>
            <Field label="Session expiry">{localTime(Number(plan.sessionExpiresAt))}</Field>
          </dl>
        </article>
        <article>
          <h3>Public signals of the proof</h3>
          <div className="table-scroll">
            <table>
              <tbody>
                {SIGNAL_LAYOUT.map(row => {
                  const value = auth.signals[row.field];
                  return <tr key={row.indexes}><td>{row.indexes}</td><td>{row.meaning}</td><td className="mono">{typeof value === "number" ? localTime(value) : shorten(value, 6)}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
        </article>
      </div>
    </div>
  );
}

function Trust() {
  return (
    <section className="card">
      <h2>What this shows, and what it doesn't</h2>
      <div className="grid-2">
        <div>
          <h3>Shown on TestNet</h3>
          <ul className="checks small">
            <li><Indicator mark="yes" />Google and Slack login wallets work with Algorand's existing LogicSig and smart-contract features; no protocol change is needed.</li>
            <li><Indicator mark="yes" />Each transfer is bound to its exact recipient, amount, network and nonce; replays and other identities' proofs were rejected, for both providers.</li>
            <li><Indicator mark="yes" />After a browser reload, the encrypted backup recovered the original Google wallet and a fresh login kept using it. On 2026-10-20 Safari restored a Chrome-made wallet from its backup file and secret and authorized transfers (same Mac).</li>
            <li><Indicator mark="yes" />The native rapidsnark prover proved genuine tokens in about ten seconds: 8.5–10.4 s for Google, 9.7 s for Slack.</li>
            <li><Indicator mark="yes" />New key registries delay each key approval or renewal by 24 hours, during which a separate guardian can revoke it or pause the registry. Tested on LocalNet, in disposable TestNet policy checks and in a single-identity TestNet run; the recorded two-account runs predate it.</li>
          </ul>
        </div>
        <div>
          <h3>Trust and limits</h3>
          <ul className="checks small">
            <li><Indicator mark="warn" />One administrator approves the providers' signing keys and is still trusted: with a user's salt, a malicious administrator could approve its own key and take over that wallet. On new key registries the 24-hour delay gives a guardian time to veto.</li>
            <li><Indicator mark="warn" />The prover sees the login token and salt. Proving in the browser avoids that, at about two minutes and 3–4 GB of memory.</li>
            <li><Indicator mark="warn" />Losing the backup loses the wallet; a Google or Slack login alone cannot recover it.</li>
            <li><Indicator mark="warn" />Not yet shown: Slack restore and renewal, a second physical device, mobile.</li>
            <li><Indicator mark="warn" />Development proving setup, unaudited circuits and contracts. TestNet only.</li>
          </ul>
        </div>
      </div>
      <p className="small">How it compares: <ExtLink href={doc("docs/sui-comparison.md")}>Sui zkLogin</ExtLink> · <ExtLink href={doc("docs/aptos-comparison.md")}>Aptos Keyless and salt options</ExtLink> · <ExtLink href={doc("PLAN.md")}>open work</ExtLink></p>
    </section>
  );
}

function RunIt() {
  return (
    <section className="card" id="run">
      <h2>Run it yourself</h2>
      <div className="run-option">
        <h3>Try it locally: one command, no accounts</h3>
        <pre className="code"><code>{`git clone ${REPO}.git\ncd algo-zkauth\ndocker compose --profile local up --build`}</code></pre>
        <p className="small">This runs the whole service stack on a private LocalNet with a development login issuer: no Google client and no TestNet ALGO. At sign-in, type any subject. You need Docker with at least 6 GB of memory; the first run downloads the 1.4 GB proving key. Then open:</p>
        <ul className="small">
          <li><code>http://localhost:8765</code>, the demo dApp: sign in, back up, enroll, take 5 test ALGO from the faucet, send.</li>
          <li><code>http://localhost:8770</code>, the hosted AlgoZKAuth Wallet that dApps connect to.</li>
          <li><code>http://localhost:8775</code>, the example dApp, a second app with its own wallets.</li>
        </ul>
        <p className="small"><ExtLink href={`${REPO}#try-it`}>Full instructions</ExtLink></p>
      </div>
      <div className="run-option">
        <h3>On TestNet with real Google sign-in</h3>
        <pre className="code"><code>{`git clone ${REPO}.git\ncd algo-zkauth\nnpm run stack:testnet:up`}</code></pre>
        <p className="small">The same service stack against public TestNet nodes, from <code>compose.testnet.yaml</code>. You deploy your own contracts and run your own prover, fee sponsor and key administrator, so nobody else sees your login or salt.</p>
        <ul className="small">
          <li>Docker with at least 6 GB of memory.</li>
          <li><code>GOOGLE_CLIENT_ID</code> in <code>.env</code>: a Google OAuth web client whose authorized JavaScript origins include <code>http://localhost:8765</code>, <code>:8770</code> and <code>:8775</code>.</li>
          <li>Test ALGO from the <ExtLink href="https://dispenser.testnet.aws.algodev.network/">TestNet dispenser</ExtLink>: on the first run the stack creates its admin and sponsor accounts and waits until you fund them.</li>
        </ul>
        <p className="small">It downloads the 1.4 GB proving key and verifies its pinned hash, deploys a Google key registry and a wallet registry per app, and serves the demo dApp, hosted wallet and example dApp on the same ports as the local stack, so stop that first. TestNet has no faucet: send your wallet some ALGO before transferring. <ExtLink href={`${REPO}#run-the-service-stack-on-testnet`}>Full instructions</ExtLink></p>
      </div>
    </section>
  );
}

const SDK_SNIPPET = `import { createZkAuth, algo } from "@algozkauth/sdk";

const zk = createZkAuth({ service: "https://auth.example.com", app: "my-dapp" });
const session = await zk.signIn();
const { file, secret } = await session.backup.create();  // once per user: save both
const wallet = await session.wallet();
await wallet.sendAlgo({ to: "ADDR…", amount: algo("0.5") });`;

function BuildOnIt({ showStackRun }: { showStackRun: () => void }) {
  const passed = stack.checks.filter(c => c.passed).length;
  return (
    <section className="card" id="build">
      <h2>Build on it</h2>
      <p>The same wallets are packaged as services with a browser SDK, <ExtLink href={doc("packages/sdk/README.md")}><code>@algozkauth/sdk</code></ExtLink>. A dApp integrates in one of two ways:</p>
      <ul className="small">
        <li><strong>Embedded</strong>, <code>createZkAuth</code>: your page holds the session, and each user gets a wallet for your dApp.</li>
        <li><strong>Hosted</strong>, <code>connectWallet</code>: the AlgoZKAuth Wallet holds the session in its own window, and each user has one wallet across every dApp that connects.</li>
      </ul>
      <pre className="code"><code>{SDK_SNIPPET}</code></pre>
      <p className="small">Your backend can sign users in with <ExtLink href={doc("packages/verify/README.md")}><code>@algozkauth/verify</code></ExtLink>. It checks the session key's signature and the zero-knowledge proof against the chain, so the backend trusts no AlgoZKAuth server.</p>
      <p className="small muted">The service stack has run on TestNet with genuine Google and Slack logins through the SDK (<a href="#run-record" onClick={showStackRun}>the recorded run above</a>, {passed}/{stack.checks.length} read-only checks); its automated end-to-end tests run on LocalNet. <ExtLink href={doc("docs/service-architecture.md")}>Service architecture</ExtLink></p>
    </section>
  );
}

const TARGETS: Record<RunId, Target[]> = { original: originalTargets, stack: stackTargets };
const DEFAULTS: Record<RunId, string> = { original: originalDefault, stack: stackDefault ?? originalDefault };
const targetOf = (txId: string) => [...originalTargets, ...stackTargets].find(t => t.txId === txId)!;

export function Site() {
  const [runId, setRunIdState] = useState<RunId>("original");
  const [txId, setTxId] = useState(DEFAULTS.original);
  const [result, setResult] = useState<Result>({ state: "idle" });
  const running = useRef<string | undefined>(undefined);
  const verify = async (id: string) => {
    running.current = id;
    setResult({ state: "running" });
    try {
      const target = targetOf(id);
      const auth = decodeAuthorization(await fetchTransaction(id), target.deployment);
      // An enrollment creates the wallet; afterwards its owner is on-chain.
      const owner = auth.method === "enroll" ? (target.enrollOwner ?? await fetchWalletOwner(target.walletId)) : await fetchWalletOwner(auth.plan.walletId);
      const checks = await verifyAuthorization(auth, target.deployment, owner);
      if (running.current === id) setResult({ state: "done", auth, checks });
    } catch (error) {
      if (running.current === id) setResult({ state: "error", message: error instanceof Error ? error.message : "Verification failed" });
    }
  };
  const choose = (id: string) => { running.current = undefined; setTxId(id); setResult({ state: "idle" }); };
  const setRunId = (id: RunId) => { if (id !== runId) { setRunIdState(id); choose(DEFAULTS[id]); } };
  // A run without recorded actions leaves the panel on the original run's.
  const targets = TARGETS[runId].length ? TARGETS[runId] : originalTargets;
  return (
    <div className="page site">
      <Hero />
      <HowItWorks />
      <RecordedRuns runId={runId} setRunId={setRunId} onVerify={id => { choose(id); document.getElementById("verify")?.scrollIntoView({ behavior: "smooth" }); verify(id); }} />
      <Verify targets={targets} target={targetOf(txId)} setTxId={choose} result={result} onRun={() => verify(txId)} />
      <Trust />
      <RunIt />
      <BuildOnIt showStackRun={() => setRunId("stack")} />
      <footer className="muted small">
        <p>AlgoZKAuth is an unaudited proof of concept on Algorand TestNet. The original demo's Google deployment: registry <ExtLink href={explorer.app(original.deployment.registryId)}>{original.deployment.registryId}</ExtLink>, key policy <ExtLink href={explorer.app(original.deployment.keyRegistryId)}>{original.deployment.keyRegistryId}</ExtLink>; the service stack's apps list their own above. <ExtLink href={REPO}>Source and evidence on GitHub</ExtLink>.</p>
      </footer>
    </div>
  );
}
