/**
 * Partial-data invariant test for PresenceService.
 *
 * A throttled or truncated presence fetch answers only *some* users. The
 * invariant under test: the service iterates **only the returned presence
 * records** — never the requested id set — so a user Roblox did not answer for
 * keeps its cached state and produces no notification and no DB write.
 *
 * Breaking this invariant is how a bot fabricates mass "went offline" events,
 * so it is pinned here rather than left to code review.
 *
 * Run:
 *   node --import tsx --test src/services/presence/presence.service.test.ts
 *
 * No database is touched: every Prisma delegate the service uses is stubbed, and
 * `robloxService` / `accountService` / notification / session services are
 * replaced with recorders.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../../lib/prisma.js';
import { robloxService } from '../roblox/roblox.service.js';
import { accountService } from '../account/account.service.js';
import { notificationService } from '../notification/notification.service.js';
import { robloxRateLimiter } from '../../lib/ratelimit.js';
import { authHealthService } from '../account/auth-health.service.js';
import { sessionService } from '../session/session.service.js';
import { presenceService } from './presence.service.js';
import type { PresenceFetchResult } from '../roblox/roblox.service.js';
import type { RobloxUserPresence } from '../roblox/roblox.types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 7;
const ACCOUNT_ROBLOX_ID = 1730348080n;
const TELEGRAM_ID = 'tg-1';

/** Friend that Roblox ANSWERS for, transitioning offline(0) to website(1). */
const ANSWERED_FRIEND = {
  id: 11,
  robloxAccountId: ACCOUNT_ID,
  friendUserId: 1001n,
  lastPresence: 0,
  lastGameId: null,
};

/**
 * Friend that Roblox does NOT answer for. Its cached state says "online", so if
 * the service wrongly treated a missing record as offline it would emit a
 * "went offline" notification for this user.
 */
const UNANSWERED_FRIEND = {
  id: 12,
  robloxAccountId: ACCOUNT_ID,
  friendUserId: 1002n,
  lastPresence: 1,
  lastGameId: null,
};

function presenceFor(userId: number, overrides: Partial<RobloxUserPresence> = {}): RobloxUserPresence {
  return {
    userPresenceType: 1,
    lastLocation: 'Website',
    placeId: null,
    rootPlaceId: null,
    gameId: null,
    universeId: null,
    userId,
    lastOnline: '2026-10-08T00:00:00Z',
    ...overrides,
  };
}

// ── Harness ───────────────────────────────────────────────────────────────────

interface Recorder {
  notifications: Array<{ recordId: number; type: string; event: string }>;
  updates: Array<{ model: 'friend' | 'trackedUser'; id: number }>;
  sessions: string[];
}

/**
 * Installs stubs. Stubs are assigned through a loose view of each object so the
 * test does not depend on the real Prisma delegate types.
 */
function installStubs(
  fetch: PresenceFetchResult,
  friends: typeof ANSWERED_FRIEND[],
  opts: { openCooldown?: boolean; authInvalid?: boolean } = {},
): Recorder {
  const rec: Recorder = { notifications: [], updates: [], sessions: [] };

  (authHealthService as unknown as Record<string, unknown>)['isInvalid'] = () => opts.authInvalid === true;

  const prismaAny = prisma as unknown as Record<string, Record<string, unknown>>;
  prismaAny['robloxAccount']!['findMany'] = async () => [
    { id: ACCOUNT_ID, robloxUserId: ACCOUNT_ROBLOX_ID, user: { telegramId: TELEGRAM_ID } },
  ];
  prismaAny['friend']!['findMany'] = async () => friends;
  prismaAny['trackedUser']!['findMany'] = async () => [];
  prismaAny['friend']!['update'] = async (args: { where: { id: number } }) => {
    rec.updates.push({ model: 'friend', id: args.where.id });
    return {};
  };
  prismaAny['trackedUser']!['update'] = async (args: { where: { id: number } }) => {
    rec.updates.push({ model: 'trackedUser', id: args.where.id });
    return {};
  };

  const accountAny = accountService as unknown as Record<string, unknown>;
  accountAny['getDecryptedCookie'] = async () => 'stub-cookie';

  const robloxAny = robloxService as unknown as Record<string, unknown>;
  robloxAny['getPresence'] = async () => {
    // Mimic the real HTTP layer: a throttled fetch opens the shared cooldown.
    if (opts.openCooldown && fetch.throttled) robloxRateLimiter.reportRateLimit(0);
    return fetch;
  };

  const notifAny = notificationService as unknown as Record<string, unknown>;
  notifAny['notifyPresenceChange'] = async (
    _telegramId: string,
    recordId: number,
    type: string,
    _message: string,
    event: string,
  ) => {
    rec.notifications.push({ recordId, type, event });
  };

  const sessionAny = sessionService as unknown as Record<string, unknown>;
  for (const name of [
    'startPresenceSession',
    'startGameSession',
    'changeGameSession',
    'endGameSession',
  ]) {
    sessionAny[name] = async () => {
      rec.sessions.push(name);
    };
  }

  return rec;
}

function partialFetch(records: RobloxUserPresence[], batchesTotal: number): PresenceFetchResult {
  return {
    presence: new Map(records.map((r) => [r.userId, r])),
    batchesAttempted: 1,
    batchesTotal,
    batchesSucceeded: 1,
    unansweredBatches: batchesTotal - 1,
    unansweredIds: 0,
    throttled: true,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('partial fetch: only answered users are read, written and notified', async () => {
  const rec = installStubs(
    {
      ...partialFetch([presenceFor(1001, { userPresenceType: 1 })], 3),
      unansweredIds: 1,
    },
    [ANSWERED_FRIEND, UNANSWERED_FRIEND],
  );

  await presenceService.pollAccountPresence(
    { id: ACCOUNT_ID, robloxUserId: ACCOUNT_ROBLOX_ID },
    TELEGRAM_ID,
  );

  // The answered user (offline -> website) reports exactly one online event.
  assert.deepEqual(rec.notifications, [
    { recordId: ANSWERED_FRIEND.id, type: 'FRIEND', event: 'online' },
  ]);
  // The unanswered user (cached "online") must produce no offline event — that
  // is the false-notification failure mode this test exists to prevent.
  assert.ok(
    !rec.notifications.some((n) => n.recordId === UNANSWERED_FRIEND.id),
    'unanswered user must not be notified',
  );

  // Writes are likewise scoped to answered users only.
  assert.deepEqual(rec.updates, [{ model: 'friend', id: ANSWERED_FRIEND.id }]);
  assert.ok(
    !rec.updates.some((u) => u.id === UNANSWERED_FRIEND.id),
    'unanswered user must not be written',
  );
});

test('empty presence map: no iteration, no notifications, no writes, no sessions', async () => {
  const rec = installStubs(
    {
      presence: new Map(),
      batchesAttempted: 1,
      batchesTotal: 3,
      batchesSucceeded: 0,
      unansweredBatches: 3,
      unansweredIds: 2,
      throttled: true,
    },
    [ANSWERED_FRIEND, UNANSWERED_FRIEND],
  );

  const outcome = await presenceService.pollAccountPresence(
    { id: ACCOUNT_ID, robloxUserId: ACCOUNT_ROBLOX_ID },
    TELEGRAM_ID,
  );

  assert.deepEqual(rec.notifications, [], 'no notifications for an empty map');
  assert.deepEqual(rec.updates, [], 'no writes for an empty map');
  assert.deepEqual(rec.sessions, [], 'no presence sessions for an empty map');
  assert.equal(outcome.batchesApplied, 0);
  assert.equal(outcome.unansweredIds, 2);
  assert.equal(outcome.throttled, true);
});

test('throttled partial cycle is reported as not clean', async () => {
  installStubs(partialFetch([presenceFor(1001, { userPresenceType: 1 })], 4), [ANSWERED_FRIEND], {
    openCooldown: true,
  });

  const cycle = await presenceService.pollAllPresence();

  assert.equal(cycle.throttled, true);
  assert.equal(cycle.halted, true, 'a throttled cycle must halt');
  assert.equal(cycle.batchesTotal, 4);
  assert.equal(cycle.batchesApplied, 1);
});

test('a globally-invalid cookie skips the account without issuing any request', async () => {
  const rec = installStubs(
    partialFetch([presenceFor(1001, { userPresenceType: 1 })], 4),
    [ANSWERED_FRIEND, UNANSWERED_FRIEND],
    { authInvalid: true },
  );

  const cycle = await presenceService.pollAllPresence();

  assert.equal(cycle.accountsSkippedUnauthenticated, 1);
  assert.equal(cycle.accountsPolled, 0);
  assert.equal(cycle.batchesTotal, 0, 'no batches may be attempted for an unauthenticated account');
  assert.deepEqual(rec.notifications, [], 'anonymous results must not drive notifications');
  assert.deepEqual(rec.updates, [], 'anonymous results must not be written');
});