/**
 * HTTP helper built on top of axios for Roblox endpoints.
 *
 * Every request funnels through the global limiter (`robloxRateLimiter`) so that
 * presence polling, friend sync, and command-driven lookups share one
 * concurrency-1 queue, one token bucket, and one throttle/quarantine state.
 *
 * Retry policy:
 *  - 4xx (other than 429): never retried
 *  - 5xx / network: exponential backoff with equal jitter
 *  - 429: reported to the limiter, which opens a global cooldown.
 *      * cycle calls do not retry — the cycle ends and the worker reschedules
 *        after the cooldown, so a single throttle cannot cascade
 *      * interactive (command) calls retry a couple of times, honouring
 *        `Retry-After` when Roblox sends it (it often does not)
 */

import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosError,
} from 'axios';
import { env } from './env.js';
import { robloxRateLimiter, RateLimitRejection, type RequestPriority } from './ratelimit.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RobloxRequestContext {
  /** Short tag used in retry logs, e.g. `presence 1/3`. */
  label: string;
  /** Defaults to `cycle`. Command-driven calls pass `interactive`. */
  priority?: RequestPriority;
  /** Retry 429s inline. Worker cycles leave this off and reschedule instead. */
  retryOn429?: boolean;
}

// ── Clients ───────────────────────────────────────────────────────────────────

/**
 * Creates an axios instance pre-configured with the .ROBLOSECURITY cookie and
 * sensible defaults (10 s timeout, JSON content-type).
 */
export function createRobloxClient(cookie: string): AxiosInstance {
  return axios.create({
    timeout: 10_000,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `.ROBLOSECURITY=${cookie}`,
    },
  });
}

// ── Request core ──────────────────────────────────────────────────────────────

/**
 * Makes a Roblox request through the global limiter, with retry.
 */
export async function robloxRequest<T>(
  client: AxiosInstance,
  config: AxiosRequestConfig,
  ctx: RobloxRequestContext,
): Promise<T> {
  const priority = ctx.priority ?? 'cycle';
  const max429Retries = ctx.retryOn429 ? env.ROBLOX_HTTP_MAX_429_RETRIES : 0;

  for (let attempt = 0; ; attempt++) {
    let data: T | undefined;

    try {
      const res = await robloxRateLimiter.withSlot(priority, () => client.request<T>(config));
      data = res.data;
    } catch (err) {
      // The limiter refused a slot (throttle cooldown or saturated queue).
      // Retrying inline would only stack more queued requests, so surface it:
      // workers reschedule after the cooldown, commands report the failure.
      if (err instanceof RateLimitRejection) {
        console.warn(
          `[HTTP] ${ctx.label}: no Roblox slot (${err.reason}, retry in ` +
            `${(err.retryInMs / 1000).toFixed(1)}s).${robloxRateLimiter.describe()}`,
        );
        throw err;
      }

      const axiosErr = err as AxiosError;
      const status = axiosErr.response?.status;

      // Non-retryable client errors (4xx other than 429) bubble up immediately.
      if (status !== undefined && status !== 429 && status < 500) throw err;

      if (status === 429) {
        const retryAfterMs = parseRetryAfterMs(axiosErr.response?.headers?.['retry-after']);
        robloxRateLimiter.reportRateLimit(retryAfterMs);

        if (attempt >= max429Retries) throw err;

        const backoff = Math.min(
          Math.max(
            env.ROBLOX_RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt),
            retryAfterMs ?? 0,
          ),
          env.ROBLOX_HTTP_MAX_DELAY_MS,
        );
        console.warn(
          `[HTTP] ${ctx.label}: 429 rate limited ` +
            `(retry-after=${retryAfterMs === undefined ? 'absent' : `${(retryAfterMs / 1000).toFixed(0)}s`}, ` +
            `backoff=${(backoff / 1000).toFixed(1)}s, attempt ${attempt + 1}/${max429Retries}).` +
            robloxRateLimiter.describe(),
        );
        await sleep(backoff);
        continue;
      }

      // 5xx or network failure.
      if (attempt >= env.ROBLOX_HTTP_MAX_RETRIES) throw err;

      const delay = withJitter(
        Math.min(
          env.ROBLOX_HTTP_BASE_DELAY_MS * Math.pow(2, attempt),
          env.ROBLOX_HTTP_MAX_DELAY_MS,
        ),
      );
      console.warn(
        `[HTTP] ${ctx.label}: attempt ${attempt + 1} failed ` +
          `(status=${status ?? 'network'}). Retrying in ${delay}ms.` +
          robloxRateLimiter.describe(),
      );
      await sleep(delay);
      continue;
    }

    robloxRateLimiter.reportSuccess();
    return data as T;
  }
}

/** GET a Roblox JSON endpoint through the limiter. */
export function robloxGet<T>(
  client: AxiosInstance,
  url: string,
  ctx: RobloxRequestContext,
  config?: AxiosRequestConfig,
): Promise<T> {
  return robloxRequest<T>(client, { ...config, method: 'GET', url }, ctx);
}

/** POST a Roblox JSON endpoint through the limiter. */
export function robloxPost<T>(
  client: AxiosInstance,
  url: string,
  body: unknown,
  ctx: RobloxRequestContext,
): Promise<T> {
  return robloxRequest<T>(client, { method: 'POST', url, data: body }, ctx);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parses a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds.
 * Returns undefined when the header is missing or unparsable.
 */
export function parseRetryAfterMs(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.round(value * 1000)) : undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));

  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());

  return undefined;
}

/** Equal jitter: half the delay plus a random half, so retries do not synchronise. */
export function withJitter(ms: number): number {
  return Math.round(ms / 2 + Math.random() * (ms / 2));
}

export function sleep(ms: number): Promise<void> {
  // Executor form deliberately: Promise.withResolvers() is ES2024 (Node 22+),
  // and this project also supports Node 20.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Splits an array into chunks of at most `size` elements.
 * Used for batching Roblox API requests (max 100 user IDs).
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}