/**
 * SubjectIdentityService
 *
 * Durable per-account identity for every Roblox user a connected account has
 * ever monitored. This is the table that keeps history resolvable after the
 * user leaves the CURRENT lists:
 *
 *   - `Friend` / `TrackedUser` = who we watch right now (deleted on unfriend or
 *     `/untrack`, by design).
 *   - `SubjectIdentity`       = who we have EVER watched, with their Roblox user
 *     id as the canonical key.
 *   - `SubjectUsername`       = every handle ever observed for that id, so a
 *     user stays searchable after a Roblox username change.
 *
 * Three entry points:
 *   - `remember()`         — called on every observation (sync, track, presence
 *                            poll), and once more before a removal, so the
 *                            handle is recorded even if nothing else did.
 *   - `backfill()`         — re-derives identities from the current tables +
 *                            existing sessions, so historical rows predating the
 *                            feature are still found.
 *   - `resolveByName()` / `resolveAll()` — read paths used by `/history`,
 *     `/stats`, and `/gamestats`.
 *
 * Removal (unfriend / `/untrack`) never calls anything here that deletes: those
 * flows only `remember()` the subject before deleting the list row.
 */

import { prisma } from '../../lib/prisma.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Canonical identity of one monitored Roblox user within one account. */
export interface ResolvedSubject {
  robloxAccountId: number;
  subjectId: bigint;
  username: string | null;
  displayName: string | null;
  /** True when the user is still a current friend or tracked user. */
  current: boolean;
  /** 'tracked' takes precedence when a user is both a friend and tracked. */
  kind: 'tracked' | 'friend';
}

/** Profile fields observed for a subject (any may be unknown). */
export interface ObservedSubject {
  robloxAccountId: number;
  subjectId: bigint;
  username?: string | null;
  displayName?: string | null;
  /** Presence poll time; only forwarded when the service actually observed it. */
  lastSeenAt?: Date | null;
}

/** Normalises a username for case-insensitive storage/lookup (`@` stripped). */
export function normalizeUsername(name: string): string {
  return name.trim().replace(/^@/, '').toLowerCase();
}

// ── Service ───────────────────────────────────────────────────────────────────

export const subjectIdentityService = {
  // ── remember ────────────────────────────────────────────────────────────────
  /**
   * Records (or refreshes) the identity of a subject and its username history.
   *
   * Best-effort: identity bookkeeping must never fail a sync, a track, or a
   * presence poll, so any error is logged and swallowed.
   */
  async remember(subject: ObservedSubject): Promise<void> {
    const robloxAccountId = subject.robloxAccountId;
    const robloxUserId = subject.subjectId;
    const rawUsername = subject.username?.trim() ?? '';
    const username = rawUsername === '' ? null : normalizeUsername(rawUsername);
    const displayName = subject.displayName?.trim() || null;
    const now = new Date();
    const lastSeenAt = subject.lastSeenAt ?? null;

    try {
      // 1. Upsert the identity row. Username/displayName are only overwritten
      //    when a real value is known, so a poll that carries no profile data
      //    never erases what a sync previously learned.
      const identity = await prisma.subjectIdentity.upsert({
        where: {
          robloxAccountId_robloxUserId: { robloxAccountId, robloxUserId },
        },
        create: {
          robloxAccountId,
          robloxUserId,
          username,
          displayName,
          lastSeenAt,
          lastResolvedAt: now,
        },
        update: {
          ...(username !== null ? { username } : {}),
          ...(displayName !== null ? { displayName } : {}),
          ...(lastSeenAt !== null ? { lastSeenAt } : {}),
          ...(username !== null || displayName !== null ? { lastResolvedAt: now } : {}),
        },
        select: { id: true },
      });

      if (username === null) return;

      // 2. Record the handle in the history. Every previous handle stays
      //    searchable; only the newest is marked current.
      await prisma.subjectUsername.updateMany({
        where: { subjectIdentityId: identity.id, username: { not: username }, isCurrent: true },
        data: { isCurrent: false },
      });
      await prisma.subjectUsername.upsert({
        where: {
          subjectIdentityId_username: { subjectIdentityId: identity.id, username },
        },
        create: {
          subjectIdentityId: identity.id,
          username,
          firstSeenAt: now,
          lastSeenAt: now,
          isCurrent: true,
        },
        update: { lastSeenAt: now, isCurrent: true },
      });
    } catch (err) {
      console.warn(
        `[SubjectIdentity] Failed to remember ${robloxUserId} for account ${robloxAccountId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },

  /** Records many observations sequentially (best-effort, order preserved). */
  async rememberMany(subjects: ObservedSubject[]): Promise<void> {
    for (const subject of subjects) {
      await this.remember(subject);
    }
  },

  // ── backfill ────────────────────────────────────────────────────────────────
  /**
   * Re-derives identities for one account (or every account when `null`) from:
   *   1. current `Friend` rows,
   *   2. current `TrackedUser` rows,
   *   3. distinct subjects present in `GameSession` / `PresenceSession`.
   *
   * Step 3 is what recovers users who were removed *before* their identity was
   * ever recorded (e.g. history predating the migration), so their sessions
   * remain addressable. Returns the number of identities touched.
   */
  async backfill(accountId: number | null = null): Promise<number> {
    const accountFilter = accountId === null ? {} : { robloxAccountId: accountId };

    const [friends, tracked, gameSubjects, presenceSubjects] = await Promise.all([
      prisma.friend.findMany({
        where: accountFilter,
        select: {
          robloxAccountId: true,
          friendUserId: true,
          username: true,
          displayName: true,
          lastSeenAt: true,
        },
      }),
      prisma.trackedUser.findMany({
        where: accountFilter,
        select: {
          robloxAccountId: true,
          robloxUserId: true,
          username: true,
          displayName: true,
          lastSeenAt: true,
        },
      }),
      prisma.gameSession.findMany({
        where: accountFilter,
        distinct: ['robloxAccountId', 'subjectId'],
        select: { robloxAccountId: true, subjectId: true },
      }),
      prisma.presenceSession.findMany({
        where: accountFilter,
        distinct: ['robloxAccountId', 'subjectId'],
        select: { robloxAccountId: true, subjectId: true },
      }),
    ]);

    const known = new Set<string>();
    const key = (acc: number, id: bigint): string => `${acc}:${id.toString()}`;
    const observed: ObservedSubject[] = [];

    for (const f of friends) {
      const k = key(f.robloxAccountId, f.friendUserId);
      if (known.has(k)) continue;
      known.add(k);
      observed.push({
        robloxAccountId: f.robloxAccountId,
        subjectId: f.friendUserId,
        username: f.username,
        displayName: f.displayName,
        lastSeenAt: f.lastSeenAt,
      });
    }
    for (const t of tracked) {
      const k = key(t.robloxAccountId, t.robloxUserId);
      if (known.has(k)) continue;
      known.add(k);
      observed.push({
        robloxAccountId: t.robloxAccountId,
        subjectId: t.robloxUserId,
        username: t.username,
        displayName: t.displayName,
        lastSeenAt: t.lastSeenAt,
      });
    }
    // Session-only subjects: ensure a row exists. When the identity never
    // recorded a poll time, seed it from the newest closed session so open-
    // session capping keeps working for historical users (mirrors the SQL
    // backfill in the migration).
    for (const s of [...gameSubjects, ...presenceSubjects]) {
      const k = key(s.robloxAccountId, s.subjectId);
      if (known.has(k)) continue;
      known.add(k);
      const lastEnd = await prisma.gameSession.findFirst({
        where: {
          robloxAccountId: s.robloxAccountId,
          subjectId: s.subjectId,
          endTime: { not: null },
        },
        orderBy: [{ endTime: 'desc' }],
        select: { endTime: true },
      });
      observed.push({
        robloxAccountId: s.robloxAccountId,
        subjectId: s.subjectId,
        lastSeenAt: lastEnd?.endTime ?? null,
      });
    }

    await this.rememberMany(observed);
    return observed.length;
  },

  // ── resolveByName ───────────────────────────────────────────────────────────
  /**
   * Resolves a subject from any username/display name it has ever had.
   *
   * Order — every step is account-scoped and never crosses accounts:
   *   1. current friends, then tracked users (the original precedence),
   *   2. durable `SubjectIdentity`: current handle, any historical handle from
   *      `SubjectUsername`, or display name.
   *
   * A `subjects` map may be supplied by callers that already loaded the scope;
   * its iteration order (current members first, then history — see
   * `resolveAll`) then provides step 1–2 in a single pass without re-querying.
   */
  async resolveByName(
    accountId: number | null,
    name: string,
    subjects?: Map<bigint, ResolvedSubject>,
  ): Promise<ResolvedSubject | null> {
    const needle = normalizeUsername(name);
    if (needle === '') return null;
    const displayNeedle = name.replace(/^@/, '').trim().toLowerCase();

    // 1–2. Current handle / display name from the in-memory scope.
    if (subjects) {
      for (const subject of subjects.values()) {
        const usernameMatches =
          subject.username !== null && normalizeUsername(subject.username) === needle;
        const displayMatches =
          subject.displayName !== null && subject.displayName.toLowerCase() === displayNeedle;
        if (usernameMatches || displayMatches) return subject;
      }
    } else {
      // No scope supplied: check the current lists directly first, so a live
      // friend/tracked user always outranks a historical namesake — the exact
      // precedence the original friend-then-tracked lookup had.
      const currentWhere = {
        ...(accountId === null ? {} : { robloxAccountId: accountId }),
        OR: [
          { username: { equals: needle } },
          { displayName: { equals: displayNeedle } },
        ],
      };

      const friend = await prisma.friend.findFirst({
        where: currentWhere,
        select: { robloxAccountId: true, friendUserId: true, username: true, displayName: true },
      });
      if (friend) {
        return {
          robloxAccountId: friend.robloxAccountId,
          subjectId: friend.friendUserId,
          username: friend.username,
          displayName: friend.displayName,
          current: true,
          kind: 'friend',
        };
      }

      const tracked = await prisma.trackedUser.findFirst({
        where: currentWhere,
        select: { robloxAccountId: true, robloxUserId: true, username: true, displayName: true },
      });
      if (tracked) {
        return {
          robloxAccountId: tracked.robloxAccountId,
          subjectId: tracked.robloxUserId,
          username: tracked.username,
          displayName: tracked.displayName,
          current: true,
          kind: 'tracked',
        };
      }
    }

    // 3. Persistent identity: current handle, any historical handle, or display
    //    name. This is what makes an unfriended/untracked user resolvable.
    const identity = await prisma.subjectIdentity.findFirst({
      where: {
        ...(accountId === null ? {} : { robloxAccountId: accountId }),
        OR: [
          { username: needle },
          { usernames: { some: { username: needle } } },
          { displayName: { equals: displayNeedle } },
        ],
      },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
      select: {
        robloxAccountId: true,
        robloxUserId: true,
        username: true,
        displayName: true,
      },
    });
    if (!identity) return null;

    const cached = subjects?.get(identity.robloxUserId);
    if (cached) return cached;

    return {
      robloxAccountId: identity.robloxAccountId,
      subjectId: identity.robloxUserId,
      username: identity.username,
      displayName: identity.displayName,
      current: false,
      kind: 'friend',
    };
  },

  // ── resolveAll ──────────────────────────────────────────────────────────────
  /**
   * Builds the full subject map for one account: every friend, every tracked
   * user, and every user with durable identity history.
   *
   * `filter` narrows the identity scan (used by `/gamestats` to avoid loading
   * the entire history for a single-game query).
   */
  async resolveAll(
    accountId: number | null,
    filter: { subjectIds?: bigint[] } = {},
  ): Promise<Map<bigint, ResolvedSubject>> {
    const accountWhere = accountId === null ? {} : { robloxAccountId: accountId };
    const idWhere =
      filter.subjectIds === undefined ? {} : { robloxUserId: { in: filter.subjectIds } };

    const [friends, tracked, identities] = await Promise.all([
      prisma.friend.findMany({
        where: accountWhere,
        select: {
          robloxAccountId: true,
          friendUserId: true,
          username: true,
          displayName: true,
        },
      }),
      prisma.trackedUser.findMany({
        where: accountWhere,
        select: {
          robloxAccountId: true,
          robloxUserId: true,
          username: true,
          displayName: true,
        },
      }),
      prisma.subjectIdentity.findMany({
        where: { ...accountWhere, ...idWhere },
        select: {
          robloxAccountId: true,
          robloxUserId: true,
          username: true,
          displayName: true,
        },
      }),
    ]);

    const map = new Map<bigint, ResolvedSubject>();

    for (const f of friends) {
      map.set(f.friendUserId, {
        robloxAccountId: f.robloxAccountId,
        subjectId: f.friendUserId,
        username: f.username,
        displayName: f.displayName,
        current: true,
        kind: 'friend',
      });
    }
    // Tracked wins on conflict: presence polling dedups this way.
    for (const t of tracked) {
      map.set(t.robloxUserId, {
        robloxAccountId: t.robloxAccountId,
        subjectId: t.robloxUserId,
        username: t.username,
        displayName: t.displayName,
        current: true,
        kind: 'tracked',
      });
    }
    // Identity rows fill in removed/renamed users only where no current row
    // exists. Inserted last so name-resolution scans see live subjects first,
    // preserving the previous precedence.
    for (const i of identities) {
      if (map.has(i.robloxUserId)) continue;
      map.set(i.robloxUserId, {
        robloxAccountId: i.robloxAccountId,
        subjectId: i.robloxUserId,
        username: i.username,
        displayName: i.displayName,
        current: false,
        kind: 'friend',
      });
    }

    return map;
  },
};
