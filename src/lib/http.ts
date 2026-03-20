/**
 * Lightweight HTTP helper built on top of axios.
 * Provides consistent cookie injection, error handling, and rate-limit retries.
 */

import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosError,
} from 'axios';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000; // exponential back-off base

// ── Factory ───────────────────────────────────────────────────────────────────

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

// ── Retry wrapper ─────────────────────────────────────────────────────────────

/**
 * Wraps an axios call with exponential back-off retry on:
 *  - 429 (rate limited)
 *  - 5xx (server errors)
 *  - Network timeouts
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = DEFAULT_MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const axiosErr = err as AxiosError;
      const status = axiosErr.response?.status;

      // Don't retry client errors (4xx) except rate limits
      if (status !== undefined && status !== 429 && status < 500) {
        throw err;
      }

      if (attempt < maxRetries) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[HTTP] Attempt ${attempt + 1} failed (status=${status ?? 'network'}). Retrying in ${delay}ms…`,
        );
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

// ── Request helper ────────────────────────────────────────────────────────────

/**
 * Makes a GET request with retry.
 */
export async function robloxGet<T>(
  client: AxiosInstance,
  url: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  return withRetry(async () => {
    const res = await client.get<T>(url, config);
    return res.data;
  });
}

/**
 * Makes a POST request with retry.
 */
export async function robloxPost<T>(
  client: AxiosInstance,
  url: string,
  data: unknown,
  config?: AxiosRequestConfig,
): Promise<T> {
  return withRetry(async () => {
    const res = await client.post<T>(url, data, config);
    return res.data;
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
