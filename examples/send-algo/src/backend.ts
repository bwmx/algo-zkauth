// Signing in to the dApp's own backend (examples/backend): fetch a challenge,
// have the session (or the hosted wallet) sign it, and post the result. The
// backend checks it against the chain and sets its own session cookie.
import type { SignIn } from "@algozkauth/sdk";

const BACKEND = import.meta.env.VITE_EXAMPLE_BACKEND ?? "http://localhost:8785";

export async function signInToBackend(createSignIn: (o: { nonce: string; statement: string }) => Promise<SignIn>): Promise<{ address: string | null; subject: string }> {
  const { nonce } = await (await fetch(`${BACKEND}/api/nonce`, { credentials: "include" })).json() as { nonce: string };
  const signIn = await createSignIn({ nonce, statement: "Sign in to the AlgoZKAuth example backend" });
  const response = await fetch(`${BACKEND}/api/sign-in`, {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(signIn),
  });
  const body = await response.json() as { address: string | null; subject: string; message?: string };
  if (!response.ok) throw new Error(`The backend refused the sign-in: ${body.message ?? response.status}`);
  // The cookie is what the backend trusts from now on.
  const me = await (await fetch(`${BACKEND}/api/me`, { credentials: "include" })).json() as { address: string | null; subject: string };
  return me;
}
