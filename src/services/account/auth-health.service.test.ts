/**
 * AuthHealthService tests.
 *
 * Two properties matter, and both are dangerous to get wrong:
 *
 *  1. **No false positive.** A 403 is not proof of a dead cookie — it also comes
 *     from edge blocks and challenge pages. Pausing presence and alerting the
 *     owner over a transient 403 is the same class of misdiagnosis that prolonged
 *     the original incident. Only a 401 carrying Roblox's "not authenticated"
 *     body is conclusive; anything else needs two consecutive failures.
 *  2. **No false negative.** A genuine dead cookie must pause polling promptly.
 *
 * No database: every Prisma delegate and service dependency is stubbed.
 *
 * Run:
 *   node --env-file=scripts/presence-invariant.env ./node_modules/tsx/dist/cli.mjs \
 *     --test src/services/account/auth-health.service.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../../lib/prisma.js';
import { accountService } from './account.service.js';
import { robloxService, RobloxApiError } from '../roblox/roblox.service.js';
import { notificationService } from '../notification/notification.service.js';
import { authHealthService } from './auth-health.service.js';
import { robloxRateLimiter, RateLimitRejection } from '../../lib/ratelimit.js';

const TELEGRAM_ID = 'tg-owner';

/**
 * Auth state is keyed by account id and is module-global, so each test gets its
 * own account: reuse would leak one test's invalid flag into the next.
 */
let nextAccountId = 1000;
function freshAccountId(): number {
  return nextAccountId++;
}

/** In-memory stand-in for the two persisted auth columns. */
interface PersistedAuth {
  authFailureCount: number;
  authLastAlertAt: Date | null;
}

/**
 * Installs stubs. `validate` is called on each check; `persisted` is mutated the
 * way the real columns would be, so the restart/crash-loop behaviour is testable.
 */
function installStubs(
  accountId: number,
  validate: () => Promise<void>,
): { alerts: string[]; persisted: PersistedAuth } {
  const alerts: string[] = [];
  const persisted: PersistedAuth = { authFailureCount: 0, authLastAlertAt: null };

  const prismaAny = prisma as unknown as Record<string, Record<string, unknown>>;
  prismaAny['robloxAccount']!['findUnique'] = async () => ({
    id: accountId,
    username: 'owner',
    displayName: 'Owner',
    authFailureCount: persisted.authFailureCount,
    authLastAlertAt: persisted.authLastAlertAt,
    user: { telegramId: TELEGRAM_ID },
  });
  prismaAny['robloxAccount']!['findMany'] = async () => [{ id: accountId }];
  prismaAny['robloxAccount']!['update'] = async (args: { data: Record<string, unknown> }) => {
    if (typeof args.data['authFailureCount'] === 'number') {
      persisted.authFailureCount = args.data['authFailureCount'];
    }
    if (args.data['authLastAlertAt'] instanceof Date) {
      persisted.authLastAlertAt = args.data['authLastAlertAt'];
    }
    return {};
  };

  (accountService as unknown as Record<string, unknown>)['getDecryptedCookieByAccountId'] = async () => 'stub-cookie';
  (robloxService as unknown as Record<string, unknown>)['validateCookie'] = validate;
  (notificationService as unknown as Record<string, unknown>)['sendDirectMessage'] = async (
    _to: string,
    message: string,
  ) => {
    alerts.push(message);
  };

  return { alerts, persisted };
}

/** A real dead-cookie rejection: 401 whose body says "User is not authenticated". */
function deadCookieError(): RobloxApiError {
  return new RobloxApiError(401, 'Invalid or expired .ROBLOSECURITY cookie.', 'User is not authenticated');
}

test('401 with "not authenticated" body pauses polling and alerts once', async () => {
  const accountId = freshAccountId();
  const { alerts, persisted } = installStubs(accountId, async () => {
    throw deadCookieError();
  });

  const status = await authHealthService.checkAccount(accountId);

  assert.equal(status, 'invalid');
  assert.equal(authHealthService.isInvalid(accountId), true, 'a dead cookie must pause presence polling');
  assert.equal(persisted.authFailureCount, 1);
  assert.equal(alerts.length > 0, true, 'the owner must be alerted');
  assert.ok(
    alerts.every((m) => !m.includes('stub-cookie')),
    'alerts must never contain the cookie',
  );

  // A second check inside the alert cooldown must not re-alert.
  const before = alerts.length;
  await authHealthService.checkAccount(accountId);
  assert.equal(alerts.length, before, 'must not re-alert within the cooldown window');
});

test('403 edge block is NOT conclusive: needs two consecutive failures', async () => {
  const accountId = freshAccountId();
  const { alerts } = installStubs(accountId, async () => {
    throw new RobloxApiError(403, 'Invalid or expired .ROBLOSECURITY cookie.', 'Forbidden');
  });

  const first = await authHealthService.checkAccount(accountId);

  assert.equal(first, 'unknown', 'a single 403 must not be treated as a dead cookie');
  assert.equal(authHealthService.isInvalid(accountId), false, 'polling must not pause on one 403');
  assert.deepEqual(alerts, [], 'the owner must not be alerted on one 403');

  const second = await authHealthService.checkAccount(accountId);

  assert.equal(second, 'invalid', 'two consecutive failures do indicate a real problem');
  assert.equal(authHealthService.isInvalid(accountId), true);
  assert.equal(alerts.length > 0, true, 'the owner is alerted once the pattern is confirmed');
});

test('403 challenge page is NOT conclusive either', async () => {
  const accountId = freshAccountId();
  const { alerts } = installStubs(accountId, async () => {
    throw new RobloxApiError(403, 'Invalid or expired .ROBLOSECURITY cookie.', 'Challenge required');
  });

  assert.equal(await authHealthService.checkAccount(accountId), 'unknown');
  assert.equal(authHealthService.isInvalid(accountId), false);
  assert.deepEqual(alerts, []);
});

test('429 never marks invalid and never counts toward the failure threshold', async () => {
  const accountId = freshAccountId();
  const { alerts, persisted } = installStubs(accountId, async () => {
    throw new RobloxApiError(429, 'Too many requests.');
  });

  for (let i = 0; i < 3; i++) {
    assert.equal(await authHealthService.checkAccount(accountId), 'unknown');
  }

  assert.equal(authHealthService.isInvalid(accountId), false, 'a throttle must not pause polling');
  assert.equal(persisted.authFailureCount, 0, 'a throttle must not count as an auth failure');
  assert.deepEqual(alerts, []);
});

test('limiter cooldown rejection never marks invalid', async () => {
  const accountId = freshAccountId();
  installStubs(accountId, async () => {
    throw new RateLimitRejection('cooldown', 30_000, 'Roblox throttled us; 30s of cooldown remaining.');
  });
  robloxRateLimiter.reportRateLimit(0);

  assert.equal(await authHealthService.checkAccount(accountId), 'unknown');
  assert.equal(authHealthService.isInvalid(accountId), false);
});

test('self-heals: a later 200 clears invalid state and resets the failure count', async () => {
  const accountId = freshAccountId();
  let nowDead = true;
  const { alerts, persisted } = installStubs(accountId, async () => {
    if (nowDead) throw deadCookieError();
  });

  assert.equal(await authHealthService.checkAccount(accountId), 'invalid');
  assert.equal(authHealthService.isInvalid(accountId), true);
  const alertsAfterTrip = alerts.length;

  // Cookie fixed directly in the DB (or the failure was a false positive).
  nowDead = false;
  const status = await authHealthService.checkAccount(accountId);

  assert.equal(status, 'valid');
  assert.equal(
    authHealthService.isInvalid(accountId),
    false,
    'a valid check must resume polling without /setcookie',
  );
  assert.equal(persisted.authFailureCount, 0, 'recovery must reset the failure counter');
  assert.equal(alerts.length, alertsAfterTrip, 'recovery must not send another alert');
});

test('a single transient failure is cleared by the next success (no false pause)', async () => {
  const accountId = freshAccountId();
  let fail = true;
  const { alerts, persisted } = installStubs(accountId, async () => {
    if (fail) throw new RobloxApiError(403, 'Invalid or expired .ROBLOSECURITY cookie.', 'Forbidden');
  });

  assert.equal(await authHealthService.checkAccount(accountId), 'unknown');
  fail = false;
  assert.equal(await authHealthService.checkAccount(accountId), 'valid');

  assert.equal(authHealthService.isInvalid(accountId), false);
  assert.equal(persisted.authFailureCount, 0);
  assert.deepEqual(alerts, [], 'a blip that recovers must never alert');
});

test('alert throttle is persisted, so a restart while invalid does not re-alert', async () => {
  const accountId = freshAccountId();
  const { alerts, persisted } = installStubs(accountId, async () => {
    throw deadCookieError();
  });

  await authHealthService.checkAccount(accountId);
  assert.equal(alerts.length > 0, true);
  assert.ok(persisted.authLastAlertAt instanceof Date, 'the alert time must be persisted, not just in memory');

  // Simulate a process restart: in-memory state is gone, the DB row is not.
  const before = alerts.length;
  await authHealthService.alertIfDue(accountId, TELEGRAM_ID, 'Owner', 'restart check');

  assert.equal(alerts.length, before, 'a restart while the cookie is invalid must not re-alert');
});

test('markValid resumes polling after a cookie replacement', async () => {
  const accountId = freshAccountId();
  installStubs(accountId, async () => {
    throw deadCookieError();
  });
  await authHealthService.checkAccount(accountId);
  assert.equal(authHealthService.isInvalid(accountId), true);

  authHealthService.markValid(accountId);

  assert.equal(authHealthService.isInvalid(accountId), false, 'a fresh cookie must resume polling');
  assert.equal(authHealthService.snapshot(accountId).status, 'valid');
});