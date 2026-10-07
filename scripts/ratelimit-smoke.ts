/**
 * Throwaway smoke harness for the Roblox rate-limit rework.
 *
 * Run with:
 *   DOTENV_CONFIG_PATH=scripts/ratelimit-smoke.env npx tsx scripts/ratelimit-smoke.ts
 *
 * Configuration travels through DOTENV_CONFIG_PATH (read by `lib/env.ts` via
 * `dotenv/config`) so the imports below can stay static.
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
import { adaptInterval } from '../src/lib/adaptive.js';
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

function makeLimiter(overrides: Partial<RateLimiterOptions> = {}): RobloxRateLimiter {
  return new RobloxRateLimiter({
    maxRequestsPerMinute: 6000,
    burstMax: 3,
    cycleMaxWaitMs: 3000,
    interactiveMaxWaitMs: 5000,
    cooldownMs: 300,
    cooldownMaxMs: 2000,
    adaptiveMaxMultiplier: 4,
    adaptiveRecoverMs: 300,
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

// 1b. Burst allowance, then sustained spacing.
{
  const limiter = makeLimiter({ maxRequestsPerMinute: 600 });
  const stamps: number[] = [];
  await Promise.all(
    Array.from({ length: 4 }, () =>
      limiter.withSlot('cycle', async () => {
        stamps.push(Date.now());
      }),
    ),
  );
  const spread = Math.max(...stamps) - Math.min(...stamps);
  // burst = 3, so the 4th grant is spaced by 60000/600 = 100ms.
  check('rate: burst of 3 then sustained spacing', spread >= 70 && spread < 1500, `spread=${spread}ms`);
}

// 1c. Cycle request over its patience budget is rejected, not retried.
{
  const limiter = makeLimiter({ maxRequestsPerMinute: 60, burstMax: 1, cycleMaxWaitMs: 150 });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = limiter.withSlot('cycle', async () => {
    await gate;
  });

  const t0 = Date.now();
  let reason = '';
  try {
    await limiter.withSlot('cycle', async () => undefined);
  } catch (e) {
    reason = e instanceof RateLimitRejection ? e.reason : `unexpected:${String(e)}`;
  }
  const waited = Date.now() - t0;
  release();
  await holder;

  check('patience: saturated queue rejects with reason=timeout', reason === 'timeout', reason);
  check('patience: rejection respects the cycle budget', waited < 400, `${waited}ms`);
}

// 1d. A 429 cooldown rejects cycle requests immediately.
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

// 1e. Retry-After raises the cooldown floor but an existing cooldown never shortens.
{
  const limiter = makeLimiter({ cooldownMs: 300 });
  limiter.reportRateLimit(5000);
  const long = limiter.snapshot().cooldownRemainingMs;
  limiter.reportRateLimit(0);
  const after = limiter.snapshot().cooldownRemainingMs;
  check('cooldown: Retry-After raises the floor', long > 4000, `${Math.round(long)}ms`);
  check('cooldown: never shortened by a later 429', after > 3000, `${Math.round(after)}ms`);
}

// 1f. Penalty escalation, multiplier cap, and recovery.
{
  const limiter = makeLimiter({ adaptiveRecoverMs: 300, adaptiveMaxMultiplier: 4 });
  limiter.reportRateLimit(0);
  const penalised = adaptInterval(10_000, limiter);
  check('adaptive: interval stretched while penalised', penalised.multiplier > 1, `x${penalised.multiplier}`);

  for (let i = 0; i < 8; i++) limiter.reportRateLimit(0);
  const capped = limiter.intervalMultiplier();
  check('adaptive: multiplier capped by option', capped <= 4, `x${capped}`);

  // Recovery decays one level per adaptiveRecoverMs of clean uptime.
  limiter.reportSuccess();
  await sleep(360);
  limiter.reportSuccess();
  const level = limiter.snapshot().penaltyLevel;
  check('adaptive: penalty decays after sustained success', level < 6, `level=${level}`);

  // From a single 429 the multiplier itself returns to 1.
  const single = makeLimiter({ adaptiveRecoverMs: 300 });
  single.reportRateLimit(0);
  single.reportSuccess();
  await sleep(360);
  single.reportSuccess();
  const backToNormal = adaptInterval(10_000, single);
  check('adaptive: multiplier returns to x1 after recovery', backToNormal.multiplier === 1, `x${backToNormal.multiplier}`);
}

// 1g. Interactive requests preempt queued cycle work.
{
  const limiter = makeLimiter();
  const order: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const holder = limiter.withSlot('cycle', async () => {
    order.push('holder');
    await gate;
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
  release();
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

// ═══ Section 3 — configuration and batching ══════════════════════════════════

console.log('\n── configuration ──');
{
  check('env: presence batch size capped at 50', env.PRESENCE_BATCH_SIZE === 50, `${env.PRESENCE_BATCH_SIZE}`);
  const batches = chunk(
    Array.from({ length: 137 }, (_, i) => i),
    env.PRESENCE_BATCH_SIZE,
  );
  check('batching: 137 ids -> 3 batches of <=50', batches.length === 3 && batches.every((b) => b.length <= 50));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);