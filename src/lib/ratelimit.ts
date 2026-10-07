/**
 * Global rate limiter for every Roblox API request.
 *
 * Roblox throttles per IP *and* per session, and it reacts badly to bursts —
 * the presence cycle and the friend-sync cycle running in parallel was enough to
 * trip it permanently. Every Roblox call therefore funnels through one shared
 * limiter:
 *
 *  - **concurrency 1** — no two Roblox requests are ever in flight together
 *  - **token bucket** — a sustained ceiling (`maxRequestsPerMinute`) with a
 *    tiny burst allowance
 *  - **circuit breaker** — a 429 opens a global cooldown that escalates while
 *    throttle responses keep arriving, and decays after sustained success
 *  - **bounded waiting** — cycle requests give up quickly (their cycle ends and
 *    the worker reschedules); interactive command requests wait longer and jump
 *    the queue so a command is never starved by a poll cycle
 *
 * `robloxRateLimiter` is the process-wide instance built from `env`; the class
 * is exported so callers can build an isolated limiter with explicit settings.
 */

import { env } from './env.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** `interactive` = driven by a Telegram command; `cycle` = driven by a worker. */
export type RequestPriority = 'interactive' | 'cycle';

/** Why a request never obtained a slot. */
export type RejectionReason = 'cooldown' | 'timeout';

export class RateLimitRejection extends Error {
  constructor(
    public readonly reason: RejectionReason,
    public readonly retryInMs: number,
    message: string,
  ) {
    super(message);
    this.name = 'RateLimitRejection';
  }
}

export type RateLimiterSnapshot = {
  queueLength: number;
  inFlight: boolean;
  cooldownRemainingMs: number;
  penaltyLevel: number;
  availableTokens: number;
  intervalMultiplier: number;
};

export interface RateLimiterOptions {
  /** Sustained request ceiling, shared by every Roblox call. */
  maxRequestsPerMinute: number;
  /** Instant burst allowance on top of the sustained rate. */
  burstMax: number;
  /** How long a cycle request waits for a slot before it is rejected. */
  cycleMaxWaitMs: number;
  /** How long an interactive request waits for a slot before it is rejected. */
  interactiveMaxWaitMs: number;
  /** Minimum cooldown opened by a 429. */
  cooldownMs: number;
  /** Ceiling for the escalating cooldown. */
  cooldownMaxMs: number;
  /** Max slow-down factor applied to poll intervals. */
  adaptiveMaxMultiplier: number;
  /** Clean uptime required before each penalty level is forgiven. */
  adaptiveRecoverMs: number;
}

interface Waiter {
  priority: RequestPriority;
  settled: boolean;
  timer: NodeJS.Timeout | undefined;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_PENALTY_LEVEL = 6;

/**
 * Default instant burst allowance. Roblox answered ~6 rapid-fire anonymous
 * presence calls before throttling, so keep the burst well below that; beyond
 * the burst, requests are spaced by the sustained rate.
 */
export const DEFAULT_BURST_MAX = 3;

// ── Limiter ───────────────────────────────────────────────────────────────────

export class RobloxRateLimiter {
  private readonly options: RateLimiterOptions;
  /** Sustained rate, tokens per millisecond. */
  private readonly ratePerMs: number;

  private tokens: number;
  private lastRefill = Date.now();
  private inFlight = false;
  private queue: Waiter[] = [];
  private pumpTimer: NodeJS.Timeout | undefined = undefined;

  private cooldownUntil = 0;
  private penaltyLevel = 0;
  private cleanSince = 0;

  constructor(options: RateLimiterOptions) {
    this.options = options;
    this.ratePerMs = options.maxRequestsPerMinute / 60_000;
    this.tokens = options.burstMax;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Waits for a slot, runs `fn`, then releases the slot.
   * Rejects with {@link RateLimitRejection} if the slot does not arrive within
   * the priority's patience budget.
   */
  async withSlot<T>(priority: RequestPriority, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(priority);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Records a successful call, decaying one throttle-penalty level per
   * `adaptiveRecoverMs` of clean uptime.
   */
  reportSuccess(): void {
    if (this.penaltyLevel === 0) return;

    const now = Date.now();
    if (this.cleanSince === 0) {
      this.cleanSince = now;
      return;
    }
    if (now - this.cleanSince < this.options.adaptiveRecoverMs) return;

    this.penaltyLevel -= 1;
    this.cleanSince = now;
    console.log(
      `[RateLimit] Throttle penalty eased to level ${this.penaltyLevel} ` +
        `(poll interval ×${this.intervalMultiplier().toFixed(1)}).${this.describe()}`,
    );
  }

  /**
   * Records a 429: opens (or extends) the global cooldown, escalating it with
   * each consecutive throttle hit. `retryAfterMs` is Roblox's `Retry-After`
   * when present; it raises the floor but is not trusted as the whole penalty,
   * because Roblox frequently omits it and the real penalty outlives it.
   */
  reportRateLimit(retryAfterMs?: number): void {
    const now = Date.now();
    this.penaltyLevel = Math.min(this.penaltyLevel + 1, MAX_PENALTY_LEVEL);
    this.cleanSince = 0;

    const { cooldownMs, cooldownMaxMs } = this.options;
    const escalated = Math.min(cooldownMs * Math.pow(2, this.penaltyLevel - 1), cooldownMaxMs);
    const wait = Math.max(escalated, cooldownMs, retryAfterMs ?? 0);

    // Only ever extend an active cooldown, never shorten it.
    this.cooldownUntil = Math.max(this.cooldownUntil, now + wait);

    console.warn(
      `[RateLimit] Global cooldown ${(wait / 1000).toFixed(1)}s opened ` +
        `(retry-after=${retryAfterMs === undefined ? 'absent' : `${(retryAfterMs / 1000).toFixed(0)}s`}, ` +
        `penalty=${this.penaltyLevel}, poll interval ×${this.intervalMultiplier().toFixed(1)}).${this.describe()}`,
    );
  }

  /** Current poll-interval slow-down factor (1 = unthrottled). */
  intervalMultiplier(): number {
    return Math.min(1 + this.penaltyLevel, this.options.adaptiveMaxMultiplier);
  }

  snapshot(): RateLimiterSnapshot {
    this.refill(Date.now());
    return {
      queueLength: this.queue.length,
      inFlight: this.inFlight,
      cooldownRemainingMs: Math.max(0, this.cooldownUntil - Date.now()),
      penaltyLevel: this.penaltyLevel,
      availableTokens: Math.floor(this.tokens),
      intervalMultiplier: this.intervalMultiplier(),
    };
  }

  /** Compact one-line state summary for logs. */
  describe(): string {
    const s = this.snapshot();
    return (
      ` [queue=${s.queueLength} inFlight=${s.inFlight ? 1 : 0} tokens=${s.availableTokens} ` +
      `cooldown=${Math.ceil(s.cooldownRemainingMs / 1000)}s penalty=${s.penaltyLevel} interval=x${s.intervalMultiplier.toFixed(1)}]`
    );
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private acquire(priority: RequestPriority): Promise<() => void> {
    const maxWaitMs =
      priority === 'interactive' ? this.options.interactiveMaxWaitMs : this.options.cycleMaxWaitMs;

    // Executor form deliberately: Promise.withResolvers() is ES2024 (Node 22+),
    // and this project also supports Node 20.
    const waiter: Waiter = {
      priority,
      settled: false,
      timer: undefined,
      resolve: () => undefined,
      reject: () => undefined,
    };

    const promise = new Promise<() => void>((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });

    waiter.timer = setTimeout(() => {
      if (waiter.settled) return;
      waiter.settled = true;
      this.remove(waiter);

      const cooldown = Math.max(0, this.cooldownUntil - Date.now());
      waiter.reject(
        new RateLimitRejection(
          cooldown > 0 ? 'cooldown' : 'timeout',
          this.waitMs(),
          cooldown > 0
            ? `Roblox throttled us; ${Math.ceil(cooldown / 1000)}s of cooldown remaining.`
            : `Roblox request queue saturated; gave up after ${maxWaitMs}ms.`,
        ),
      );
    }, maxWaitMs);

    this.queue.push(waiter);
    this.pump();
    return promise;
  }

  private release(): void {
    this.inFlight = false;
    this.pump();
  }

  /** Grants the next slot when one is available; otherwise re-arms itself. */
  private pump(): void {
    if (this.inFlight || this.queue.length === 0) return;

    const wait = this.waitMs();
    if (wait > 0) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = setTimeout(() => {
        this.pumpTimer = undefined;
        this.pump();
      }, wait);
      return;
    }

    const index = this.pickIndex();
    const waiter = this.queue.splice(index, 1)[0];
    if (!waiter) return;
    if (waiter.settled) {
      this.pump();
      return;
    }

    waiter.settled = true;
    clearTimeout(waiter.timer);

    this.tokens = Math.max(0, this.tokens - 1);
    this.inFlight = true;
    waiter.resolve(() => this.release());
  }

  /** Interactive requests jump the queue so commands are not starved by polls. */
  private pickIndex(): number {
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i]?.priority === 'interactive') return i;
    }
    return 0;
  }

  private remove(waiter: Waiter): void {
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
  }

  /** Milliseconds until a slot may be granted (cooldown gate + token spacing). */
  private waitMs(): number {
    const now = Date.now();
    this.refill(now);

    const cooldown = Math.max(0, this.cooldownUntil - now);
    const tokenWait = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.ratePerMs);
    return Math.max(cooldown, tokenWait);
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(this.options.burstMax, this.tokens + elapsed * this.ratePerMs);
  }
}

/** Process-wide limiter, configured from the environment. */
export const robloxRateLimiter = new RobloxRateLimiter({
  maxRequestsPerMinute: env.ROBLOX_MAX_REQUESTS_PER_MINUTE,
  burstMax: DEFAULT_BURST_MAX,
  cycleMaxWaitMs: env.ROBLOX_CYCLE_MAX_WAIT_MS,
  interactiveMaxWaitMs: env.ROBLOX_INTERACTIVE_MAX_WAIT_MS,
  cooldownMs: env.ROBLOX_COOLDOWN_MS,
  cooldownMaxMs: env.ROBLOX_COOLDOWN_MAX_MS,
  adaptiveMaxMultiplier: env.ROBLOX_ADAPTIVE_MAX_MULTIPLIER,
  adaptiveRecoverMs: env.ROBLOX_ADAPTIVE_RECOVER_MS,
});