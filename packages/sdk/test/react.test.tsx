// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { algo, createZkAuth } from "../src/index.ts";
import type { ZkAuth } from "../src/index.ts";
import { ZkAuthProvider, useSession, useWallet, useZkAuth } from "../src/react.tsx";
import { FakeApi, token } from "./fake-api.ts";

// jsdom does not provide WebCrypto Ed25519; use Node's.
beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function setup(extra = {}) {
  const api = new FakeApi();
  const zk = createZkAuth({ service: "http://svc.test", app: "demo", fetch: api.fetch, pollMs: 1, login: async ({ nonce }) => token(nonce), ...extra });
  return { api, zk };
}

function Probe({ zk }: { zk: ZkAuth }) {
  return (
    <ZkAuthProvider zk={zk}>
      <Auth />
      <Wallet />
    </ZkAuthProvider>
  );
}

function Auth() {
  const { status, error, config } = useZkAuth();
  const { session, signIn, signOut, expiring, expired, renew } = useSession();
  return (
    <section>
      <p data-testid="status">{status}</p>
      <p data-testid="config">{config ? config.network : "no-config"}</p>
      <p data-testid="auth-error">{error ? (error as { code?: string }).code ?? error.message : ""}</p>
      <p data-testid="subject">{session?.identity.subject ?? ""}</p>
      <p data-testid="expiring">{String(expiring)}/{String(expired)}</p>
      <button onClick={() => { signIn().catch(() => {}); }}>sign in</button>
      <button onClick={() => { signOut(); }}>sign out</button>
      <button onClick={() => { renew().catch(() => {}); }}>renew</button>
      <button onClick={() => { void session?.backup.create(); }}>backup</button>
    </section>
  );
}

function Wallet() {
  const w = useWallet();
  return (
    <section>
      <p data-testid="wallet">{w.wallet ? "ready" : "none"}</p>
      <p data-testid="loading">{String(w.loading)}</p>
      <p data-testid="enrolled">{String(w.enrolled)}</p>
      <p data-testid="balance">{w.balance ? w.balance.microAlgos.toString() : "-"}</p>
      <p data-testid="address">{w.address ?? ""}</p>
      <p data-testid="busy">{w.busy}</p>
      <p data-testid="wallet-error">{w.error ? (w.error as { code?: string }).code : ""}</p>
      <button onClick={() => { w.enroll().catch(() => {}); }}>enroll</button>
      <button onClick={() => { w.sendAlgo({ to: w.address!, amount: algo("100") }).catch(() => {}); }}>send big</button>
      <button onClick={() => { w.sendAlgo({ to: w.address!, amount: 1000n }).catch(() => {}); }}>send small</button>
    </section>
  );
}

const text = (id: string) => screen.getByTestId(id).textContent;

describe("React bindings", () => {
  it("renders sign-in states and the loaded config", async () => {
    const { zk } = setup();
    render(<Probe zk={zk} />);
    expect(text("status")).toBe("signed-out");
    await waitFor(() => expect(text("config")).toBe("testnet"));
    fireEvent.click(screen.getByText("sign in"));
    await waitFor(() => expect(text("status")).toBe("signed-in"));
    expect(text("subject")).toBe("alice");
    expect(text("wallet")).toBe("none");                            // no salt yet
    fireEvent.click(screen.getByText("sign out"));
    await waitFor(() => expect(text("status")).toBe("signed-out"));
  });

  it("creates its own client from props and surfaces sign-in errors", async () => {
    const api = new FakeApi();
    render(
      <ZkAuthProvider service="http://svc.test" app="demo" fetch={api.fetch} login={async () => token("wrong")}>
        <Auth />
      </ZkAuthProvider>,
    );
    fireEvent.click(screen.getByText("sign in"));
    await waitFor(() => expect(text("auth-error")).toBe("token_invalid"));
    expect(text("status")).toBe("signed-out");
  });

  it("useWallet: loading, balance, enrollment, action errors and busy state", async () => {
    const { zk, api } = setup();
    render(<Probe zk={zk} />);
    fireEvent.click(screen.getByText("sign in"));
    await waitFor(() => expect(text("status")).toBe("signed-in"));
    fireEvent.click(screen.getByText("backup"));
    await waitFor(() => expect(text("wallet")).toBe("ready"));
    await waitFor(() => expect(text("loading")).toBe("false"));
    expect(text("enrolled")).toBe("false");
    expect(text("balance")).toBe("0");

    fireEvent.click(screen.getByText("enroll"));
    await waitFor(() => expect(text("enrolled")).toBe("true"));
    expect(text("address")).not.toBe("");
    expect(text("balance")).toBe("200000");
    expect(text("busy")).toBe("idle");

    fireEvent.click(screen.getByText("send big"));
    await waitFor(() => expect(text("wallet-error")).toBe("insufficient_funds"));

    api.fund(text("address")!, 1_000_000n);
    fireEvent.click(screen.getByText("send small"));
    await waitFor(() => expect(text("balance")).toBe("1199000"));
    expect(text("wallet-error")).toBe("");                          // cleared by the next successful call
  });

  it("useSession: expiring and expired flags, renew resets them", async () => {
    vi.useFakeTimers({ now: new Date("2030-01-01T00:00:00Z"), shouldAdvanceTime: true });
    const { zk } = setup({ expiringSeconds: 30 });
    render(<Probe zk={zk} />);
    fireEvent.click(screen.getByText("sign in"));
    await waitFor(() => expect(text("status")).toBe("signed-in"));
    expect(text("expiring")).toBe("false/false");
    await act(async () => { await vi.advanceTimersByTimeAsync(571 * 1000); });
    expect(text("expiring")).toBe("true/false");
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 1000); });
    expect(text("expiring")).toBe("false/true");
    fireEvent.click(screen.getByText("renew"));
    await waitFor(() => expect(text("expiring")).toBe("false/false"));
  });

  it("hooks outside the provider explain themselves", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Auth />)).toThrow(/ZkAuthProvider/);
    spy.mockRestore();
  });
});
