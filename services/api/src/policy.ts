// Per-app request policy: allowed origins (CORS), the sponsor policy
// (operations, actions per session, fees per UTC day), the wallet faucet's
// budget and a per-IP rate limit. All state is in memory and per process.
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

// ---- Wallet faucet -------------------------------------------------------------

/**
 * The wallet faucet's limits in this process: a total per UTC day across all apps,
 * and the wallets it has paid or is paying. reserve() takes both at once, with no
 * await in between, so concurrent claims for one wallet cannot both pass; release()
 * returns them when the payment is not sent. The api adds the rules that survive a
 * restart (the wallet's balance and the sponsor's own payment history).
 */
export class FaucetBudget {
  private readonly spent = new Map<string, bigint>();
  private readonly paid = new Set<string>();
  constructor(readonly amount: bigint, readonly daily: bigint, private readonly now: () => number = Date.now) {
    if (amount <= 0n || daily < amount) throw new RangeError("The faucet's daily total must cover at least one claim");
  }

  spentToday() { return this.spent.get(utcDay(this.now())) ?? 0n; }
  has(wallet: string) { return this.paid.has(wallet); }
  /** Records a wallet paid before (found on chain), so later requests stop at check(). */
  remember(wallet: string) { this.paid.add(wallet); }

  /** Throws quota_exceeded if this wallet was paid, or if one more claim would pass today's total. */
  check(wallet: string) {
    if (this.paid.has(wallet)) fail("quota_exceeded", "This wallet already received test ALGO from the faucet");
    if (this.spentToday() + this.amount > this.daily)
      fail("quota_exceeded", "The faucet's daily total is spent; try again tomorrow", secondsToNextUtcDay(this.now()));
  }

  /** check, then hold the wallet and one claim's amount until the payment settles. */
  reserve(wallet: string) {
    this.check(wallet);
    const day = utcDay(this.now());
    this.spent.set(day, (this.spent.get(day) ?? 0n) + this.amount);
    this.paid.add(wallet);
    let settled = false;
    return {
      commit: () => { settled = true; },
      /** Not sent: the wallet may claim again and the amount returns to its day. */
      release: () => {
        if (settled) return; settled = true;
        this.paid.delete(wallet);
        this.spent.set(day, (this.spent.get(day) ?? 0n) - this.amount);
      },
    };
  }

  /** Drops days before today. Paid wallets are kept: at most a day's total divided by the amount, per day. */
  prune() {
    const today = utcDay(this.now());
    for (const day of this.spent.keys()) if (day !== today) this.spent.delete(day);
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
