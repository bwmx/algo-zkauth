import { useRef, useState } from "react";
import { ExtLink, Field, Indicator } from "../components/ui";
import { OPERATION_LABELS, SIGNAL_LAYOUT, explorer, formatAlgo, localTime, shorten } from "../protocol";
import data from "./recorded-run.json";
import { decodeAuthorization, fetchTransaction, fetchWalletOwner, verifyAuthorization, type Authorization, type Check } from "./verify";

const REPO = "https://github.com/bwmx/algo-zkauth";
const doc = (path: string) => `${REPO}/blob/main/${path}`;

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
const run = data as unknown as Omit<typeof data, "steps"> & { steps: Step[] };
const { deployment } = run;
const UNIT = "ZK6";

// The proof-carrying call is the registry call for enrollment, the wallet call otherwise.
const callOf = (step: Step) => step.transactionIds![step.operation === "0" ? 1 : 0];
const walletOf = (account: string) => run.wallets.find(w => w.accountCase === account)!;
const verifiable = run.steps.filter(s => s.kind === "action");
const sentence = (title: string) => title[0].toLowerCase() + title.slice(1);

function describe(step: Step): { title: string; detail: string } {
  switch (step.kind) {
    case "login": return { title: "Signed in with Google", detail: "The browser made a fresh session key and bound it into the login's nonce, which Google signed." };
    case "backup": return { title: "Backed up the salt", detail: "Downloaded the encrypted backup, then proved it restores with its separately saved secret." };
    case "proof": return step.usedBeforeExpiry
      ? { title: `Generated the zero-knowledge proof in ${step.seconds} s`, detail: `Full Google JWT circuit on a laptop, peaking at ${((step.peakMiB ?? 0) / 1024).toFixed(1)} GiB of memory.` }
      : { title: `A proof finished in ${step.seconds} s, but the session ran out`, detail: "Sessions last ten minutes, so the account signed in again and proved afresh." };
    case "fund": return { title: "The sponsor sent 1 test ALGO", detail: "One-time demo funding for the new wallet." };
    case "seed": return { title: `The sponsor sent 100 ${UNIT}`, detail: "One-time funding with the demo asset." };
    case "replay": return { title: "Replaying the last action was rejected", detail: "TestNet refused the resubmitted group at the wallet's nonce check. Rejected transactions never reach a block, so this comes from the local record." };
    case "isolation": return { title: `This identity's proof was rejected by wallet ${step.otherWalletId}`, detail: "The other account's wallet refused it at its owner check and stayed unchanged." };
    case "restore": return { title: "Reloaded the browser and restored the backup", detail: `Signed in again, decrypted the backup with its secret and found the original wallet ${step.walletId}.` };
    case "action": {
      const amount = step.operation === "1" ? formatAlgo(step.amount!, true) : `${step.amount} ${UNIT}`;
      const title = { "0": "Enrolled the wallet", "1": `Sent ${amount} to the sponsor`, "2": "Opted in to the demo asset", "3": `Sent ${amount} to the sponsor` }[step.operation!]!;
      const extra = step.operation === "0" ? `Paid the ${formatAlgo(deployment.enrollmentDeposit, true)} deposit; the registry created the wallet. ` : "";
      return { title, detail: `${extra}Round ${step.round}, confirmed in ${((step.confirmationMs ?? 0) / 1000).toFixed(1)} s; the sponsor paid the ${formatAlgo(step.feeMicroAlgos!, true)} group fee.${step.afterRestore ? " Signed by a new session key after the restore." : ""}` };
    }
  }
}

function Hero() {
  return (
    <section className="hero">
      <p className="eyebrow">AlgoZKAuth · proof of concept</p>
      <h1>Sign in with Google. Control an Algorand wallet.</h1>
      <p className="lede">No seed phrase. A zero-knowledge proof convinces Algorand that Google signed your login, without putting your Google account on-chain. Your browser holds a short-lived key that signs each transfer.</p>
      <div className="actions">
        <a className="button" href="#verify">Verify a real transaction</a>
        <a className="button secondary" href="#run">Run it yourself</a>
        <ExtLink href={REPO}>Source on GitHub</ExtLink>
      </div>
      <p className="muted small">Algorand TestNet only · development proving setup · not audited</p>
    </section>
  );
}

const HOW = [
  ["Sign in", "Your browser creates a temporary signing key and puts its fingerprint in the login request. Google's signed login now vouches for that key for ten minutes."],
  ["Keep a salt", "A random secret salt, combined with your Google ID, decides which wallet is yours. Only a hash goes on-chain, so nobody can link the wallet to your account. You keep an encrypted backup of the salt."],
  ["Prove", "A zero-knowledge proof shows that Google signed a login for that identity and key, without revealing the login token or who you are. The recorded run took about two minutes on a laptop; the native prover added afterwards takes about ten seconds."],
  ["Sign actions", "The temporary key signs each transfer's exact recipient, amount and nonce. Algorand checks the proof and the signature together before the wallet moves funds."],
];

function HowItWorks() {
  return (
    <section className="card">
      <h2>How it works</h2>
      <ol className="how">
        {HOW.map(([title, text], i) => <li key={title}><span className="step-num">{i + 1}</span><div><h3>{title}</h3><p>{text}</p></div></li>)}
      </ol>
    </section>
  );
}

function RecordedRun({ onVerify }: { onVerify: (txId: string) => void }) {
  const [account, setAccount] = useState("A");
  const wallet = walletOf(account);
  const passed = run.checks.filter(c => c.passed).length;
  return (
    <section className="card" id="run-record">
      <h2>A real run on Algorand TestNet</h2>
      <p>On {new Date(run.recordedAt).toLocaleDateString(undefined, { dateStyle: "long" })}, two Google accounts each created a wallet and moved ALGO and a test asset. Account A then reloaded its browser, restored its backup and kept using the same wallet. Every transfer below is a public TestNet transaction. {passed} of {run.checks.length} acceptance checks passed.</p>
      <div className="tabs" role="tablist">
        {run.wallets.map(w => (
          <button key={w.accountCase} role="tab" type="button" aria-selected={account === w.accountCase} className={account === w.accountCase ? "tab active" : "tab"} onClick={() => setAccount(w.accountCase)}>Account {w.accountCase}</button>
        ))}
      </div>
      <p className="muted small">Wallet <ExtLink href={explorer.app(wallet.walletId)}>{wallet.walletId}</ExtLink> at <ExtLink href={explorer.account(wallet.address)}><span className="mono">{shorten(wallet.address, 6)}</span></ExtLink></p>
      <ol className="timeline">
        {run.steps.filter(s => s.account === account).map((step, i) => {
          const { title, detail } = describe(step);
          const onChain = step.kind === "action";
          return (
            <li key={i} className={onChain ? "chain" : step.kind === "replay" || step.kind === "isolation" ? "rejected" : ""}>
              <div className="dot" aria-hidden="true" />
              <div>
                <strong>{title}</strong>
                <p className="muted small">{detail}</p>
                {onChain && (
                  <div className="actions compact">
                    <ExtLink href={explorer.tx(callOf(step))}>View on explorer</ExtLink>
                    <button type="button" className="secondary small-button" onClick={() => onVerify(callOf(step))}>Verify in this browser</button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <details>
        <summary>Acceptance checks</summary>
        <ul className="checks small">
          {run.checks.map(c => <li key={c.check}><Indicator mark={c.passed ? "yes" : "warn"} />{c.check}</li>)}
          {run.deferred.map(d => <li key={d}><Indicator mark="info" />Not yet demonstrated: {d.toLowerCase()}</li>)}
        </ul>
      </details>
    </section>
  );
}

type Result = { state: "idle" } | { state: "running" } | { state: "done"; auth: Authorization; checks: Check[] } | { state: "error"; message: string };

function Verify({ txId, setTxId, result, onRun }: { txId: string; setTxId: (id: string) => void; result: Result; onRun: () => void }) {
  const step = verifiable.find(s => callOf(s) === txId)!;
  return (
    <section className="card" id="verify">
      <h2>Verify it yourself</h2>
      <p>Pick a recorded transaction. This page fetches it from a public TestNet indexer and re-checks it here, in your browser: the zero-knowledge proof against the published verification key, the network and app bindings, the wallet owner, and the session key's signature over the exact action. No server of ours is involved.</p>
      <div className="verify-controls">
        <label>Transaction
          <select value={txId} onChange={e => setTxId(e.target.value)}>
            {verifiable.map(s => <option key={callOf(s)} value={callOf(s)}>Account {s.account}: {sentence(describe(s).title)}{s.afterRestore ? " (after restore)" : ""}</option>)}
          </select>
        </label>
        <button type="button" onClick={onRun} disabled={result.state === "running"}>{result.state === "running" ? "Verifying…" : "Verify in this browser"}</button>
      </div>
      <p className="muted small">Wallet {walletOf(step.account).walletId} · round {step.round} · <ExtLink href={explorer.tx(txId)}><span className="mono">{shorten(txId, 6)}</span></ExtLink></p>
      {result.state === "error" && <p className="callout warn">{result.message}</p>}
      {result.state === "done" && <VerifyResult auth={result.auth} checks={result.checks} />}
    </section>
  );
}

function VerifyResult({ auth, checks }: { auth: Authorization; checks: Check[] }) {
  const all = checks.every(c => c.ok);
  const plan = auth.plan;
  const amount = plan.assetId === "0" ? formatAlgo(plan.amount, true) : `${plan.amount} ${UNIT}`;
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
            <Field label="Recipient"><span className="mono">{shorten(plan.recipient, 6)}</span>{plan.recipient === deployment.sponsor ? " (sponsor)" : ""}</Field>
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
            <li><Indicator mark="yes" />Google-backed wallets work with Algorand's existing LogicSig and smart-contract features; no protocol change is needed.</li>
            <li><Indicator mark="yes" />Each transfer is bound to its exact recipient, amount, network and nonce; replays and other identities were rejected.</li>
            <li><Indicator mark="yes" />After a browser reload, the encrypted backup recovered the original wallet and a fresh login kept using it.</li>
          </ul>
        </div>
        <div>
          <h3>Trust and limits</h3>
          <ul className="checks small">
            <li><Indicator mark="warn" />One administrator approves Google's signing keys. Combined with a user's salt, that authority could take over the wallet.</li>
            <li><Indicator mark="warn" />The local prover sees the login token and salt. The recorded proofs took about two minutes of a ten-minute session; the native prover added afterwards takes about ten seconds.</li>
            <li><Indicator mark="warn" />Losing the backup loses the wallet; Google login alone cannot recover it.</li>
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
      <p>The demo runs on your own machine. You deploy your own contracts on TestNet and act as your own prover and fee sponsor, so nobody else sees your login or salt.</p>
      <pre className="code"><code>{`git clone ${REPO}.git\ncd algo-zkauth\nsh scripts/demo/quickstart.sh`}</code></pre>
      <ul className="small">
        <li>Node 24 or newer, git, and about 4 GB of free memory for the proof.</li>
        <li>A Google OAuth client ID with <code>http://localhost:8765</code> as an authorized origin.</li>
        <li>About 5 TestNet ALGO from the <ExtLink href="https://dispenser.testnet.aws.algodev.network/">TestNet dispenser</ExtLink>; the quickstart creates the account.</li>
      </ul>
      <p className="small">It downloads the 1.4 GB proving key and verifies its pinned hash, deploys, and opens the demo at <code>http://localhost:8765/demo/</code>. <ExtLink href={`${REPO}#run-the-demo`}>Full instructions</ExtLink></p>
    </section>
  );
}

export function Site() {
  const defaultTx = callOf(verifiable.find(s => s.afterRestore) ?? verifiable[0]);
  const [txId, setTxId] = useState(defaultTx);
  const [result, setResult] = useState<Result>({ state: "idle" });
  const running = useRef<string | undefined>(undefined);
  const verify = async (id: string) => {
    running.current = id;
    setResult({ state: "running" });
    try {
      const auth = decodeAuthorization(await fetchTransaction(id), deployment);
      const step = verifiable.find(s => callOf(s) === id)!;
      // An enrollment creates the wallet; afterwards its owner is on-chain.
      const owner = auth.method === "enroll" ? walletOf(step.account).ownerCommitment : await fetchWalletOwner(auth.plan.walletId);
      const checks = await verifyAuthorization(auth, deployment, owner);
      if (running.current === id) setResult({ state: "done", auth, checks });
    } catch (error) {
      if (running.current === id) setResult({ state: "error", message: error instanceof Error ? error.message : "Verification failed" });
    }
  };
  const choose = (id: string) => { setTxId(id); setResult({ state: "idle" }); };
  return (
    <div className="page site">
      <Hero />
      <HowItWorks />
      <RecordedRun onVerify={id => { choose(id); document.getElementById("verify")?.scrollIntoView({ behavior: "smooth" }); verify(id); }} />
      <Verify txId={txId} setTxId={choose} result={result} onRun={() => verify(txId)} />
      <Trust />
      <RunIt />
      <footer className="muted small">
        <p>AlgoZKAuth is an unaudited proof of concept on Algorand TestNet. Registry <ExtLink href={explorer.app(deployment.registryId)}>{deployment.registryId}</ExtLink>, key policy <ExtLink href={explorer.app(deployment.keyRegistryId)}>{deployment.keyRegistryId}</ExtLink>. <ExtLink href={REPO}>Source and evidence on GitHub</ExtLink>.</p>
      </footer>
    </div>
  );
}
