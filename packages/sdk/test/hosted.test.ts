// @vitest-environment jsdom
// connectWallet (dApp side) against serveWallet (wallet side), with the two
// windows simulated so every message carries a real origin and source.
import { afterEach, describe, expect, it } from "vitest";
import { connectWallet, isZkAuthError, ZkAuthError } from "../src/index.ts";
import { serveWallet, type HostedAccount, type WalletHostHandlers } from "../src/wallet-host.ts";

const WALLET = "https://wallet.example";
const DAPP = "https://dapp.example";
const ACCOUNT: HostedAccount = { address: "ADDR", walletId: "1006", provider: "google", network: "localnet", balanceMicroAlgos: "5000000", spendableMicroAlgos: "4800000", assets: [{ id: "7", amount: "3" }] };

/** A wallet window: the dApp posts into `walletSelf`; the wallet posts back through `opener` into the dApp's window. */
function walletWindow(handlers: Partial<WalletHostHandlers>, opts: { approve?: boolean } = {}) {
  const walletSelf = new EventTarget();
  const popup = {
    closed: false,
    focus() {},
    close() { this.closed = true; },
    postMessage(data: unknown, targetOrigin: string) {
      expect(targetOrigin).toBe(WALLET);
      walletSelf.dispatchEvent(new MessageEvent("message", { data, origin: DAPP, source: opener as never }));
    },
  };
  const opener = {
    postMessage(data: unknown, targetOrigin: string) {
      if (targetOrigin !== "*") expect(targetOrigin).toBe(DAPP);
      queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", { data, origin: WALLET, source: popup as never })));
    },
  };
  const connected = new Set<string>();
  const sent: unknown[] = [];
  const full: WalletHostHandlers = {
    isConnected: (o) => connected.has(o),
    connect: async (o) => { if (opts.approve === false) throw new ZkAuthError("user_rejected", "The user declined"); connected.add(o); return ACCOUNT; },
    account: async () => ACCOUNT,
    sendAlgo: async (_o, p) => { sent.push(p); return { txId: "TX1", groupId: "G1", confirmedRound: "42", explorerUrl: "https://x/tx/TX1" }; },
    optIn: async () => ({ txId: "TX2", groupId: "G2", confirmedRound: "43", explorerUrl: "" }),
    sendAsset: async (_o, p) => { sent.push(p); return { txId: "TX3", groupId: "G3", confirmedRound: "44", explorerUrl: "" }; },
    // Echoes the origin the wallet host saw, which is what it must sign for.
    signIn: async (o, p) => { sent.push({ signInFor: o, ...p }); return { fields: { origin: o, nonce: p.nonce } as never, signature: "SIG", proof: { proof: {} as never, publicSignals: [] } }; },
    disconnect: async (o) => { connected.delete(o); },
    ...handlers,
  };
  const open = () => { queueMicrotask(() => serveWallet(full, { opener: opener as never, self: walletSelf as never })); return popup as never; };
  return { open, popup, sent, connected };
}

afterEach(() => { /* each test makes its own windows */ });

describe("hosted wallet", () => {
  it("connects, reports the account and runs approved actions with bigint amounts", async () => {
    const w = walletWindow({});
    const wallet = await connectWallet({ walletOrigin: WALLET, open: w.open });
    expect([wallet.address, wallet.walletId, wallet.network]).toEqual(["ADDR", 1006n, "localnet"]);
    const account = await wallet.account();
    expect(account.balance).toEqual({ microAlgos: 5_000_000n, spendable: 4_800_000n, assets: [{ id: 7n, amount: 3n }] });
    const tx = await wallet.sendAlgo({ to: "RCPT", amount: 250_000n });
    expect(tx).toEqual({ txId: "TX1", groupId: "G1", confirmedRound: 42n, explorerUrl: "https://x/tx/TX1" });
    await wallet.sendAsset({ assetId: 7, to: "RCPT", amount: 2n });
    expect(w.sent).toEqual([{ to: "RCPT", amount: "250000" }, { assetId: "7", to: "RCPT", amount: "2" }]);
    await wallet.disconnect();
    expect(w.connected.size).toBe(0);
    expect(w.popup.closed).toBe(true);
  });

  it("signs in for the origin the wallet saw, whatever the dApp sends", async () => {
    const w = walletWindow({});
    const wallet = await connectWallet({ walletOrigin: WALLET, open: w.open });
    const signIn = await wallet.createSignIn({ nonce: "abcdefgh12345678", statement: "Sign in to Example", origin: "https://other.example" } as never);
    expect(signIn).toMatchObject({ fields: { origin: DAPP, nonce: "abcdefgh12345678" }, signature: "SIG" });
    expect(w.sent).toEqual([{ signInFor: DAPP, nonce: "abcdefgh12345678", statement: "Sign in to Example" }]);
    const error = await wallet.createSignIn({ nonce: "n".repeat(200) }).catch((e) => e);
    expect(isZkAuthError(error, "bad_request")).toBe(true);
  });

  it("passes the user's refusal through as an error", async () => {
    const w = walletWindow({}, { approve: false });
    const error = await connectWallet({ walletOrigin: WALLET, open: w.open }).catch((e) => e);
    expect(isZkAuthError(error, "user_rejected")).toBe(true);
  });

  it("refuses actions from an origin that never connected", async () => {
    const w = walletWindow({ isConnected: () => false, connect: async () => ACCOUNT });
    const wallet = await connectWallet({ walletOrigin: WALLET, open: w.open });
    const error = await wallet.sendAlgo({ to: "RCPT", amount: 1n }).catch((e) => e);
    expect(isZkAuthError(error, "unauthorized")).toBe(true);
  });

  it("ignores messages from another origin and reports a closed wallet window", async () => {
    const w = walletWindow({ connect: () => new Promise(() => {}) });
    const pending = connectWallet({ walletOrigin: WALLET, open: w.open, timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 10));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "algozkauth:response", v: 1, id: "x", result: ACCOUNT }, origin: "https://evil.example", source: w.popup as never }));
    w.popup.closed = true;
    const error = await pending.catch((e) => e);
    expect(isZkAuthError(error, "wallet_closed")).toBe(true);
  });

  it("reports a blocked pop-up", () => {
    expect(() => connectWallet({ walletOrigin: WALLET, open: () => null })).toThrow(/blocked/);
  });
});
