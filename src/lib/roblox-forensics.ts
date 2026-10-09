/**
 * Token-free forensic logging for every Roblox request.
 *
 * Purpose: when the endpoint throttles us, the useful questions are "how dense
 * was the traffic", "did some *other* endpoint spend the same budget", and "what
 * did the server actually say". This module answers all three per request.
 *
 * Enabled with `ROBLOX_FORENSIC_LOG` (default true). It is pure logging — it
 * never changes request behaviour, and it never touches credentials.
 *
 * Safety: only the label, status, and the three `x-ratelimit-*` / `Retry-After`
 * header values are ever emitted. Cookies and tokens are never read here, so
 * they cannot be logged.
 */

import { env } from './env.js';

// ── Endpoint families ─────────────────────────────────────────────────────────

/**
 * Maps a request label to a stable endpoint family, so per-minute tallies group
 * by *what was called* rather than by the batch suffix ("getPresence 1/4").
 */
const FAMILY_BY_LABEL: Record<string, string> = {
  validateCookie: 'auth',
  getFriends: 'friends',
  getUsersBatch: 'users',
  getUserByUsername: 'usernames',
  getPresence: 'presence',
  getBadges: 'badges',
  getBadgeAwardedDates: 'badges',
};

function endpointFamily(label: string): string {
  const head = label.split(' ')[0] ?? label;
  return FAMILY_BY_LABEL[head] ?? head;
}

// ── State ─────────────────────────────────────────────────────────────────────

/** Timestamp of the previous Roblox request of *any* endpoint. */
let lastRequestAt = 0;

/** Per-endpoint count within the current minute bucket. */
const perMinute = new Map<string, { minute: number; count: number }>();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Reads a header as one trimmed string; 'absent' when missing or empty. */
function headerValue(headers: unknown, name: string): string {
  if (!headers || typeof headers !== 'object') return 'absent';
  const value = (headers as Record<string, unknown>)[name];
  if (value === undefined || value === null || value === '') return 'absent';
  return Array.isArray(value) ? value.join(' ') : String(value);
}

// ── API ───────────────────────────────────────────────────────────────────────

/**
 * Records one Roblox HTTP attempt. Call exactly once per attempt (including
 * retries), regardless of success or failure.
 */
export function recordRobloxRequest(
  label: string,
  status: number | 'network',
  headers: unknown,
): void {
  if (!env.ROBLOX_FORENSIC_LOG) return;

  const now = Date.now();
  const gap = lastRequestAt === 0 ? -1 : now - lastRequestAt;
  lastRequestAt = now;

  const family = endpointFamily(label);
  const minute = Math.floor(now / 60_000);
  const previous = perMinute.get(family);
  const count = previous && previous.minute === minute ? previous.count + 1 : 1;
  perMinute.set(family, { minute, count });

  const tally = [...perMinute.entries()]
    .filter(([, entry]) => entry.minute === minute)
    .map(([name, entry]) => `${name}=${entry.count}`)
    .join(' ');

  console.log(
    `[RBX] ${new Date(now).toISOString()} ${label} ` +
      `gap=${gap < 0 ? 'n/a' : `${gap}ms`} status=${status} ` +
      `retry-after=${headerValue(headers, 'retry-after')} ` +
      `limit=${headerValue(headers, 'x-ratelimit-limit')} ` +
      `remaining=${headerValue(headers, 'x-ratelimit-remaining')} ` +
      `reset=${headerValue(headers, 'x-ratelimit-reset')} ` +
      `| minute: ${tally}`,
  );
}

/** One-line summary of the effective limiter settings, for a startup log. */
export function describeRobloxForensicsSettings(): string {
  return (
    `forensic=${env.ROBLOX_FORENSIC_LOG ? 'on' : 'off'} ` +
    `minGap=${env.ROBLOX_MIN_REQUEST_GAP_MS}ms ` +
    `ceiling=${env.ROBLOX_MAX_REQUESTS_PER_MINUTE}/min ` +
    `cooldown=${env.ROBLOX_COOLDOWN_MS}ms`
  );
}