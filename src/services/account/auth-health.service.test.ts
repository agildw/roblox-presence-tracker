/**
 * AuthHealthService tests.
 *
 * The dangerous branch: only an explicit 401/403 may mark a cookie invalid. If a
 * transient 429 or a network blip marked it invalid, the bot would pause presence
 * tracking and alert the owner for a non-problem — the exact misdiagnosis that
 * prolonged the original incident (throttling read as "rate limits", not "dead
 * cookie"). Conversely, a 401 must pause polling immediately.
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

/** Installs stubs; returns a recorder of alerts and the validator's behaviour. */
function installStubs(accountId: number, validate: () => Promise<void>): { alerts: string[] } {
  const alerts: string[] = [];

  const prismaAny = prisma as unknown as Record<string, Record<string, unknown>>;
  prismaAny['robloxAccount']!['findUnique'] = async () => ({
    id: accountId,
    username: 'owner',
    displayName: 'Owner',
    user: { telegramId: TELEGRAM_ID },
  });
  prismaAny['robloxAccount']!['findMany'] = async () => [{ id: accountId }];

  (accountService as unknown as Record<string, unknown>)['getDecryptedCookieByAccountId'] = async () => 'stub-cookie';

  (robloxService as unknown as Record<string, unknown>)['validateCookie'] = validate;

  (notificationService as unknown as Record<string, unknown>)['sendDirectMessage'] = async (
    _to: string,
    message: string,
  ) => {
    alerts.push(message);
  };

  return { alerts };
}

test('401 marks the cookie invalid, pauses polling, and alerts once', async () => {
  const accountId = freshAccountId();
  const { alerts } = installStubs(accountId, async () => {
    throw new RobloxApiError(401, 'Invalid or expired .ROBLOSECURITY cookie.');
  });

  const status = await authHealthService.checkAccount(accountId);

  assert.equal(status, 'invalid');
  assert.equal(authHealthService.isInvalid(accountId), true, 'an invalid cookie must pause presence polling');
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

test('429 must NOT mark the cookie invalid (transient throttle is not a dead cookie)', async () => {
  const accountId = freshAccountId();
  installStubs(accountId, async () => {
    throw new RobloxApiError(429, 'Too many requests.');
  });

  const status = await authHealthService.checkAccount(accountId);

  assert.equal(status, 'unknown');
  assert.equal(
    authHealthService.isInvalid(accountId),
    false,
    'a throttle must not pause polling — that would misdiagnose the incident',
  );
});

test('limiter cooldown rejection must NOT mark the cookie invalid', async () => {
  const accountId = freshAccountId();
  installStubs(accountId, async () => {
    throw new RateLimitRejection('cooldown', 30_000, 'Roblox throttled us; 30s of cooldown remaining.');
  });
  robloxRateLimiter.reportRateLimit(0);

  const status = await authHealthService.checkAccount(accountId);

  assert.equal(status, 'unknown');
  assert.equal(authHealthService.isInvalid(accountId), false);
});

test('markValid resumes polling after a cookie replacement', async () => {
  const accountId = freshAccountId();
  installStubs(accountId, async () => {
    throw new RobloxApiError(403, 'Forbidden.');
  });
  await authHealthService.checkAccount(accountId);
  assert.equal(authHealthService.isInvalid(accountId), true);

  authHealthService.markValid(accountId);

  assert.equal(authHealthService.isInvalid(accountId), false, 'a fresh cookie must resume polling');
  assert.equal(authHealthService.snapshot(accountId).status, 'valid');
});

test('a valid cookie stays valid and never alerts', async () => {
  const accountId = freshAccountId();
  const { alerts } = installStubs(accountId, async () => undefined);

  const status = await authHealthService.checkAccount(accountId);

  assert.equal(status, 'valid');
  assert.equal(authHealthService.isInvalid(accountId), false);
  assert.deepEqual(alerts, []);
});