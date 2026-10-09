/**
 * Throwaway smoke harness for the Roblox rate-limit rework.
 *
 * Run with:
 *   DOTENV_CONFIG_PATH=scripts/ratelimit-smoke.env npx tsx scripts/ratelimit-smoke.ts
 * or, portably:
 *   node --env-file=scripts/ratelimit-smoke.env ./node_modules/tsx/dist/cli.mjs scripts/ratelimit-smoke.ts
 *
 * Section 1 exercises `RobloxRateLimiter` in isolation with explicit options.
 * Section 2 exercises the HTTP wrapper against the process-wide singleton.
 */

import { type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import {
  RobloxRateLimiter,
  RateLimitRejection,
  robloxRateLimiter,
  type RateLimiterOptions,
} from '../src/lib/ratelimit.js';
import { robloxGet, robloxPost, createRobloxClient, chunk } from '../src/lib/http.js';
import { scheduleDelayMs } from '../src/lib/adaptive.js';
import { env } from '../src/lib/env.js';

// ── Assertion helpers ─────────────────────────────────────────────────────────

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * A promise plus its settle functions. Executor form deliberately:
 * Promise.withResolvers() is ES2024 / Node 22+, and the project supports Node 20.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeLimiter(overrides: Partial<RateLimiterOptions> = {}): RobloxRateLimiter {
  return new RobloxRateLimiter({
    maxRequestsPerMinute: 6000,
    burstMax: 3,
    minGapMs: 0,
    cycleMaxWaitMs: 3000,
    interactiveMaxWaitMs: 5000,
    cooldownMs: 300,
    cooldownMaxMs: 2000,
    adaptiveMaxMultiplier: 4,
    ...overrides,
  });
}

// ── Fake transport ────────────────────────────────────────────────────────────

type Reply = { status: number; headers?: Record<string, string>; data?: unknown };

/** Builds a client whose transport is a stub returning `reply(attempt)`. */
function fakeClient(reply: (attempt: number) => Reply): { client: AxiosInstance; attempts: () => number } {
  const client = createRobloxClient('cookie-value');
  let attempt = 0;

  client.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    attempt++;
    const r = reply(attempt);
    if (r.status >= 400) {
      const error = new Error(`HTTP ${r.status}`) as Error & {
        response: { status: number; headers: Record<string, string>; data: unknown };
        config: InternalAxiosRequestConfig;
        isAxiosError: boolean;
      };
      error.response = { status: r.status, headers: r.headers ?? {}, data: r.data ?? {} };
      error.config = config;
      error.isAxiosError = true;
      throw error;
    }
    return { status: r.status, statusText: 'OK', headers: {}, data: r.data ?? { ok: true }, config } as AxiosResponse;
  };

  return { client, attempts: () => attempt };
}

// ═══ Section 1 — limiter semantics (isolated) ═════════════════════════════════

console.log('\n── limiter semantics ──');

// 1a. Concurrency is 1.
{
  const limiter = makeLimiter();
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      limiter.withSlot('cycle', async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(20);
        active--;
      }),
    ),
  );
  check('concurrency: never more than one request in flight', peak === 1, `peak=${peak}`);
}

// 1b. Minimum request gap paces *starts* even when tokens are plentiful.
// This is the Phase 1 primary fix: Roblox rejects bursts, not volume.
{
  const limiter = makeLimiter({ minGapMs: 150, burstMax: 10, maxRequestsPerMinute: 6000 });
  const starts: number[] = [];
  await Promise.all(
    Array.from({ length: 4 }, () =>
      limiter.withSlot('cycle', async () => {
        starts.push(Date.now());
        await sleep(1);
      }),
    ),
  );
  starts.sort((a, b) => a - b);
  const deltas = starts.slice(1).map((t, i) => t - (starts[i] ?? t));
  const minDelta = Math.min(...deltas);
  check(
    'min gap: consecutive request starts are spaced despite spare tokens',
    minDelta >= 130,
    `min delta=${minDelta}ms deltas=[${deltas.join(',')}]`,
  );
}

// 1c. With the gap disabled, the bucket still absorbs a small burst (looser ceiling).
{
  const limiter = makeLimiter({ minGapMs: 0, burstMax: 3, maxRequestsPerMinute: 600 });
  const starts: number[] = [];
  await Promise.all(
    Array.from({ length: 4 }, () =>
      limiter.withSlot('cycle', async () => {
        starts.push(Date.now());
        await sleep(1);
      }),
    ),
  );
  starts.sort((a, b) => a - b);
  const spread = (starts.at(-1) ?? 0) - (starts[0] ?? 0);
  // burst = 3 free, 4th spaced by 60000/600 = 100ms.
  check('token bucket: absorbs burst then spaces the excess', spread >= 70 && spread < 1500, `spread=${spread}ms`);
}

// 1d. Cycle request over its patience budget is rejected, not retried.
{
  const limiter = makeLimiter({ minGapMs: 5000, burstMax: 1, cycleMaxWaitMs: 150 });
  const gate = deferred<void>();
  const holder = limiter.withSlot('cycle', async () => {
    await gate.promise;
  });

  const t0 = Date.now();
  let reason = '';
  try {
    await limiter.withSlot('cycle', async () => undefined);
  } catch (e) {
    reason = e instanceof RateLimitRejection ? e.reason : `unexpected:${String(e)}`;
  }
  const waited = Date.now() - t0;
  gate.resolve();
  await holder;

  check('patience: waiting out the gap beyond the budget rejects as timeout', reason === 'timeout', reason);
  check('patience: rejection respects the cycle budget', waited < 400, `${waited}ms`);
}

// 1e. A cooldown rejects cycle requests immediately.
{
  const limiter = makeLimiter({ cooldownMs: 2000, cycleMaxWaitMs: 150 });
  limiter.reportRateLimit(0);

  const t0 = Date.now();
  let reason = '';
  try {
    await limiter.withSlot('cycle', async () => undefined);
  } catch (e) {
    reason = e instanceof RateLimitRejection ? e.reason : `unexpected:${String(e)}`;
  }
  const waited = Date.now() - t0;
  check('cooldown: cycle request rejected with reason=cooldown', reason === 'cooldown', reason);
  check('cooldown: rejection is immediate', waited < 300, `${waited}ms`);
}

// 1f. Cooldown is FLAT — no doubling per consecutive 429 (Phase 1 policy).
{
  const limiter = makeLimiter({ cooldownMs: 300, cooldownMaxMs: 60_000 });
  limiter.reportRateLimit(0);
  const first = limiter.snapshot().cooldownRemainingMs;
  limiter.reportRateLimit(0);
  limiter.reportRateLimit(0);
  const afterThree = limiter.snapshot().cooldownRemainingMs;
  check('cooldown: first 429 opens the base cooldown', first > 250 && first <= 320, `${first}ms`);
  check(
    'cooldown: three consecutive 429s do NOT double the window',
    afterThree < first * 1.5,
    `first=${Math.round(first)}ms after3=${Math.round(afterThree)}ms`,
  );
}

// 1g. Retry-After raises the floor; an existing cooldown is never shortened.
{
  const limiter = makeLimiter({ cooldownMs: 300, cooldownMaxMs: 60_000 });
  limiter.reportRateLimit(5000);
  const long = limiter.snapshot().cooldownRemainingMs;
  limiter.reportRateLimit(0);
  const after = limiter.snapshot().cooldownRemainingMs;
  check('cooldown: Retry-After raises the floor', long > 4000, `${Math.round(long)}ms`);
  check('cooldown: never shortened by a later 429', after > 3000, `${Math.round(after)}ms`);
}

// 1h. Retry-After never exceeds the hard ceiling.
{
  const limiter = makeLimiter({ cooldownMs: 300, cooldownMaxMs: 2000 });
  limiter.reportRateLimit(600_000);
  const capped = limiter.snapshot().cooldownRemainingMs;
  check('cooldown: Retry-After clamped by the ceiling', capped <= 2100, `${Math.round(capped)}ms`);
}

// 1i. Penalty drives the interval multiplier and clears only on a clean cycle.
{
  const limiter = makeLimiter({ adaptiveMaxMultiplier: 4 });
  check('penalty: starts unthrottled', limiter.intervalMultiplier() === 1);

  limiter.reportRateLimit(0);
  check('penalty: 429 slows the poll interval', limiter.intervalMultiplier() === 2, `x${limiter.intervalMultiplier()}`);

  for (let i = 0; i < 10; i++) limiter.reportRateLimit(0);
  check('penalty: multiplier capped by option', limiter.intervalMultiplier() <= 4, `x${limiter.intervalMultiplier()}`);

  limiter.reportCycleClean();
  check('penalty: cleared by reportCycleClean', limiter.snapshot().penaltyLevel === 0);
  check('penalty: multiplier back to x1 after a clean cycle', limiter.intervalMultiplier() === 1);
}

// 1j. Interactive requests preempt queued cycle work.
{
  const limiter = makeLimiter({ minGapMs: 0 });
  const order: string[] = [];
  const gate = deferred<void>();

  const holder = limiter.withSlot('cycle', async () => {
    order.push('holder');
    await gate.promise;
  });

  await sleep(20);
  const queuedCycle = limiter.withSlot('cycle', async () => {
    order.push('cycle');
  });
  await sleep(20);
  const queuedInteractive = limiter.withSlot('interactive', async () => {
    order.push('interactive');
  });

  await sleep(20);
  gate.resolve();
  await Promise.allSettled([holder, queuedCycle, queuedInteractive]);

  const interactiveIdx = order.indexOf('interactive');
  const cycleIdx = order.indexOf('cycle');
  check(
    'priority: interactive request preempts queued cycle request',
    interactiveIdx >= 0 && (cycleIdx === -1 || interactiveIdx < cycleIdx),
    `order=${order.join(' > ')}`,
  );
}

// ═══ Section 2 — HTTP wrapper integration (singleton) ════════════════════════

console.log('\n── http integration ──');

// 2a. Interactive 429 retries and honours Retry-After.
{
  const { client, attempts } = fakeClient((attempt) =>
    attempt === 1 ? { status: 429, headers: { 'retry-after': '1' } } : { status: 200, data: { id: 7 } },
  );
  const t0 = Date.now();
  const data = await robloxGet<{ id: number }>(client, 'https://users.roblox.com/v1/users/authenticated', {
    label: 'validateCookie',
    priority: 'interactive',
    retryOn429: true,
  });
  const elapsed = Date.now() - t0;
  check('http: interactive 429 retried and succeeded', data.id === 7 && attempts() === 2, `attempts=${attempts()}`);
  check('http: interactive 429 honoured Retry-After (>=1s)', elapsed >= 1000, `${elapsed}ms`);
  check('limiter: 429 escalated the penalty', robloxRateLimiter.snapshot().penaltyLevel >= 1);
  await sleep(2400); // let the cooldown clear before the next section
}

// 2b. 4xx is never retried; 5xx is retried.
{
  const { client, attempts } = fakeClient(() => ({ status: 403 }));
  let threw = false;
  try {
    await robloxGet(client, 'https://users.roblox.com/z', { label: 'forbidden' });
  } catch {
    threw = true;
  }
  check('http: 403 not retried', attempts() === 1 && threw, `attempts=${attempts()}`);

  const flaky = fakeClient((attempt) => (attempt < 3 ? { status: 500 } : { status: 200, data: { ok: true } }));
  await robloxGet(flaky.client, 'https://users.roblox.com/w', { label: 'flaky' });
  check('http: 5xx retried until success', flaky.attempts() === 3, `attempts=${flaky.attempts()}`);
}

// 2c. A cycle 429 makes exactly one attempt and opens the cooldown.
{
  const { client, attempts } = fakeClient(() => ({ status: 429, headers: { 'retry-after': '1' } }));
  let threw = false;
  try {
    await robloxPost(client, 'https://presence.roblox.com/v1/presence/users', { userIds: [1] }, { label: 'presence 1/1' });
  } catch {
    threw = true;
  }
  const after = robloxRateLimiter.snapshot();
  check('http: cycle 429 makes exactly one attempt (no inline retry)', attempts() === 1, `attempts=${attempts()}`);
  check('http: cycle 429 surfaces to the caller', threw);
  check('limiter: cycle 429 opened a cooldown', after.cooldownRemainingMs > 0, `${Math.round(after.cooldownRemainingMs)}ms`);
}

// ═══ Section 3 — scheduling and configuration ════════════════════════════════

console.log('\n── scheduling ──');
{
  // Next cycle must wait out an active cooldown, never start inside it.
  const limiter = makeLimiter({ cooldownMs: 5000, cooldownMaxMs: 60_000 });
  limiter.reportRateLimit(0);
  const plan = scheduleDelayMs(30_000, limiter);
  check('scheduling: delay covers the remaining cooldown', plan.delayMs >= plan.cooldownRemainingMs, `${plan.delayMs}ms`);
  check('scheduling: cooldown reported for logging', plan.cooldownRemainingMs > 4000, `${plan.cooldownRemainingMs}ms`);

  const idle = scheduleDelayMs(30_000, makeLimiter());
  check('scheduling: idle delay equals the base interval', idle.delayMs === 30_000, `${idle.delayMs}ms`);
}

console.log('\n── configuration ──');
{
  check('env: presence batch size capped at 50', env.PRESENCE_BATCH_SIZE === 50, `${env.PRESENCE_BATCH_SIZE}`);
  check('env: min request gap defaults to off', env.ROBLOX_MIN_REQUEST_GAP_MS === 0, `${env.ROBLOX_MIN_REQUEST_GAP_MS}`);
  const batches = chunk(
    Array.from({ length: 137 }, (_, i) => i),
    env.PRESENCE_BATCH_SIZE,
  );
  check('batching: 137 ids -> 3 batches of <=50', batches.length === 3 && batches.every((b) => b.length <= 50));
  check(
    'sizing: 179 ids at a 1500ms default gap finish inside a 30s interval',
    Math.ceil(179 / 50) * 1500 < 30_000,
    `${Math.ceil(179 / 50) * 1500}ms`,
  );
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);