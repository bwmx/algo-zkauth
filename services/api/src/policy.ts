// Per-app request policy: allowed origins (CORS), the sponsor policy
// (operations, actions per session, fees per UTC day) and a per-IP rate limit
// on session creation. All state is in memory and per process.
import { fail } from "./errors.ts";
import type { SponsorPolicy } from "../../../packages/config/src/index.ts";

// ---- Origins and CORS --------------------------------------------------------

export type OriginPolicy = { allowedOrigins: string[] };

/** Throws origin_not_allowed unless the request's Origin is one of the app's. A missing Origin is refused too. */
export function checkOrigin(app: OriginPolicy, origin: string | undefined) {
  if (typeof origin !== "string" || !app.allowedOrigins.includes(origin)) fail("origin_not_allowed");
}

const CORS_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const CORS_HEADERS = "content-type";

/**
 * CORS response headers for an origin configured for some app. Which app the
 * origin may act for is enforced per request by checkOrigin; no credentials are
 * involved, so reading a response grants nothing beyond what the request itself had.
 */
export function corsHeaders(known: ReadonlySet<string>, origin: string | undefined, preflight = false): Record<string, string> {
  const headers: Record<string, string> = { Vary: "Origin" };
  if (typeof origin !== "string" || !known.has(origin)) return headers;
  headers["Access-Control-Allow-Origin"] = origin;
  if (preflight) {
    headers["Access-Control-Allow-Methods"] = CORS_METHODS;
    headers["Access-Control-Allow-Headers"] = CORS_HEADERS;
    headers["Access-Control-Max-Age"] = "600";
  } else {
    headers["Access-Control-Expose-Headers"] = "Retry-After";
  }
  return headers;
}

export const knownOrigins = (apps: OriginPolicy[]) => new Set(apps.flatMap((a) => a.allowedOrigins));

// ---- Sponsor policy ----------------------------------------------------------

type Counted = { actions: number; pendingActions: number };

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const secondsToNextUtcDay = (ms: number) => Math.max(1, Math.ceil((86_400_000 - (ms % 86_400_000)) / 1000));

/**
 * The sponsor's spending per app per UTC day, and each session's action count.
 * A submit reserves its fee and an action before sending and settles them once
 * the group confirms (the actual fee) or fails (released).
 */
export class SponsorQuotas {
  private readonly spent = new Map<string, bigint>();
  constructor(private readonly now: () => number = Date.now) {}

  private key(app: string) { return `${app}|${utcDay(this.now())}`; }
  spentToday(app: string) { return this.spent.get(this.key(app)) ?? 0n; }

  /** Throws quota_exceeded unless the app's sponsor covers this operation and fee now. */
  check(app: { id: string; sponsor: SponsorPolicy }, session: Counted, operation: string, fee: bigint) {
    if (!app.sponsor.operations.includes(operation)) fail("quota_exceeded", "The app's sponsor does not cover this operation");
    if (session.actions + session.pendingActions >= app.sponsor.maxActionsPerSession) fail("quota_exceeded", "This session reached the app's action limit; start a new session");
    if (this.spentToday(app.id) + fee > BigInt(app.sponsor.maxDailyFeeMicroAlgos))
      fail("quota_exceeded", "The app's daily sponsored fees are exhausted", secondsToNextUtcDay(this.now()));
  }

  /** check, then hold the fee and one action until settle(). */
  reserve(app: { id: string; sponsor: SponsorPolicy }, session: Counted, operation: string, fee: bigint) {
    this.check(app, session, operation, fee);
    const key = this.key(app.id);
    this.spent.set(key, (this.spent.get(key) ?? 0n) + fee);
    session.pendingActions++;
    let settled = false;
    return {
      /** Confirmed: count the action and replace the estimate with the actual fee. */
      commit: (actualFee: bigint) => {
        if (settled) return; settled = true;
        session.pendingActions--; session.actions++;
        this.spent.set(key, (this.spent.get(key) ?? 0n) - fee + actualFee);
      },
      /** Not sent or rejected: release both. */
      release: () => {
        if (settled) return; settled = true;
        session.pendingActions--;
        this.spent.set(key, (this.spent.get(key) ?? 0n) - fee);
      },
    };
  }

  /** Drops days before today. */
  prune() {
    const today = utcDay(this.now());
    for (const key of this.spent.keys()) if (!key.endsWith(`|${today}`)) this.spent.delete(key);
  }
}

// ---- Rate limit ----------------------------------------------------------------

/** A fixed-window counter per client address. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Counts one request; throws rate_limited (with retryAfter) past the limit. */
  hit(client: string) {
    const now = this.now();
    let w = this.windows.get(client);
    if (!w || now - w.start >= this.windowMs) { w = { start: now, count: 0 }; this.windows.set(client, w); }
    if (w.count >= this.limit) fail("rate_limited", undefined, Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000)));
    w.count++;
  }

  prune() {
    const now = this.now();
    for (const [client, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(client);
  }
}
