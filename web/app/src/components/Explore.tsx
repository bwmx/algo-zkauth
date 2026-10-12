import { useState } from "react";
import { getApplicationAddress } from "algosdk";
import type { DemoController, DemoState } from "../controller";
import {
  CIRCUIT_SIGNED_BYTES, OPERATION_LABELS, SIGNAL_LAYOUT, explorer, formatAlgo, localTime, shorten,
} from "../protocol";
import { ExtLink, Field, Indicator } from "./ui";

type Props = { s: DemoState; c: DemoController };
const TABS = [["history", "Transaction history"], ["inspector", "Under the hood"], ["salt", "Salt strategies"], ["activity", "Activity"]] as const;
type Tab = (typeof TABS)[number][0];

export function Explore(props: Props) {
  const [tab, setTab] = useState<Tab>("inspector");
  return (
    <section className="card explore">
      <div className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" type="button" aria-selected={tab === id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>
            {label}{id === "activity" && props.s.activity.length ? ` (${props.s.activity.length})` : ""}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "history" && <History {...props} />}
        {tab === "inspector" && <Inspector {...props} />}
        {tab === "salt" && <SaltStrategies />}
        {tab === "activity" && <Activity {...props} />}
      </div>
    </section>
  );
}

function History({ s, c }: Props) {
  const h = s.history;
  const wallet = s.wallet;
  if (!wallet?.enrolled) return <p className="muted">History appears after this identity's wallet is enrolled or discovered.</p>;
  const registry = s.config && getApplicationAddress(BigInt(s.config.registryId)).toString();
  const name = (address?: string) => (!address ? "—" : address === s.config?.sponsor ? "sponsor" : address === registry ? "registry" : address === wallet.address ? "this wallet" : shorten(address, 5));
  const amount = (value?: string, assetId?: string) => (value === undefined ? "" : assetId === "0" ? formatAlgo(value, true) : `${value} ${s.assetUnit ?? "units"}`);
  return (
    <div>
      <div className="actions">
        <button className="secondary" type="button" disabled={h.loading} onClick={c.refreshHistory}>{h.loading ? "Loading…" : "Refresh history"}</button>
        <span className="muted small">From the public AlgoNode TestNet indexer, which can trail confirmation by a few seconds.</span>
      </div>
      {h.error && <p className="error-text">{h.error}</p>}
      {h.items.length === 0 && !h.loading ? <p className="muted">No transactions found yet.</p> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Time</th><th>Event</th><th className="num">Amount</th><th>Counterparty</th><th>Round</th></tr></thead>
            <tbody>
              {h.items.map(item => (
                <tr key={item.id}>
                  <td>{item.time ? new Date(item.time * 1000).toLocaleString() : "—"}</td>
                  <td><ExtLink href={explorer.tx(item.id)}>{item.label}</ExtLink></td>
                  <td className={`num ${item.direction}`}>{item.direction === "out" ? "−" : item.direction === "in" ? "+" : ""}{amount(item.amount, item.assetId)}</td>
                  <td className="mono">{name(item.counterparty)}</td>
                  <td>{item.round}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Signed message keys accepted by the circuit's compact token profile (docs/phase3-protocol.md).
const PROFILE_CLAIMS = new Set(["iss", "azp", "aud", "sub", "hd", "email", "email_verified", "nonce", "nbf", "name", "picture", "given_name", "family_name", "iat", "exp", "jti", "at_hash", "auth_time"]);

const ENROLL_GROUP = [
  ["Sponsor deposit payment", "Normally signed payment of the enrollment deposit to the registry"],
  ["WalletRegistry.enroll", "Signed by the Groth16 verifier LogicSig; carries the proof, 12 signals and the session signature"],
  ...Array.from({ length: 5 }, () => ["LogicSig budget payment", "Zero-value payment from the verifier, adding opcode budget"]),
];
const EXECUTE_GROUP = [
  ["UserWallet.execute", "Signed by the Groth16 verifier LogicSig; carries the proof, signals, action fields and session signature"],
  ["Sponsor fee payment", "Pays the pooled group fee; the wallet pays no fees"],
  ...Array.from({ length: 5 }, () => ["LogicSig budget payment", "Zero-value payment from the verifier, adding opcode budget"]),
];

function Inspector({ s }: Props) {
  const session = s.session;
  const token = s.token;
  const proof = s.proof;
  const action = s.lastAction;
  const expected: Record<string, string | number | undefined> = {
    commitment: s.commitment, audienceHash: s.config?.audienceHash, genesisHash: s.config?.genesisHash, sessionKey: session?.publicKey, expiresAt: session?.expiresAt,
  };
  return (
    <div className="inspector">
      <article>
        <h3>1 · Session nonce</h3>
        <p className="muted">Google signs this nonce. It commits to the network, this tab's session key and its expiry, so the token cannot authorize a different key.</p>
        {!session ? <p className="muted">Available after sign-in.</p> : (
          <dl className="fields">
            <Field label="Formula"><code>SHA-256("algorand-zklogin-session-v1\0" ‖ genesis ‖ key ‖ expiry ‖ randomness)</code></Field>
            <Field label="Genesis hash"><span className="mono">{shorten(s.config!.genesisHash, 10)}</span></Field>
            <Field label="Session public key"><span className="mono">{shorten(session.publicKey, 10)}</span></Field>
            <Field label="Expiry">{session.expiresAt} ({localTime(session.expiresAt)})</Field>
            <Field label="Randomness"><span className="mono">{shorten(session.randomness, 4)}</span> <span className="muted">private witness input</span></Field>
            <Field label="Nonce"><span className="mono">{session.nonce}</span></Field>
            <Field label="Checks"><Indicator mark="yes" /> recomputed in this tab{token?.nonce && <> · <Indicator mark={token.nonce === session.nonce ? "yes" : "warn"} /> matches the token's nonce</>}</Field>
          </dl>
        )}
      </article>
      <article>
        <h3>2 · Google ID token</h3>
        <p className="muted">Decoded in this tab for display. The local server verifies it; the circuit re-verifies its RS256 signature. The token never goes on-chain.</p>
        {!token ? <p className="muted">Available after sign-in.</p> : (
          <dl className="fields">
            <Field label="Header">{token.alg} · kid <span className="mono">{token.kid && shorten(token.kid, 6)}</span></Field>
            <Field label="Issuer">{token.iss}</Field>
            <Field label="Audience"><span className="mono">{token.aud && shorten(token.aud, 10)}</span></Field>
            <Field label="Subject"><span className="mono">{token.sub}</span> <span className="muted">masked; private witness input</span></Field>
            <Field label="Issued / expires">{token.iat && localTime(token.iat)} → {token.exp && localTime(token.exp)}</Field>
            <Field label="Signed bytes">
              <span className={token.signedBytes > CIRCUIT_SIGNED_BYTES ? "error-text" : ""}>{token.signedBytes} of {CIRCUIT_SIGNED_BYTES}</span>
              <div className="bar thin"><span style={{ width: `${Math.min(100, (token.signedBytes / CIRCUIT_SIGNED_BYTES) * 100).toFixed(1)}%` }} /></div>
            </Field>
            <Field label="Claims">
              {token.claimNames.map(name => <span key={name} className={`chip ${PROFILE_CLAIMS.has(name) ? "" : "warn"}`} title={PROFILE_CLAIMS.has(name) ? "Accepted by the circuit profile" : "Outside the circuit's token profile"}>{name}</span>)}
            </Field>
          </dl>
        )}
      </article>
      <article>
        <h3>3 · Proof public signals</h3>
        <p className="muted">Twelve values verified on-chain by the LogicSig. Everything else (token, subject, salt, signature, randomness) stays private.</p>
        {!proof.decoded ? <p className="muted">Available after a proof finishes.</p> : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>Index</th><th>Meaning</th><th>Value</th><th>This tab</th></tr></thead>
              <tbody>
                {SIGNAL_LAYOUT.map(row => {
                  const value = proof.decoded![row.field];
                  const want = expected[row.field];
                  return (
                    <tr key={row.indexes}>
                      <td>{row.indexes}</td>
                      <td>{row.meaning}</td>
                      <td className="mono">{typeof value === "number" ? `${value} (${localTime(value)})` : shorten(value, 8)}</td>
                      <td>{want === undefined ? (row.field === "keyHash" ? <Indicator mark={proof.checks?.find(c => c.label === "Google signing key")?.ok ? "yes" : "info"} /> : "—") : <Indicator mark={want === value ? "yes" : "warn"} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {proof.measurement && <p className="muted small">Peak Node RSS {(proof.measurement.peakRssBytes / 1024 / 1024).toFixed(0)} MiB · total {(proof.measurement.elapsedMs / 1000).toFixed(1)} s</p>}
      </article>
      <article>
        <h3>4 · Last signed action</h3>
        <p className="muted">The session key signs a domain-separated digest of every field. The wallet recomputes it on-chain, so a relay cannot change the recipient, amount or nonce.</p>
        {!action ? <p className="muted">Available after the first enrollment or transfer.</p> : (
          <dl className="fields">
            <Field label="Operation">{OPERATION_LABELS[action.plan.operation]} (code {action.plan.operation})</Field>
            <Field label="Network / registry"><span className="mono">{shorten(action.plan.genesisHash, 6)}</span> / {action.plan.registryId}</Field>
            <Field label="Wallet / owner">{action.plan.walletId} / <span className="mono">{shorten(action.plan.owner, 6)}</span></Field>
            <Field label="Recipient"><span className="mono">{shorten(action.plan.recipient, 8)}</span></Field>
            <Field label="Asset / amount">{action.plan.assetId} / {action.plan.amount}</Field>
            <Field label="Nonce / expiry">{action.plan.nonce} / {action.plan.sessionExpiresAt}</Field>
            <Field label="Digest"><span className="mono">SHA-256("algorand-zklogin-action-v1\0" ‖ …) = {shorten(action.digestHex, 12)}</span></Field>
            <Field label="Ed25519 signature"><span className="mono">{shorten(action.signature, 12)}</span></Field>
          </dl>
        )}
      </article>
      <article>
        <h3>5 · Atomic group</h3>
        <p className="muted">Proof verification and the wallet call succeed or fail together in one seven-transaction group (layout from the wallet specification).</p>
        {!action ? <p className="muted">Available after the first enrollment or transfer.</p> : (
          <>
            <ol className="group">
              {(action.plan.operation === "0" ? ENROLL_GROUP : EXECUTE_GROUP).map(([name, detail], i) => {
                const id = action.measurement.transactionIds.length === 7 ? action.measurement.transactionIds[i] : undefined;
                return <li key={i}><strong>{name}</strong> <span className="muted">{detail}</span>{id && <> · <ExtLink href={explorer.tx(id)}>{shorten(id, 5)}</ExtLink></>}</li>;
              })}
            </ol>
            <dl className="fields">
              <Field label="Confirmed">round {action.measurement.confirmedRound}{action.measurement.confirmationMs ? ` in ${(action.measurement.confirmationMs / 1000).toFixed(1)} s` : ""}</Field>
              <Field label="Transactions">{action.measurement.outerTransactions ?? 7} outer · {action.measurement.innerTransactions ?? "—"} inner</Field>
              <Field label="Opcode budget">{action.measurement.logicSigBudgetConsumed?.toLocaleString("en-US") ?? "—"} LogicSig · {action.measurement.appBudgetConsumed?.toLocaleString("en-US") ?? "—"} app</Field>
              <Field label="Group fee">{formatAlgo(action.measurement.groupFeeMicroAlgos, true)} (sponsor) · {action.measurement.signedBytes?.toLocaleString("en-US") ?? "—"} signed bytes</Field>
            </dl>
          </>
        )}
      </article>
    </div>
  );
}

const STRATEGIES: [string, string, string, string][] = [
  ["Where the value comes from", "Random 32 bytes generated in this tab", "A pepper service evaluates a VUF over (iss, uid key, uid value, aud) after verifying a fresh JWT (AIP-81)", "The app chooses: user- or app-managed, or a salt service such as Mysten's"],
  ["What the user keeps", "Encrypted file plus recovery secret (or a passkey)", "Nothing; logging in again recomputes the pepper", "Depends on the app's strategy"],
  ["Recover with only the Google login", "No", "Yes, while the pepper service and its key exist", "Only when a salt service is used"],
  ["Who can link identity and account", "Only salt holders: you and the local prover", "The pepper service (VUF key holder) and the prover service", "The salt service if used, and the prover"],
  ["Largest failure", "Losing your own backup loses your wallet", "Losing the VUF key strands every account whose pepper is not cached", "Losing the salt service or its master seed"],
  ["If the value leaks", "Privacy loss, and the precondition for a key-administrator takeover in this POC", "Privacy only: validators agree on JWKs (AIP-67)", "Privacy only: validators agree on JWKs"],
  ["Accounts per identity and app", "Any number: a new salt is a new wallet", "One per derivation path from the master pepper", "Depends on the salt strategy"],
];

function SaltStrategies() {
  return (
    <div>
      <p>The salt (Aptos: <em>pepper</em>) hides which Google account owns a wallet. It is not a spending key: spending also needs a fresh Google token and a proof. But losing it loses the wallet, so every design must decide who keeps it.</p>
      <div className="table-scroll">
        <table className="compare">
          <thead><tr><th /><th>This POC</th><th>Aptos Keyless</th><th>Sui zkLogin</th></tr></thead>
          <tbody>{STRATEGIES.map(([row, ...cells]) => <tr key={row}><th scope="row">{row}</th>{cells.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <h3>Why this POC does not just add a pepper service</h3>
      <p>Aptos can centralize peppers because no single party approves Google's signing keys: validators reach consensus on them. Here one administrator approves keys in the GoogleKeyRegistry. Anyone holding a user's salt <em>and</em> that authority could approve a forged RSA key, mint a matching token and take over the wallet. A pepper service run by, or leaking to, the key administrator would hold every salt at once. Key approval would need to be threshold-controlled or time-delayed first. <span className="muted">See docs/aptos-comparison.md.</span></p>
    </div>
  );
}

function Activity({ s }: Props) {
  if (!s.activity.length) return <p className="muted">Public confirmation details will appear here.</p>;
  return (
    <ol className="activity">
      {[...s.activity].reverse().map((entry, i) => (
        <li key={i} className={entry.kind}>
          <time>{new Date(entry.at).toLocaleTimeString()}</time> {entry.text}
          {entry.txId && <> <ExtLink href={explorer.tx(entry.txId)}>{shorten(entry.txId, 5)}</ExtLink></>}
        </li>
      ))}
    </ol>
  );
}
