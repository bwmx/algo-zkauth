// serveWallet: the hosted wallet's side of the protocol in ./hosted-protocol.ts.
// The wallet app supplies the handlers (which ask the user and use its own
// embedded session); this module checks who is asking and answers only them.
import { ZkAuthError, isZkAuthError } from "./errors.ts";
import { isRequest, PROTOCOL_VERSION, READY, RESPONSE, type HostedAccount, type HostedMethod, type HostedParams, type HostedTx } from "./hosted-protocol.ts";

export type { HostedAccount, HostedTx, HostedMethod, HostedParams } from "./hosted-protocol.ts";

export type WalletHostHandlers = {
  /** Ask the user whether `origin` may use the wallet; resolve with the account, or throw ZkAuthError("user_rejected"). */
  connect(origin: string, params: HostedParams["connect"]): Promise<HostedAccount>;
  account(origin: string): Promise<HostedAccount>;
  /** Each action must be shown to and approved by the user before it runs. */
  sendAlgo(origin: string, params: HostedParams["sendAlgo"]): Promise<HostedTx>;
  optIn(origin: string, params: HostedParams["optIn"]): Promise<HostedTx>;
  sendAsset(origin: string, params: HostedParams["sendAsset"]): Promise<HostedTx>;
  disconnect(origin: string): Promise<void>;
  /** Origins the user approved earlier (e.g. remembered on this device). */
  isConnected(origin: string): boolean;
};

/** Starts answering the dApp that opened this window. Returns a function that stops it. */
export function serveWallet(handlers: WalletHostHandlers, o: { opener?: Window | null; self?: Window } = {}): () => void {
  const self = o.self ?? window;
  const opener = o.opener === undefined ? self.opener as Window | null : o.opener;
  if (!opener) return () => {};
  let queue: Promise<void> = Promise.resolve();

  const onMessage = (event: MessageEvent) => {
    if (event.source !== opener || !isRequest(event.data)) return;
    const { id, method, params } = event.data;
    const origin = event.origin;
    const reply = (body: { result?: unknown; error?: { code: string; message: string; retryAfter?: number } }) =>
      opener.postMessage({ type: RESPONSE, v: PROTOCOL_VERSION, id, ...body }, origin);
    // One request at a time, so the user sees them in order.
    queue = queue.then(async () => {
      try {
        if (method !== "connect" && !handlers.isConnected(origin)) throw new ZkAuthError("unauthorized", "Connect to the wallet first");
        reply({ result: await dispatch(handlers, origin, method, params) });
      } catch (error) {
        const e = isZkAuthError(error) ? error : new ZkAuthError("service_unavailable", "The wallet could not complete the request");
        reply({ error: { code: e.code, message: e.message, ...(e.retryAfter !== undefined ? { retryAfter: e.retryAfter } : {}) } });
      }
    });
  };
  self.addEventListener("message", onMessage);
  // Nothing secret: it only says the window can take requests. The dApp checks this window's origin.
  opener.postMessage({ type: READY, v: PROTOCOL_VERSION }, "*");
  return () => self.removeEventListener("message", onMessage);
}

const str = (v: unknown, name: string) => {
  if (typeof v !== "string" || !v || v.length > 128) throw new ZkAuthError("bad_request", `Invalid ${name}`);
  return v;
};

async function dispatch(h: WalletHostHandlers, origin: string, method: HostedMethod, raw: unknown): Promise<unknown> {
  const p = (raw ?? {}) as Record<string, unknown>;
  switch (method) {
    case "connect": return h.connect(origin, typeof p.network === "string" ? { network: p.network } : {});
    case "account": return h.account(origin);
    case "sendAlgo": return h.sendAlgo(origin, { to: str(p.to, "recipient"), amount: str(p.amount, "amount") });
    case "optIn": return h.optIn(origin, { assetId: str(p.assetId, "asset id") });
    case "sendAsset": return h.sendAsset(origin, { assetId: str(p.assetId, "asset id"), to: str(p.to, "recipient"), amount: str(p.amount, "amount") });
    case "disconnect": await h.disconnect(origin); return { disconnected: true };
    default: throw new ZkAuthError("bad_request", "Unknown wallet request");
  }
}
