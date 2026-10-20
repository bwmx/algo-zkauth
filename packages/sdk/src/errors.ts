import type { ZkAuthErrorCode } from "./types.ts";

/** Codes the service can return (openapi ErrorCode). Anything else is treated as service_unavailable. */
export const SERVICE_CODES: ReadonlySet<string> = new Set([
  "bad_request", "unauthorized", "not_found", "origin_not_allowed", "app_unknown", "provider_unsupported",
  "session_expired", "not_signed_in", "login_consumed", "token_invalid", "salt_required", "salt_conflict",
  "proof_pending", "proof_failed", "key_inactive", "key_pending_delay", "registry_paused", "wallet_exists",
  "not_enrolled", "plan_expired", "plan_mismatch", "replay", "insufficient_funds", "quota_exceeded",
  "rate_limited", "service_unavailable",
]);

const RETRYABLE: ReadonlySet<ZkAuthErrorCode> = new Set([
  "key_pending_delay", "rate_limited", "service_unavailable", "proof_pending", "timeout", "plan_expired", "quota_exceeded",
]);

export class ZkAuthError extends Error {
  readonly code: ZkAuthErrorCode;
  readonly retryAfter?: number;
  readonly status?: number;

  constructor(code: ZkAuthErrorCode, message: string, o: { retryAfter?: number; status?: number; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = "ZkAuthError";
    this.code = code;
    if (o.retryAfter !== undefined) this.retryAfter = o.retryAfter;
    if (o.status !== undefined) this.status = o.status;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

export const isZkAuthError = (error: unknown, code?: ZkAuthErrorCode): error is ZkAuthError =>
  error instanceof ZkAuthError && (code === undefined || error.code === code);

/** Maps a service error body (or bare HTTP status) to a ZkAuthError. */
export function errorFromResponse(status: number, body: unknown, retryAfterHeader: string | null): ZkAuthError {
  const e = (body as { error?: { code?: unknown; message?: unknown; retryAfter?: unknown } } | null)?.error;
  let code: ZkAuthErrorCode;
  if (typeof e?.code === "string" && SERVICE_CODES.has(e.code)) code = e.code as ZkAuthErrorCode;
  else if (status === 429) code = "rate_limited";
  else if (status === 404) code = "not_found";
  else if (status === 401) code = "unauthorized";
  else if (status === 403) code = "origin_not_allowed";
  else if (status >= 500) code = "service_unavailable";
  else code = "bad_request";
  const header = retryAfterHeader && /^\d{1,6}$/.test(retryAfterHeader) ? Number(retryAfterHeader) : undefined;
  const retryAfter = typeof e?.retryAfter === "number" && Number.isFinite(e.retryAfter) ? e.retryAfter : header;
  const message = typeof e?.message === "string" && e.message ? e.message : `AlgoZKAuth service error (${code})`;
  return new ZkAuthError(code, message, { status, ...(retryAfter === undefined ? {} : { retryAfter }) });
}
