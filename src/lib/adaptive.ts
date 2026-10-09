/**
 * Adaptive polling helper.
 *
 * The throttle penalty is owned by the limiter and cleared only after a clean
 * cycle (`reportCycleClean`), so these helpers stay pure lookups.
 */

import type { RobloxRateLimiter } from './ratelimit.js';
import { RateLimitRejection } from './ratelimit.js';

/** Applies the limiter's current slow-down factor to a base interval. */
export function adaptInterval(
  baseMs: number,
  limiter: RobloxRateLimiter,
): { intervalMs: number; multiplier: number } {
  const multiplier = limiter.intervalMultiplier();
  return { intervalMs: Math.round(baseMs * multiplier), multiplier };
}

/**
 * How long to wait before the next cycle: the adaptive interval, but never
 * shorter than the limiter's remaining cooldown. Starting a cycle inside a
 * cooldown only burns a cycle and produces a zero-data poll.
 */
export function scheduleDelayMs(
  baseMs: number,
  limiter: RobloxRateLimiter,
): { delayMs: number; multiplier: number; cooldownRemainingMs: number } {
  const { intervalMs, multiplier } = adaptInterval(baseMs, limiter);
  const cooldownRemainingMs = limiter.snapshot().cooldownRemainingMs;
  return { delayMs: Math.max(intervalMs, cooldownRemainingMs), multiplier, cooldownRemainingMs };
}

/**
 * Formats an error for a worker cycle log, including the throttled-backoff
 * interval when the failure came from the shared cooldown.
 */
export function describeCycleFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof RateLimitRejection) {
    return `${message} (backing off ${Math.ceil(err.retryInMs / 1000)}s)`;
  }
  return message;
}