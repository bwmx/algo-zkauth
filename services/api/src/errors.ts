// Typed API errors (openapi ErrorCode) with static messages. Nothing from a
// request, a token, an SDK trace or an identifier is ever copied into a message.
import { ChainError } from "../../../packages/chain/src/errors.ts";
import type { ChainErrorCode } from "../../../packages/chain/src/types.ts";

export const ERROR_CODES = [
  "bad_request", "unauthorized", "not_found", "origin_not_allowed", "app_unknown", "provider_unsupported", "session_expired", "not_signed_in",
  "login_consumed", "token_invalid", "salt_required", "salt_conflict", "proof_pending", "proof_failed", "key_inactive",
  "key_pending_delay", "registry_paused", "wallet_exists", "not_enrolled", "plan_expired", "plan_mismatch", "replay",
  "insufficient_funds", "quota_exceeded", "rate_limited", "service_unavailable",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const STATUS: Record<ErrorCode, number> = {
  bad_request: 400, unauthorized: 401, not_found: 404, origin_not_allowed: 403, app_unknown: 404, provider_unsupported: 400,
  session_expired: 401, not_signed_in: 401, login_consumed: 409, token_invalid: 401, salt_required: 409, salt_conflict: 409,
  proof_pending: 409, proof_failed: 422, key_inactive: 403, key_pending_delay: 403, registry_paused: 503, wallet_exists: 409,
  not_enrolled: 409, plan_expired: 410, plan_mismatch: 409, replay: 409, insufficient_funds: 409, quota_exceeded: 429,
  rate_limited: 429, service_unavailable: 503,
};

/** The default message of each code. Call sites may pass another static string literal. */
export const MESSAGES: Record<ErrorCode, string> = {
  bad_request: "The request is not valid",
  unauthorized: "The request is not authorized",
  not_found: "No such resource",
  origin_not_allowed: "This origin is not allowed for the app",
  app_unknown: "Unknown app",
  provider_unsupported: "The login provider is not supported for this app",
  session_expired: "The session expired or is unknown; sign in again",
  not_signed_in: "Sign in first",
  login_consumed: "This session's login was already used; start a new session",
  token_invalid: "The ID token is not valid for this session",
  salt_required: "Bind the wallet salt first",
  salt_conflict: "The session is bound to another salt; start a new session to change it",
  proof_pending: "The proof is not ready",
  proof_failed: "The proof failed",
  key_inactive: "The provider's signing key is not active on chain",
  key_pending_delay: "The provider's signing key is waiting out its approval delay",
  registry_paused: "The provider's key registry is paused",
  wallet_exists: "The wallet already exists",
  not_enrolled: "The wallet is not enrolled",
  plan_expired: "The action plan expired; prepare it again",
  plan_mismatch: "The action does not match the plan",
  replay: "The action was already submitted",
  insufficient_funds: "The wallet or sponsor has insufficient funds",
  quota_exceeded: "The app's sponsor quota is exhausted",
  rate_limited: "Too many requests; retry later",
  service_unavailable: "The service is temporarily unavailable",
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfter: number | undefined;
  constructor(code: ErrorCode, message: string = MESSAGES[code], retryAfter?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code];
    this.retryAfter = retryAfter;
  }
}

export const fail = (code: ErrorCode, message?: string, retryAfter?: number): never => { throw new ApiError(code, message, retryAfter); };

const CHAIN: Record<ChainErrorCode, ErrorCode> = {
  key_inactive: "key_inactive",
  key_pending_delay: "key_pending_delay",
  registry_paused: "registry_paused",
  session_expired: "session_expired",
  invalid_proof: "proof_failed",
  // A proof bound to another network or audience is a failed proof for this app.
  wrong_network: "proof_failed",
  wrong_audience: "proof_failed",
  wallet_exists: "wallet_exists",
  not_enrolled: "not_enrolled",
  replay: "replay",
  insufficient_funds: "insufficient_funds",
  // Validation and node rejections; callers validate requests first, so this is a bad action.
  rejected: "bad_request",
};

const CHAIN_MESSAGES: Partial<Record<ChainErrorCode, string>> = {
  session_expired: "The proof's session expired or is not yet active; sign in again",
  invalid_proof: "The proof is invalid",
  wrong_network: "The proof is bound to another network",
  wrong_audience: "The proof is bound to another app",
  rejected: "The action was rejected",
  replay: "The wallet's action nonce changed; prepare a new action",
};

/** Any failure as an ApiError. Unknown errors become service_unavailable; their text is dropped. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ChainError) {
    const code = CHAIN[error.code] ?? "service_unavailable";
    return new ApiError(code, CHAIN_MESSAGES[error.code] ?? MESSAGES[code]);
  }
  return new ApiError("service_unavailable");
}

export const errorBody = (error: ApiError) => ({
  error: { code: error.code, message: error.message, ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}) },
});
