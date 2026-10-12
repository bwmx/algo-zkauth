import { useEffect, useState, useSyncExternalStore } from "react";
import type { DemoController } from "./controller";
import { gates, steps } from "./gates";
import { Explore } from "./components/Explore";
import { SaltLocation, SessionCard, WalletCard } from "./components/Sidebar";
import { BackupStep, LoginStep, ProofStep, Stepper, WalletStep } from "./components/Steps";

function useNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function App({ controller }: { controller: DemoController }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const now = useNow();
  const g = gates(s, now);
  useEffect(() => {
    controller.start();
    const hide = () => controller.dispose();
    addEventListener("pagehide", hide);
    return () => removeEventListener("pagehide", hide);
  }, [controller]);
  const props = { s, g, c: controller, now };
  return (
    <div className="page">
      <header className="masthead">
        <div>
          <h1>AlgoZKAuth</h1>
          <p className="muted">Google → your Algorand wallet · proof of concept</p>
        </div>
        <span className="badge">TestNet only</span>
      </header>
      <p className="intro">This demo uses development proof keys and test assets. The local sponsor pays deployment and group fees. Your session signing key stays in this tab; login does not replace the saved recovery backup.</p>
      <p className={`status ${s.status.kind}`} role="status" aria-live="polite" data-testid="status">
        {s.busy && <span className="spinner" aria-hidden="true" />}{s.status.text}
      </p>
      <Stepper steps={steps(s, g)} />
      <div className="layout">
        <main>
          <LoginStep {...props} />
          <BackupStep {...props} />
          <ProofStep {...props} />
          <WalletStep {...props} />
        </main>
        <aside>
          <SessionCard s={s} g={g} />
          <WalletCard s={s} g={g} />
          <SaltLocation s={s} g={g} />
        </aside>
      </div>
      <Explore s={s} c={controller} />
    </div>
  );
}
