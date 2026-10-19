/**
 * Regression tests: history must survive an unfriend / `/untrack`.
 *
 * THE BUG THIS PINS: `/history`, `/stats`, and `/gamestats` used to resolve and
 * scope users exclusively through the `Friend` / `TrackedUser` tables. Removal
 * from either list therefore made the user's (still intact) game and presence
 * sessions unreachable by username. The durable `SubjectIdentity` /
 * `SubjectUsername` tables now back resolution and scope.
 *
 * Every Prisma delegate is stubbed with ONE in-memory state object, so these
 * tests exercise the real service code paths (sync delete, untrack delete,
 * identity upserts, analytics queries, gamestats scope) without a database, and
 * can assert that removing a subject never touches session rows.
 *
 * Run:
 *   node --import tsx --test src/services/identity/history-preservation.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { prisma } from '../../lib/prisma.js';
import { syncService } from '../sync/sync.service.js';
import { trackService } from '../presence/track.service.js';
import { subjectIdentityService } from './subject-identity.service.js';
import { analyticsService } from '../analytics/analytics.service.js';
import { robloxService } from '../roblox/roblox.service.js';
import type { RobloxAccount } from '../../generated/prisma/client.js';

// ── In-memory state ───────────────────────────────────────────────────────────

interface FriendRow {
  robloxAccountId: number;
  friendUserId: bigint;
  username: string;
  displayName: string;
  lastSeenAt: Date | null;
}
interface TrackedRow {
  robloxAccountId: number;
  robloxUserId: bigint;
  username: string | null;
  displayName: string | null;
  lastSeenAt: Date | null;
}
interface IdentityRow {
  id: number;
  robloxAccountId: number;
  robloxUserId: bigint;
  username: string | null;
  displayName: string | null;
  lastSeenAt: Date | null;
  firstSeenAt: Date;
  lastResolvedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
interface UsernameRow {
  id: number;
  subjectIdentityId: number;
  username: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  isCurrent: boolean;
}
interface GameSessionRow {
  id: number;
  robloxAccountId: number;
  subjectId: bigint;
  subjectType: 'FRIEND' | 'TRACKED';
  placeId: bigint;
  universeId: bigint | null;
  serverId: string | null;
  gameName: string | null;
  startTime: Date;
  endTime: Date | null;
  duration: number | null;
}

interface State {
  friends: FriendRow[];
  tracked: TrackedRow[];
  identities: IdentityRow[];
  usernames: UsernameRow[];
  gameSessions: GameSessionRow[];
  presenceSessions: Array<{
    id: number;
    robloxAccountId: number;
    subjectId: bigint;
    subjectType: 'FRIEND' | 'TRACKED';
    presenceType: number;
    startTime: Date;
    endTime: Date | null;
    duration: number | null;
  }>;
  /** Every delete/update issued against the session tables (must stay empty). */
  sessionWrites: string[];
}

const ACC_A = 1;
const ACC_B = 2;

const ROB_ALICE = 1001n;
const ROB_BOB = 2002n;
const ROB_CAROL = 3003n;

let nextId = 1;
const now = new Date('2026-10-12T06:00:00Z');

function freshState(): State {
  nextId = 1;
  return {
    friends: [],
    tracked: [],
    identities: [],
    usernames: [],
    gameSessions: [],
    presenceSessions: [],
    sessionWrites: [],
  };
}

let state = freshState();

// ── Prisma stub ───────────────────────────────────────────────────────────────

/**
 * Minimal query engine for the handful of Prisma calls these services make.
 * `where` supports the flat equality / `in` / `not` shapes used in the code
 * plus a top-level `OR` of flat objects — enough to be faithful without a full
 * Prisma emulation.
 */
type Where = Record<string, unknown>;

function matchValue(value: unknown, condition: unknown): boolean {
  if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
    const c = condition as Record<string, unknown>;
    if ('in' in c) return (c['in'] as unknown[]).some((v) => matchValue(value, v));
    if ('not' in c) return !matchValue(value, c['not']);
    if ('equals' in c) return matchValue(value, c['equals']);
    return true;
  }
  // String equality models the production utf8mb4_unicode_ci collation, which is
  // case-insensitive and accent-insensitive — the username lookups depend on it.
  if (typeof value === 'string' && typeof condition === 'string') {
    return value.localeCompare(condition, 'en', { sensitivity: 'base' }) === 0;
  }
  return value === condition;
}

function matchRow(row: Record<string, unknown>, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (key === 'OR') {
      const options = condition as Where[];
      if (!options.some((opt) => matchRow(row, opt))) return false;
      continue;
    }
    if (key === 'usernames') {
      // Relation filter `{ some: { username } }`
      const some = (condition as { some?: Where }).some;
      const related = state.usernames.filter((u) => u.subjectIdentityId === row['id']);
      if (!some || !related.some((u) => matchRow(u as unknown as Record<string, unknown>, some))) {
        return false;
      }
      continue;
    }
    if (!matchValue(row[key], condition)) return false;
  }
  return true;
}

function applyOrderAndPaging<T extends Record<string, unknown>>(
  rows: T[],
  args: Record<string, unknown>,
): T[] {
  const orderBy = args['orderBy'];
  const orders = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  const sorted = [...rows];
  const toMs = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v ?? 0));
  for (const order of [...orders].reverse() as Array<Record<string, 'asc' | 'desc'>>) {
    const [field, dir] = Object.entries(order)[0] ?? [];
    if (!field) continue;
    sorted.sort((a, b) =>
      dir === 'desc' ? toMs(b[field]) - toMs(a[field]) : toMs(a[field]) - toMs(b[field]),
    );
  }
  const skip = typeof args['skip'] === 'number' ? args['skip'] : 0;
  const take = typeof args['take'] === 'number' ? args['take'] : undefined;
  return take === undefined ? sorted.slice(skip) : sorted.slice(skip, skip + take);
}

/** Projects `select`, dropping keys the caller did not ask for. */
function project<T extends Record<string, unknown>>(row: T, select: unknown): T {
  if (!select || typeof select !== 'object') return row;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(select as Record<string, unknown>)) out[k] = row[k];
  return out as T;
}

function installStubs(): void {
  state = freshState();
  const prismaAny = prisma as unknown as Record<string, Record<string, unknown>>;
  const ids = (): number => nextId++;

  prismaAny['friend'] = {
    findMany: async (args: { where?: Where; select?: unknown }) =>
      applyOrderAndPaging(state.friends as unknown as Record<string, unknown>[], args ?? {}).map(
        (r) => project(r, (args ?? {}).select),
      ),
    findFirst: async (args: { where?: Where; select?: unknown }) => {
      const found = applyOrderAndPaging(
        state.friends as unknown as Record<string, unknown>[],
        args ?? {},
      ).find((r) => matchRow(r, args?.where));
      return found ? project(found, (args ?? {}).select) : null;
    },
    upsert: async (args: {
      where: { robloxAccountId_friendUserId: { robloxAccountId: number; friendUserId: bigint } };
      create: Omit<FriendRow, 'lastSeenAt'>;
      update: Partial<FriendRow>;
    }) => {
      const { robloxAccountId, friendUserId } = args.where.robloxAccountId_friendUserId;
      const existing = state.friends.find(
        (f) => f.robloxAccountId === robloxAccountId && f.friendUserId === friendUserId,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const row: FriendRow = { lastSeenAt: null, ...args.create };
      state.friends.push(row);
      return row;
    },
    deleteMany: async (args: { where: Where }) => {
      const before = state.friends.length;
      state.friends = state.friends.filter((f) => !matchRow(f as unknown as Where, args.where));
      return { count: before - state.friends.length };
    },
    update: async (args: { where: { id: number }; data: Partial<FriendRow> }) => {
      const row = state.friends.find((f) => (f as unknown as { id?: number }).id === args.where.id);
      if (row) Object.assign(row, args.data);
      return row;
    },
  };

  prismaAny['trackedUser'] = {
    findMany: async (args: { where?: Where; select?: unknown }) =>
      applyOrderAndPaging(state.tracked as unknown as Record<string, unknown>[], args ?? {}).map(
        (r) => project(r, (args ?? {}).select),
      ),
    findFirst: async (args: { where?: Where }) =>
      state.tracked.find((t) => matchRow(t as unknown as Where, args?.where)) ?? null,
    upsert: async (args: {
      where: { robloxAccountId_robloxUserId: { robloxAccountId: number; robloxUserId: bigint } };
      create: Omit<TrackedRow, 'lastSeenAt'>;
      update: Partial<TrackedRow>;
    }) => {
      const { robloxAccountId, robloxUserId } = args.where.robloxAccountId_robloxUserId;
      const existing = state.tracked.find(
        (t) => t.robloxAccountId === robloxAccountId && t.robloxUserId === robloxUserId,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const row: TrackedRow = { lastSeenAt: null, ...args.create };
      state.tracked.push(row);
      return row;
    },
    deleteMany: async (args: { where: Where }) => {
      const before = state.tracked.length;
      state.tracked = state.tracked.filter((t) => !matchRow(t as unknown as Where, args.where));
      return { count: before - state.tracked.length };
    },
    update: async (args: { where: { id: number }; data: Partial<TrackedRow> }) => {
      const row = state.tracked.find((t) => (t as unknown as { id?: number }).id === args.where.id);
      if (row) Object.assign(row, args.data);
      return row;
    },
  };

  prismaAny['subjectIdentity'] = {
    findMany: async (args: { where?: Where; select?: unknown; distinct?: unknown }) =>
      applyOrderAndPaging(state.identities as unknown as Record<string, unknown>[], args ?? {})
        .filter((r) => matchRow(r, args?.where))
        .map((r) => project(r, (args ?? {}).select)),
    findFirst: async (args: { where?: Where; select?: unknown }) => {
      const found = applyOrderAndPaging(
        state.identities as unknown as Record<string, unknown>[],
        args ?? {},
      ).find((r) => matchRow(r, args?.where));
      return found ? project(found, (args ?? {}).select) : null;
    },
    findUnique: async (args: {
      where: { robloxAccountId_robloxUserId: { robloxAccountId: number; robloxUserId: bigint } };
    }) => {
      const { robloxAccountId, robloxUserId } = args.where.robloxAccountId_robloxUserId;
      return (
        state.identities.find(
          (i) => i.robloxAccountId === robloxAccountId && i.robloxUserId === robloxUserId,
        ) ?? null
      );
    },
    upsert: async (args: {
      where: { robloxAccountId_robloxUserId: { robloxAccountId: number; robloxUserId: bigint } };
      create: Partial<IdentityRow>;
      update: Partial<IdentityRow>;
      select?: unknown;
    }) => {
      const { robloxAccountId, robloxUserId } = args.where.robloxAccountId_robloxUserId;
      let row = state.identities.find(
        (i) => i.robloxAccountId === robloxAccountId && i.robloxUserId === robloxUserId,
      );
      if (row) {
        Object.assign(row, args.update);
      } else {
        row = {
          id: ids(),
          robloxAccountId,
          robloxUserId,
          username: null,
          displayName: null,
          lastSeenAt: null,
          firstSeenAt: now,
          lastResolvedAt: now,
          createdAt: now,
          updatedAt: now,
          ...args.create,
        };
        state.identities.push(row);
      }
      return project(row as unknown as Record<string, unknown>, args.select);
    },
  };

  prismaAny['subjectUsername'] = {
    updateMany: async (args: { where: Where; data: Partial<UsernameRow> }) => {
      let count = 0;
      for (const u of state.usernames) {
        if (matchRow(u as unknown as Where, args.where)) {
          Object.assign(u, args.data);
          count += 1;
        }
      }
      return { count };
    },
    upsert: async (args: {
      where: { subjectIdentityId_username: { subjectIdentityId: number; username: string } };
      create: Omit<UsernameRow, 'id'>;
      update: Partial<UsernameRow>;
    }) => {
      const { subjectIdentityId, username } = args.where.subjectIdentityId_username;
      const existing = state.usernames.find(
        (u) => u.subjectIdentityId === subjectIdentityId && u.username === username,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const row: UsernameRow = { id: ids(), ...args.create };
      state.usernames.push(row);
      return row;
    },
  };

  prismaAny['gameSession'] = {
    findMany: async (args: { where?: Where; select?: unknown }) =>
      applyOrderAndPaging(
        state.gameSessions as unknown as Record<string, unknown>[],
        args ?? {},
      )
        .filter((r) => matchRow(r, args?.where))
        .map((r) => project(r, (args ?? {}).select)),
    findFirst: async (args: { where?: Where; select?: unknown }) => {
      const found = applyOrderAndPaging(
        state.gameSessions as unknown as Record<string, unknown>[],
        args ?? {},
      ).find((r) => matchRow(r, args?.where));
      return found ? project(found, (args ?? {}).select) : null;
    },
    create: async () => {
      state.sessionWrites.push('gameSession.create');
      throw new Error('not expected');
    },
    update: async () => {
      state.sessionWrites.push('gameSession.update');
      throw new Error('not expected');
    },
    updateMany: async () => {
      state.sessionWrites.push('gameSession.updateMany');
      return { count: 0 };
    },
    deleteMany: async () => {
      state.sessionWrites.push('gameSession.deleteMany');
      return { count: 0 };
    },
  };

  prismaAny['presenceSession'] = {
    findMany: async (args: { where?: Where; select?: unknown }) =>
      applyOrderAndPaging(
        state.presenceSessions as unknown as Record<string, unknown>[],
        args ?? {},
      )
        .filter((r) => matchRow(r, args?.where))
        .map((r) => project(r, (args ?? {}).select)),
    findFirst: async (args: { where?: Where; select?: unknown }) => {
      const found = applyOrderAndPaging(
        state.presenceSessions as unknown as Record<string, unknown>[],
        args ?? {},
      ).find((r) => matchRow(r, args?.where));
      return found ? project(found, (args ?? {}).select) : null;
    },
    deleteMany: async () => {
      state.sessionWrites.push('presenceSession.deleteMany');
      return { count: 0 };
    },
  };

  const robloxAny = robloxService as unknown as Record<string, unknown>;
  robloxAny['getFriends'] = async () => [
    { id: '1001', name: 'Alice', displayName: 'Alice' },
  ];
  robloxAny['getUsersBatch'] = async (
    _cookie: string,
    userIds: number[],
  ): Promise<Array<{ id: number; name: string; displayName: string }>> =>
    userIds.map((id) => ({ id, name: `User_${id}`, displayName: `User ${id}` }));
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function seedFriend(accountId: number, id: bigint, username: string): void {
  state.friends.push({
    robloxAccountId: accountId,
    friendUserId: id,
    username,
    displayName: username,
    lastSeenAt: new Date('2026-10-12T05:55:00Z'),
  });
}

function seedTracked(accountId: number, id: bigint, username: string): void {
  state.tracked.push({
    robloxAccountId: accountId,
    robloxUserId: id,
    username,
    displayName: username,
    lastSeenAt: new Date('2026-10-12T05:55:00Z'),
  });
}

function seedGameSession(
  accountId: number,
  subjectId: bigint,
  start: string,
  end: string | null,
  gameName: string,
): void {
  const startDate = new Date(start);
  const endDate = end === null ? null : new Date(end);
  state.gameSessions.push({
    id: nextId++,
    robloxAccountId: accountId,
    subjectId,
    subjectType: 'TRACKED',
    placeId: 9522n,
    universeId: 9970645639n,
    serverId: null,
    gameName,
    startTime: startDate,
    endTime: endDate,
    duration: endDate ? Math.floor((endDate.getTime() - startDate.getTime()) / 1000) : null,
  });
}

function seedPresenceSession(accountId: number, subjectId: bigint, type: number, start: string): void {
  state.presenceSessions.push({
    id: nextId++,
    robloxAccountId: accountId,
    subjectId,
    subjectType: 'TRACKED',
    presenceType: type,
    startTime: new Date(start),
    endTime: new Date('2026-10-12T06:00:00Z'),
    duration: 3600,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('untrack: only the tracking row is removed; identity + sessions survive', async () => {
  installStubs();
  await trackService.trackUser(ACC_A, { id: Number(ROB_ALICE), name: 'Alice', displayName: 'Alice' } as never);
  seedGameSession(ACC_A, ROB_ALICE, '2026-10-11T10:00:00Z', '2026-10-11T11:00:00Z', 'Adopt Me');
  seedPresenceSession(ACC_A, ROB_ALICE, 2, '2026-10-11T10:00:00Z');

  const sessionsBefore = structuredClone(state.gameSessions);
  const presenceBefore = structuredClone(state.presenceSessions);

  const removed = await trackService.untrackUser(ACC_A, 'Alice');
  assert.equal(removed, true);
  assert.equal(state.tracked.length, 0, 'tracking row removed');
  assert.equal(state.identities.length, 1, 'identity row survives');
  assert.equal(state.usernames.length, 1, 'username history survives');
  assert.deepEqual(state.gameSessions, sessionsBefore, 'game sessions untouched');
  assert.deepEqual(state.presenceSessions, presenceBefore, 'presence sessions untouched');
  assert.deepEqual(state.sessionWrites, [], 'no session write issued by untrack');

  // The removed user remains resolvable by username.
  assert.equal(await analyticsService.getSubjectByName(ACC_A, 'alice'), ROB_ALICE);
  assert.equal(await analyticsService.getSubjectByName(ACC_A, '@Alice'), ROB_ALICE);

  // History and stats still return the historical data.
  const history = await analyticsService.getRecentSessions(ACC_A, 15, ROB_ALICE, 0);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.gameName, 'Adopt Me');

  const stats = await analyticsService.getPlaytimeStats(ACC_A, 'all', ROB_ALICE);
  assert.deepEqual(stats, [{ game: 'Adopt Me', duration: 3600 }]);

  const presence = await analyticsService.getPresenceStats(ACC_A, 'all', ROB_ALICE);
  assert.deepEqual(presence, [{ type: 'Game', duration: 3600 }]);
});

test('unfriend via /sync: identity recorded before delete, sessions untouched', async () => {
  installStubs();
  // Alice is currently a friend; Bob is the friend that Roblox no longer returns.
  seedFriend(ACC_A, ROB_ALICE, 'Alice');
  seedFriend(ACC_A, ROB_BOB, 'Bob');
  await subjectIdentityService.backfill(ACC_A);
  seedGameSession(ACC_A, ROB_BOB, '2026-10-10T10:00:00Z', '2026-10-10T12:00:00Z', 'Bee Swarm');

  const sessionsBefore = structuredClone(state.gameSessions);
  const account = { id: ACC_A, robloxUserId: 999n } as unknown as RobloxAccount;
  const result = await syncService.syncFriends(account, 'cookie');

  assert.deepEqual(result.removed.map((r) => r.robloxUserId), [ROB_BOB]);
  assert.deepEqual(
    state.friends.map((f) => f.friendUserId),
    [ROB_ALICE],
    'only the removed friend row is deleted',
  );
  assert.deepEqual(state.gameSessions, sessionsBefore, 'game sessions untouched');
  assert.deepEqual(state.sessionWrites, [], 'no session write issued by sync');

  // Bob resolves and his history is intact after the unfriend.
  assert.equal(await analyticsService.getSubjectByName(ACC_A, 'bob'), ROB_BOB);
  const history = await analyticsService.getRecentSessions(ACC_A, 15, ROB_BOB, 0);
  assert.equal(history.length, 1);

  // The name map no longer degrades to a raw id for the removed friend.
  const names = await analyticsService.getSubjectNames(ACC_A, [ROB_BOB]);
  assert.equal(names.get(ROB_BOB), 'Bob (@bob)');
});

test('username history: a renamed user stays searchable by the old handle', async () => {
  installStubs();
  await trackService.trackUser(ACC_A, { id: Number(ROB_CAROL), name: 'CarolOld', displayName: 'Carol' } as never);
  // Roblox rename observed during a later refresh.
  await subjectIdentityService.remember({
    robloxAccountId: ACC_A,
    subjectId: ROB_CAROL,
    username: 'CarolNew',
    displayName: 'Carol',
  });
  await trackService.untrackUser(ACC_A, 'CarolNew');

  assert.equal(await analyticsService.getSubjectByName(ACC_A, 'CarolOld'), ROB_CAROL, 'old handle');
  assert.equal(await analyticsService.getSubjectByName(ACC_A, 'carolnew'), ROB_CAROL, 'new handle');

  const identity = state.identities[0]!;
  assert.equal(identity.username, 'carolnew', 'current handle is the newest one');
  const flags = state.usernames.filter((u) => u.subjectIdentityId === identity.id && u.isCurrent);
  assert.equal(flags.length, 1, 'exactly one current handle');
  assert.equal(flags[0]!.username, 'carolnew');
  assert.equal(
    state.usernames.filter((u) => u.subjectIdentityId === identity.id).length,
    2,
    'both handles retained',
  );
});

test('account isolation: identity and resolution never cross connected accounts', async () => {
  installStubs();
  // The same Roblox user is monitored by two accounts with different handles.
  await trackService.trackUser(ACC_A, { id: Number(ROB_ALICE), name: 'AliceA', displayName: 'Alice A' } as never);
  await trackService.trackUser(ACC_B, { id: Number(ROB_ALICE), name: 'AliceB', displayName: 'Alice B' } as never);
  await trackService.untrackUser(ACC_A, 'AliceA');
  await trackService.untrackUser(ACC_B, 'AliceB');

  assert.equal(state.identities.length, 2, 'one identity row per account');

  assert.equal(await analyticsService.getSubjectByName(ACC_A, 'AliceA'), ROB_ALICE);
  assert.equal(await analyticsService.getSubjectByName(ACC_A, 'AliceB'), null, 'no cross-account leak');
  assert.equal(await analyticsService.getSubjectByName(ACC_B, 'AliceB'), ROB_ALICE);
  assert.equal(await analyticsService.getSubjectByName(ACC_B, 'AliceA'), null, 'no cross-account leak');

  const namesA = await analyticsService.getSubjectNames(ACC_A, [ROB_ALICE]);
  assert.equal(namesA.get(ROB_ALICE), 'Alice A (@alicea)');
  const namesB = await analyticsService.getSubjectNames(ACC_B, [ROB_ALICE]);
  assert.equal(namesB.get(ROB_ALICE), 'Alice B (@aliceb)');
});

test('pagination and date filtering are preserved for historical users', async () => {
  installStubs();
  await trackService.trackUser(ACC_A, { id: Number(ROB_ALICE), name: 'Alice', displayName: 'Alice' } as never);
  await trackService.untrackUser(ACC_A, 'Alice');

  // 18 sessions on distinct hours across two days.
  for (let i = 0; i < 18; i++) {
    const day = i < 10 ? 11 : 12;
    const hour = String(i % 10 + 10).padStart(2, '0');
    seedGameSession(
      ACC_A,
      ROB_ALICE,
      `2026-10-${day}T${hour}:00:00Z`,
      `2026-10-${day}T${hour}:30:00Z`,
      `Game ${i}`,
    );
  }

  const page1 = await analyticsService.getRecentSessions(ACC_A, 15, ROB_ALICE, 0);
  const page2 = await analyticsService.getRecentSessions(ACC_A, 15, ROB_ALICE, 15);
  assert.equal(page1.length, 15);
  assert.equal(page2.length, 3);
  assert.equal(new Set([...page1, ...page2].map((s) => s.id)).size, 18, 'no overlap between pages');

  // Date-filtered query (local date window, same semantics as before).
  const day11 = new Date(2026, 9, 11);
  const day11Sessions = await analyticsService.getSessionsForDate(ACC_A, day11, 100, ROB_ALICE, 0);
  // Sessions are seeded in UTC; the local day window is computed with local time,
  // so just assert the filter is applied consistently to the historical user.
  assert.ok(day11Sessions.length > 0, 'date filter finds historical sessions');
  const allSessions = await analyticsService.getSessionsForDate(ACC_A, day11, 100, undefined, 0);
  assert.equal(day11Sessions.length, allSessions.length, 'no other subject is present');
});

test('backfill rebuilds identities for users removed before the feature existed', async () => {
  installStubs();
  // Historical state: a session exists, but neither list nor identity has a row.
  seedGameSession(ACC_B, ROB_BOB, '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z', 'Legacy Game');
  seedPresenceSession(ACC_B, ROB_BOB, 2, '2026-09-01T10:00:00Z');

  assert.equal(await analyticsService.getSubjectByName(ACC_B, 'bob'), null, 'not resolvable yet');

  const count = await subjectIdentityService.backfill();
  assert.equal(count, 1, 'one identity row created from the session history');
  assert.equal(state.identities.length, 1);

  const identity = state.identities.find((i) => i.robloxAccountId === ACC_B);
  assert.ok(identity);
  assert.equal(identity.robloxUserId, ROB_BOB);
  assert.equal(identity.lastSeenAt?.toISOString(), '2026-09-01T11:00:00.000Z', 'lastSeenAt from newest session');

  // Sessions are addressable by id, and stay intact.
  const history = await analyticsService.getRecentSessions(ACC_B, 15, ROB_BOB, 0);
  assert.equal(history.length, 1);
  assert.deepEqual(state.sessionWrites, []);
});

test('last-seen falls back to session history for untracked users', async () => {
  installStubs();
  seedGameSession(ACC_A, ROB_ALICE, '2026-10-01T10:00:00Z', '2026-10-01T12:30:00Z', 'Game');
  const lastSeen = await analyticsService.getSubjectLastSeenAt(ACC_A, ROB_ALICE);
  assert.equal(lastSeen?.toISOString(), '2026-10-01T12:30:00.000Z');
});

test('name precedence: a current member wins over a historical user with the same handle', async () => {
  installStubs();
  // Historical user (removed) whose old handle matches a CURRENT friend's handle.
  await trackService.trackUser(ACC_A, { id: Number(ROB_CAROL), name: 'Shared', displayName: 'Carol' } as never);
  await trackService.untrackUser(ACC_A, 'Shared');
  seedFriend(ACC_A, ROB_ALICE, 'Shared');

  assert.equal(
    await analyticsService.getSubjectByName(ACC_A, 'Shared'),
    ROB_ALICE,
    'the current friend must win, as it did before identity history existed',
  );

  const names = await analyticsService.getSubjectNames(ACC_A, [ROB_ALICE, ROB_CAROL]);
  assert.equal(names.get(ROB_ALICE), 'Shared (@Shared)', 'current friend keeps its live name');
  assert.equal(names.get(ROB_CAROL), 'Carol (@shared)', 'historical user still labelled');
});
