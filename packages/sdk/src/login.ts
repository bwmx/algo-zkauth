// Default login UI. Everything here can be replaced with ZkAuthOptions.login / SignInOptions.login.
import { ZkAuthError } from "./errors.ts";
import type { LoginContext, LoginHandler } from "./types.ts";

type GoogleId = {
  initialize(o: { client_id: string; nonce: string; auto_select: boolean; callback(r: { credential: string }): void }): void;
  renderButton(el: HTMLElement, o: Record<string, unknown>): void;
  cancel?(): void;
};
const googleId = (): GoogleId | undefined => (globalThis as unknown as { google?: { accounts?: { id?: GoogleId } } }).google?.accounts?.id;

const GIS_URL = "https://accounts.google.com/gsi/client";

export function loadGoogleIdentityServices(): Promise<void> {
  if (googleId()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new ZkAuthError("service_unavailable", "Google sign-in library failed to load"));
    document.head.append(script);
  });
}

/** A minimal modal that hosts the provider's button when the dApp did not supply an element. */
function overlay(onCancel: () => void): { container: HTMLElement; remove(): void } {
  const backdrop = document.createElement("div");
  backdrop.setAttribute("style", "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);font:14px system-ui,sans-serif");
  const card = document.createElement("div");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "Sign in");
  card.setAttribute("style", "background:#fff;color:#111;border-radius:12px;padding:24px;min-width:280px;display:flex;flex-direction:column;gap:16px;align-items:center");
  const title = document.createElement("div");
  title.textContent = "Sign in to continue";
  title.setAttribute("style", "font-weight:600");
  const container = document.createElement("div");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.setAttribute("style", "background:none;border:0;color:#555;cursor:pointer;text-decoration:underline");
  cancel.addEventListener("click", onCancel);
  card.append(title, container, cancel);
  backdrop.append(card);
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop);
  return { container, remove() { document.removeEventListener("keydown", onKey); backdrop.remove(); } };
}

/** In-page flow for Google: Google Identity Services returns the nonce-bound ID token to this page. */
const googleInPage: LoginHandler = async (ctx) => {
  await loadGoogleIdentityServices();
  const gis = googleId();
  if (!gis) throw new ZkAuthError("service_unavailable", "Google sign-in library is unavailable");
  return new Promise<string>((resolve, reject) => {
    let ui: { remove(): void } | undefined;
    const finish = (fn: () => void) => { ctx.signal.removeEventListener("abort", cancel); ui?.remove(); fn(); };
    const cancel = () => finish(() => { gis.cancel?.(); reject(new ZkAuthError("login_cancelled", "Sign-in was cancelled")); });
    ctx.signal.addEventListener("abort", cancel, { once: true });
    let host = ctx.button;
    if (!host) { const o = overlay(cancel); ui = o; host = o.container; }
    gis.initialize({ client_id: ctx.config.clientId, nonce: ctx.nonce, auto_select: false, callback: ({ credential }) => finish(() => resolve(credential)) });
    host.replaceChildren();
    gis.renderButton(host, { theme: "outline", size: "large", text: "signin_with" });
  });
};

/** Code flow: the provider login runs in a window and the service exchanges the code; the token never reaches this page. */
const codeWindow: LoginHandler = async (ctx) => {
  if (!ctx.authorizeUrl) throw new ZkAuthError("service_unavailable", "The service did not return a login URL");
  const popup = ctx.popup ?? window.open(ctx.authorizeUrl, "algozkauth-login", "popup,width=600,height=760");
  if (!popup) throw new ZkAuthError("popup_blocked", "Allow pop-ups for this site to sign in");
  if (ctx.popup) ctx.popup.location.href = ctx.authorizeUrl;
  ctx.signal.addEventListener("abort", () => popup.close(), { once: true });
  return popup;
};

export const defaultLogin: LoginHandler = async (ctx: LoginContext) => {
  if (ctx.flow === "code") return codeWindow(ctx);
  if (ctx.provider === "google") return googleInPage(ctx);
  throw new ZkAuthError("provider_unsupported", `No built-in in-page sign-in for ${ctx.provider}; pass a login handler`);
};

export function resolveButton(button: HTMLElement | string | undefined): HTMLElement | undefined {
  if (typeof button !== "string") return button;
  const el = document.querySelector<HTMLElement>(button);
  if (!el) throw new ZkAuthError("bad_request", `Sign-in button element not found: ${button}`);
  return el;
}
