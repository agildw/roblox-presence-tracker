/**
 * Adaptive polling helper.
 *
 * When the limiter reports throttling, the base poll/sync interval is stretched
 * by the limiter's current slow-down multiplier — and stretched only once,
 * because the factor is a property of the limiter rather than something this
 * helper accumulates.
 */

import type { RobloxRateLimiter } from './ratelimit.js';
import { RateLimitRejection } from './ratelimit.js';

/**
 * Applies the limiter's current slow-down factor to a base interval.
 * Returns both the adapted interval and the factor for logging.
 */
export function adaptInterval(
  baseMs: number,
  limiter: RobloxRateLimiter,
): { intervalMs: number; multiplier: number } {
  const multiplier = limiter.intervalMultiplier();
  return { intervalMs: Math.round(baseMs * multiplier), multiplier };
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