import { useRef, useState } from "react";
import { ExtLink, Field, Indicator } from "../components/ui";
import { OPERATION_LABELS, SIGNAL_LAYOUT, explorer, formatAlgo, localTime, shorten } from "../protocol";
import data from "./recorded-run.json";
import { decodeAuthorization, fetchTransaction, fetchWalletOwner, verifyAuthorization, type Authorization, type Check } from "./verify";

const REPO = "https://github.com/bwmx/algo-zkauth";
const doc = (path: string) => `${REPO}/blob/main/${path}`;
const GLYPH = `${import.meta.env.BASE_URL}glyph.svg`;
const SLACK_WALLETS = ["774125965", "774127169"];

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
      const extra = step.operation === "0" ? `Paid the ${formatAlgo(deployment.enrollmentDeposit, true)} deposit; the registry created the wallet. ` : "";
      return { title, detail: `${extra}Round ${step.round}, confirmed in ${((step.confirmationMs ?? 0) / 1000).toFixed(1)} s; the sponsor paid the ${formatAlgo(step.feeMicroAlgos!, true)} group fee.${step.afterRestore ? " Signed by a new session key after the restore." : ""}` };
    }
  }
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
      <p className="muted small">The recorded run on this page is the Google one: two genuine Google identities on Algorand TestNet, 2026-10-09. Slack has <a href="#slack">its own TestNet evidence</a>.</p>
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
      <p className="small muted">The recorded run below is the Google one. Its proofs used the snarkjs prover of the time, about two minutes each; the native prover has since proved genuine tokens in 8.5–10.4 s for Google and 9.7 s for Slack.</p>
    </section>
  );
}

function RecordedRun({ onVerify }: { onVerify: (txId: string) => void }) {
  const [account, setAccount] = useState("A");
  const wallet = walletOf(account);
  const passed = run.checks.filter(c => c.passed).length;
  return (
    <section className="card" id="run-record">
      <h2>A recorded Google run on Algorand TestNet</h2>
      <p>On {new Date(run.recordedAt).toLocaleDateString(undefined, { dateStyle: "long" })}, two genuine Google accounts each created a wallet and moved ALGO and a test asset. Account A then reloaded its browser, restored its backup and kept using the same wallet. Every transfer below is a public TestNet transaction. {passed} of {run.checks.length} acceptance checks passed.</p>
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
        <pre className="code"><code>{`git clone ${REPO}.git\ncd algo-zkauth\nsh scripts/demo/quickstart.sh`}</code></pre>
        <p className="small">You deploy your own contracts on TestNet and act as your own prover, fee sponsor and key administrator, so nobody else sees your login or salt.</p>
        <ul className="small">
          <li>Node 24 or newer and git.</li>
          <li>A Google OAuth client ID with <code>http://localhost:8765</code> as an authorized origin.</li>
          <li>About 5 TestNet ALGO from the <ExtLink href="https://dispenser.testnet.aws.algodev.network/">TestNet dispenser</ExtLink>; the quickstart creates the account.</li>
        </ul>
        <p className="small">It downloads the 1.4 GB proving key and verifies its pinned hash, deploys, and opens the demo at <code>http://localhost:8765/demo/</code>. Sign in with Slack is optional and needs a Slack app of your own. <ExtLink href={`${REPO}#run-the-testnet-demo`}>Full instructions</ExtLink></p>
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

function BuildOnIt() {
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
      <p className="small muted">So far the service stack has run end to end only on LocalNet with the development login issuer. <ExtLink href={doc("docs/service-architecture.md")}>Service architecture</ExtLink></p>
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
      <BuildOnIt />
      <footer className="muted small">
        <p>AlgoZKAuth is an unaudited proof of concept on Algorand TestNet. Recorded Google deployment: registry <ExtLink href={explorer.app(deployment.registryId)}>{deployment.registryId}</ExtLink>, key policy <ExtLink href={explorer.app(deployment.keyRegistryId)}>{deployment.keyRegistryId}</ExtLink>. <ExtLink href={REPO}>Source and evidence on GitHub</ExtLink>.</p>
      </footer>
    </div>
  );
}
