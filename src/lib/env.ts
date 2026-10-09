import 'dotenv/config';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Parses an optional integer env var, falling back to `fallback` for missing,
 * unparsable, or out-of-range values (clamped to [min, max]).
 */
function intEnv(
  key: string,
  fallback: number,
  opts: { min?: number; max?: number } = {},
): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    console.warn(`[Env] ${key}="${raw}" is not an integer; using default ${fallback}.`);
    return fallback;
  }

  const min = opts.min ?? Number.NEGATIVE_INFINITY;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  if (parsed < min || parsed > max) {
    const clamped = Math.min(Math.max(parsed, min), max);
    console.warn(`[Env] ${key}=${parsed} out of range [${min}, ${max}]; using ${clamped}.`);
    return clamped;
  }

  return parsed;
}

/** Parses an optional boolean env var (`1/true/yes/on` vs `0/false/no/off`). */
function boolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;

  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;

  console.warn(`[Env] ${key}="${raw}" is not a boolean; using default ${fallback}.`);
  return fallback;
}

export const env = {
  BOT_TOKEN: requireEnv('BOT_TOKEN'),
  DATABASE_URL: requireEnv('DATABASE_URL'),
  ENCRYPTION_KEY: process.env['ENCRYPTION_KEY'] ?? 'changeme-32-char-secret-key12345',
  NODE_ENV: process.env['NODE_ENV'] ?? 'development',
  ADMIN_USER_IDS: (process.env['ADMIN_USER_IDS'] || '').split(',').map(id => id.trim()).filter(Boolean),

  // ── Polling cadence ────────────────────────────────────────────────────────
  /** Base presence poll interval. The worker slows down from here when throttled. */
  PRESENCE_POLL_INTERVAL_MS: intEnv('PRESENCE_POLL_INTERVAL_MS', 30_000, { min: 5_000 }),
  /** Base friend sync interval. */
  FRIEND_SYNC_INTERVAL_MS: intEnv('FRIEND_SYNC_INTERVAL_MS', 20 * 60 * 1000, { min: 60_000 }),

  // ── Batching ───────────────────────────────────────────────────────────────
  /**
   * user IDs per presence request. The endpoint rejects >50 with HTTP 400
   * ("Too many User Ids being sent in the request"), so this is capped at 50.
   */
  PRESENCE_BATCH_SIZE: intEnv('PRESENCE_BATCH_SIZE', 50, { min: 1, max: 50 }),
  /** user IDs per POST /v1/users request (Roblox hard limit 100). */
  USER_BATCH_SIZE: intEnv('USER_BATCH_SIZE', 100, { min: 1, max: 100 }),
  /** Batches one worker cycle may attempt before it yields (tracked users first). */
  ROBLOX_MAX_BATCHES_PER_CYCLE: intEnv('ROBLOX_MAX_BATCHES_PER_CYCLE', 8, { min: 1, max: 500 }),

  // ── Global rate limiter ────────────────────────────────────────────────────
  /** Sustained request ceiling shared by every Roblox call. */
  ROBLOX_MAX_REQUESTS_PER_MINUTE: intEnv('ROBLOX_MAX_REQUESTS_PER_MINUTE', 30, { min: 1, max: 600 }),
  /**
   * Minimum spacing between consecutive request *starts* (ms). Optional
   * conservative pacing: `0` disables it (the default).
   *
   * The original justification for this knob — that Roblox rejects bursts — came
   * from probes that were silently running unauthenticated because of an expired
   * stored cookie, so it measured the anonymous limiter, not the bot's real one.
   * With a valid cookie, 4 requests at 500ms spacing are accepted (10/10). Raise
   * this only if authenticated throttling is observed again; it costs latency on
   * every interactive command (`/sync`, `/badges`).
   */
  ROBLOX_MIN_REQUEST_GAP_MS: intEnv('ROBLOX_MIN_REQUEST_GAP_MS', 0, { min: 0, max: 60_000 }),
  /**
   * Max time a background cycle request waits for a free slot before aborting.
   * Generous enough to sit out a cooldown tail without being mistaken for a
   * saturated queue; only binds when a cooldown is already open.
   */
  ROBLOX_CYCLE_MAX_WAIT_MS: intEnv('ROBLOX_CYCLE_MAX_WAIT_MS', 5_000, { min: 0 }),
  /** Max time an interactive (command-driven) request waits for a free slot. */
  ROBLOX_INTERACTIVE_MAX_WAIT_MS: intEnv('ROBLOX_INTERACTIVE_MAX_WAIT_MS', 20_000, { min: 0 }),

  // ── Retry / backoff ────────────────────────────────────────────────────────
  /** Attempts after the first for retryable failures (5xx, network, 429). */
  ROBLOX_HTTP_MAX_RETRIES: intEnv('ROBLOX_HTTP_MAX_RETRIES', 3, { min: 0, max: 10 }),
  /** Exponential backoff base for retryable non-429 failures. */
  ROBLOX_HTTP_BASE_DELAY_MS: intEnv('ROBLOX_HTTP_BASE_DELAY_MS', 1_000, { min: 0 }),
  /** Attempts after the first made specifically for 429s (interactive calls). */
  ROBLOX_HTTP_MAX_429_RETRIES: intEnv('ROBLOX_HTTP_MAX_429_RETRIES', 2, { min: 0, max: 10 }),
  /** Floor for the 429 backoff used when Retry-After is missing or shorter. */
  ROBLOX_RATE_LIMIT_BASE_DELAY_MS: intEnv('ROBLOX_RATE_LIMIT_BASE_DELAY_MS', 10_000, { min: 0 }),
  /** Hard ceiling for any single retry delay. */
  ROBLOX_HTTP_MAX_DELAY_MS: intEnv('ROBLOX_HTTP_MAX_DELAY_MS', 60_000, { min: 100 }),

  // ── Cooldown / circuit breaker ─────────────────────────────────────────────
  /**
   * Cooldown opened by a 429 when `Retry-After` is absent or shorter than this.
   * Never doubles per consecutive 429: a stuck escalating cooldown is what once
   * pinned the bot into permanent backoff. With a valid cookie, 429s are rare, so
   * this is a safety net rather than a routine path.
   */
  ROBLOX_COOLDOWN_MS: intEnv('ROBLOX_COOLDOWN_MS', 45_000, { min: 0 }),
  /** Hard ceiling for a cooldown, even when `Retry-After` asks for longer. */
  ROBLOX_COOLDOWN_MAX_MS: intEnv('ROBLOX_COOLDOWN_MAX_MS', 10 * 60 * 1000, { min: 1_000 }),
  /** Max slow-down multiplier applied to the poll interval while penalised. */
  ROBLOX_ADAPTIVE_MAX_MULTIPLIER: intEnv('ROBLOX_ADAPTIVE_MAX_MULTIPLIER', 4, { min: 1, max: 64 }),

  // ── Diagnostics ────────────────────────────────────────────────────────────
  /**
   * Emit one `[RBX]` line per Roblox request: timestamp, label, gap since the
   * previous Roblox request, status, `Retry-After`, `x-ratelimit-*`, and
   * per-minute counts by endpoint. Logging only — never affects behaviour, and
   * never emits credentials. Off by default: it is one line per request, so
   * enable it for an investigation, not in steady state.
   */
  ROBLOX_FORENSIC_LOG: boolEnv('ROBLOX_FORENSIC_LOG', false),

  // ── Auth health ────────────────────────────────────────────────────────────
  /**
   * How often the stored `.ROBLOSECURITY` cookie is re-validated against
   * `users.roblox.com/v1/users/authenticated`. An expired cookie silently makes
   * presence requests anonymous, which is throttled far harder than
   * authenticated traffic — this is the check that catches it.
   */
  AUTH_CHECK_INTERVAL_MS: intEnv('AUTH_CHECK_INTERVAL_MS', 15 * 60 * 1000, { min: 60_000 }),
  /** Minimum gap between "cookie invalid" alerts for the same account. */
  AUTH_ALERT_COOLDOWN_HOURS: intEnv('AUTH_ALERT_COOLDOWN_HOURS', 6, { min: 1, max: 720 }),
} as const;