// The sign-in flow: session key -> POST /v1/sessions -> provider login -> verified identity.
import { browserSessionNonce, fromBase64Url, toBase64Url } from "@bwmx/algo-zkauth-protocol";
import type { Identity } from "@bwmx/algo-zkauth-protocol";
import type { Ctx, LoginOutcome } from "./context.ts";
import { ZkAuthError } from "./errors.ts";
import { defaultLogin, resolveButton } from "./login.ts";
import type { LoginHandler, SignInOptions } from "./types.ts";
import { nowSeconds, sleep } from "./util.ts";

type SessionWire = { sessionId: string; app: string; provider: string; expiresAt: number; loggedIn: boolean; identity?: Identity; loginError?: string };
type Created = { sessionId: string; nonce: string; expiresAt: number; networkTime?: number; loginFlow: "in-page" | "code"; authorizeUrl?: string };

/**
 * Must be called synchronously from the click handler: a code-flow login window opened after an `await`
 * is blocked by pop-up blockers, so it is opened empty here and pointed at the provider later.
 */
export function openLoginWindow(config: Ctx["config"] | undefined, provider: string | undefined, handler: LoginHandler | undefined): Window | null {
  if (typeof window === "undefined" || handler || !config || config.loginFlow !== "code") return null;
  if (provider !== undefined && provider !== config.provider) return null;
  return window.open("", "algozkauth-login", "popup,width=600,height=760");
}

export async function startLogin(ctx: Ctx, provider: string | undefined, o: SignInOptions, popup: Window | null): Promise<LoginOutcome> {
  const { api, config } = ctx;
  const providerId = provider ?? config.provider;
  try {
    if (!config.providers.includes(providerId)) throw new ZkAuthError("provider_unsupported", `This app does not offer ${providerId} sign-in`);
    const handler = o.login ?? ctx.options.login;
    const button = resolveButton(o.button);

    const key = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
    const randomness = crypto.getRandomValues(new Uint8Array(32));
    const created = await api.post<Created>("/v1/sessions", {
      app: config.app, provider: providerId, sessionPublicKey: toBase64Url(publicKey), randomness: toBase64Url(randomness),
    }, o.signal);
    const sessionId = created.sessionId;
    // Session times are on the network's clock, which a dev-mode LocalNet lets drift from this device's.
    const clockSkew = typeof created.networkTime === "number" ? created.networkTime - nowSeconds() : 0;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // The provider signs this nonce: recompute it so the service cannot bind someone else's key.
      const nonce = await browserSessionNonce({ genesisHash: fromBase64Url(config.genesisHash, 32), sessionPublicKey: publicKey, expiresAt: created.expiresAt, randomness });
      if (nonce !== created.nonce) throw new ZkAuthError("nonce_mismatch", "The service's login nonce does not bind this page's session key");

      if (created.loginFlow !== "code" || handler) { if (popup && !popup.closed) popup.close(); popup = null; }
      const result = await (handler ?? defaultLogin)({
        provider: providerId, config, flow: created.loginFlow, nonce, ...(created.authorizeUrl ? { authorizeUrl: created.authorizeUrl } : {}),
        ...(button ? { button } : {}), ...(popup ? { popup } : {}), signal: abort.signal,
      });
      let session: SessionWire;
      if (typeof result === "string") {
        session = await api.post<SessionWire>(`/v1/sessions/${sessionId}/token`, { idToken: result }, o.signal);
      } else {
        session = await pollLogin(ctx, sessionId, created.expiresAt - clockSkew, result ?? (popup ? { get closed() { return popup!.closed; } } : undefined), o.signal);
      }
      if (!session.loggedIn || !session.identity) throw loginError(session);
      return { sessionId, provider: providerId, identity: session.identity, expiresAt: session.expiresAt ?? created.expiresAt, clockSkew, key, publicKey: toBase64Url(publicKey) };
    } catch (error) {
      void api.delete(`/v1/sessions/${sessionId}`).catch(() => {});
      throw error;
    } finally {
      o.signal?.removeEventListener("abort", onAbort);
      abort.abort();
    }
  } catch (error) {
    if (popup && !popup.closed) popup.close();
    throw error;
  }
}

function loginError(session: SessionWire): ZkAuthError {
  const code = session.loginError;
  if (code === "login_consumed" || code === "token_invalid" || code === "provider_unsupported") return new ZkAuthError(code, "The provider login was rejected");
  return new ZkAuthError("token_invalid", "The provider login did not complete");
}

async function pollLogin(ctx: Ctx, sessionId: string, expiresAt: number, handle: { closed: boolean } | undefined, signal?: AbortSignal): Promise<SessionWire> {
  let closedPolls = 0;
  for (;;) {
    const session = await ctx.api.get<SessionWire>(`/v1/sessions/${sessionId}`, signal);
    if (session.loggedIn) return session;
    if (session.loginError) throw loginError(session);
    if (handle?.closed && ++closedPolls >= 2) throw new ZkAuthError("login_cancelled", "The login window was closed before sign-in finished");
    if (nowSeconds() >= expiresAt) throw new ZkAuthError("login_timeout", "Sign-in took too long; try again");
    await sleep(ctx.pollMs, signal);
  }
}
