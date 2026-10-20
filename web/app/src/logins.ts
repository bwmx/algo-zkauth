// In-page sign-in (login flow "in-page"): the provider's own script returns the
// nonce-bound ID token to this tab, which sends it to the local server. Each
// such provider needs an adapter here. Code-flow providers need none: they sign
// in through a login window and the server exchanges the code, so the token
// never reaches this tab.
import type { ProviderId } from "./types";

declare global {
  interface Window { google?: any }
}

export type InPageLogin = {
  load(): Promise<void>;
  render(container: HTMLElement | null | undefined, options: { clientId: string; nonce: string; onToken(token: string): void }): void;
};

const googleIdentityServices: InPageLogin = {
  load() {
    if (window.google?.accounts?.id) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Google sign-in library failed to load"));
      document.head.append(script);
    });
  },
  render(container, { clientId, nonce, onToken }) {
    window.google.accounts.id.initialize({
      client_id: clientId, nonce, auto_select: false,
      callback: ({ credential }: { credential: string }) => onToken(credential),
    });
    container?.replaceChildren();
    if (container) window.google.accounts.id.renderButton(container, { theme: "outline", size: "large", text: "signin_with" });
  },
};

export const IN_PAGE_LOGINS: Partial<Record<ProviderId, InPageLogin>> = { google: googleIdentityServices };

export function inPageLogin(provider: ProviderId): InPageLogin {
  const login = IN_PAGE_LOGINS[provider];
  if (!login) throw new Error(`No in-page sign-in for ${provider}`);
  return login;
}
