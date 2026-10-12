import { TYPICAL_PROOF_MS } from "./protocol";
import type { DemoState } from "./controller";

export type StepState = "done" | "current" | "attention" | "locked";
export type Step = { id: string; title: string; state: StepState };

/** Which controls are usable now, mirroring the classic page's update(). */
export function gates(s: DemoState, now: number) {
  const busy = !!s.busy;
  const active = !!s.identity && !!s.session && s.session.expiresAt > now;
  const remaining = s.session ? Math.max(0, s.session.expiresAt - now) : 0;
  const ready = active && s.proof.ready && s.backup.verified && !busy;
  const enrolled = !!s.wallet?.enrolled;
  const expectedProofMs = s.lastProofMs ?? TYPICAL_PROOF_MS;
  return {
    busy, active, remaining, ready, enrolled, expectedProofMs,
    // A proof started now would leave less than a minute to use it.
    proofWouldBeTight: active && !s.proof.ready && remaining * 1000 < expectedProofMs + 60_000,
    renew: !busy && !!s.config,
    create: !busy && active && !s.hasSalt,
    download: !busy && !!s.backup.packageText,
    addPasskey: !busy && !!s.backup.packageText && !!s.backup.secret,
    restoreSecret: !busy && active && !!s.backup.imported,
    restorePasskey: !busy && active && !!s.backup.imported && s.backup.importedHasPasskey,
    prove: !busy && active && s.hasSalt && s.backup.verified,
    refresh: !busy && active && s.hasSalt,
    enroll: ready && !enrolled,
    runDemo: ready,
    walletActions: ready && enrolled,
    replay: ready && s.lastExecution,
  };
}

export type Gates = ReturnType<typeof gates>;

/** The single next instruction shown beside proof generation. */
export function nextStep(s: DemoState, g: Gates): { text: string; target?: string } {
  const b = s.backup;
  if (g.busy) return { text: `${s.busy}… Wait for it to finish; progress appears below.` };
  if (!s.identity) return { text: "First complete Sign in with Google in step 1.", target: "step-login" };
  if (!g.active) return { text: "Your Google session expired. Click Renew login session in step 1 and sign in to the same account. Your backup and selected salt stay in this tab.", target: "step-login" };
  if (!s.hasSalt) return { text: "Complete step 2: create a recovery backup, or import an existing backup and restore it using its saved secret.", target: "step-backup" };
  if (!b.verified && !b.packageText) return { text: "Backup creation or discovery did not finish. Check the error message above. Preserve any saved backup and secret before reloading." };
  if (!b.verified && !b.downloaded) return { text: "Step 2: save the recovery secret separately and click Download encrypted backup. Then import that downloaded file and restore it using the secret.", target: "step-backup" };
  if (!b.verified && !b.secretSaved) return { text: "Step 2: tick the box confirming you saved the secret separately. Then import the downloaded backup, enter its saved secret, and click Restore using secret.", target: "step-backup" };
  if (!b.verified && !b.imported) return { text: "Step 2: select the downloaded file under Import encrypted backup, enter its saved secret, and click Restore using secret.", target: "step-backup" };
  if (!b.verified) return { text: "Step 2: enter the saved recovery secret and click Restore using secret. Selecting the file alone does not verify the backup.", target: "step-backup" };
  if (!s.proof.ready) return { text: "Backup verified. Click Generate local proof below. After it finishes, click Run ALGO / ASA demo in step 4." };
  return { text: "Proof ready. Click Run ALGO / ASA demo in step 4.", target: "step-wallet" };
}

export function steps(s: DemoState, g: Gates): Step[] {
  const done = [
    !!s.identity && (g.active ? true : "attention"),
    s.backup.verified,
    s.proof.ready && g.active,
    s.lastExecution,
  ] as const;
  const titles = [["step-login", "Sign in"], ["step-backup", "Back up salt"], ["step-proof", "Prove"], ["step-wallet", "Enroll & transact"]];
  let current = false;
  return titles.map(([id, title], i) => {
    const value = done[i];
    let state: StepState;
    if (value === true) state = "done";
    else if (value === "attention") state = "attention";
    else if (!current) { state = "current"; current = true; }
    else state = "locked";
    if (state === "attention") current = true;
    return { id, title, state };
  });
}
