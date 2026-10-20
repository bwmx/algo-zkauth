import { ZkAuthError, errorFromResponse } from "./errors.ts";

/** Minimal JSON client for services/api/openapi.yaml. Errors become ZkAuthError. */
export class Api {
  readonly base: string;
  private readonly fetchFn: () => typeof fetch;

  constructor(service: string, fetchOption?: typeof fetch) {
    this.base = service.replace(/\/+$/, "");
    this.fetchFn = () => fetchOption ?? globalThis.fetch.bind(globalThis);
  }

  async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn()(`${this.base}${path}`, {
        method,
        headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      if (signal?.aborted) throw new ZkAuthError("login_cancelled", "The request was cancelled", { cause });
      throw new ZkAuthError("service_unavailable", "Could not reach the AlgoZKAuth service", { cause });
    }
    let json: unknown = null;
    if (response.status !== 204) {
      try { json = await response.json(); } catch { json = null; }
    }
    if (!response.ok) throw errorFromResponse(response.status, json, response.headers.get("retry-after"));
    return json as T;
  }

  get = <T>(path: string, signal?: AbortSignal) => this.request<T>("GET", path, undefined, signal);
  post = <T>(path: string, body?: unknown, signal?: AbortSignal) => this.request<T>("POST", path, body ?? {}, signal);
  put = <T>(path: string, body: unknown) => this.request<T>("PUT", path, body);
  delete = <T>(path: string) => this.request<T>("DELETE", path);
}
