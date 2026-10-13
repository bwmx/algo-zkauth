import type { Config, ProofStatus, ProviderId } from "./types";

// The JSON API of scripts/phase6-server.mjs. Requests are same-origin; the
// server checks Origin and Content-Type before reading any POST body.
export async function getConfig(provider: ProviderId): Promise<Config> {
  const response = await fetch(`/demo/config?provider=${provider}`, { cache: "no-store" });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "TestNet deployment configuration unavailable");
  return value;
}

export async function post<T>(path: string, sessionId: string | undefined, data: object = {}): Promise<T> {
  const response = await fetch(`/demo/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...data }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Local demo request failed");
  return value;
}

export async function proofStatus(jobId: string, sessionId: string): Promise<ProofStatus> {
  const response = await fetch(`/demo/proof/${jobId}`, { headers: { "X-Demo-Session": sessionId }, cache: "no-store" });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Proof status unavailable");
  return value;
}
