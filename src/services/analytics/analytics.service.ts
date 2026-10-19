import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { robloxService } from '../roblox/roblox.service.js';
import { accountService } from '../account/account.service.js';
import { subjectIdentityService } from '../identity/subject-identity.service.js';

export const analyticsService = {
  /**
   * Get all active game sessions for an account (or globally if accountId is null)
   */
  async getActiveSessions(accountId: number | null) {
    const where: Prisma.GameSessionWhereInput = { endTime: null };
    if (accountId !== null) {
      where.robloxAccountId = accountId;
    }
    return prisma.gameSession.findMany({
      where,
      orderBy: {
        startTime: 'desc',
      },
    });
  },

  /**
   * Get all active website sessions for an account (or globally if accountId is null)
   */
  async getActiveWebsiteSessions(accountId: number | null) {
    const where: Prisma.PresenceSessionWhereInput = {
      presenceType: 1, // 1 = Website
      endTime: null,
    };
    if (accountId !== null) {
      where.robloxAccountId = accountId;
    }
    return prisma.presenceSession.findMany({
      where,
      orderBy: {
        startTime: 'desc',
      },
    });
  },

  /**
   * Get recent completed game sessions
   */
  async getRecentSessions(accountId: number | null, limit = 10, subjectId?: bigint, offset = 0) {
    const where: Prisma.GameSessionWhereInput = {
      endTime: { not: null },
    };
    if (accountId !== null) {
      where.robloxAccountId = accountId;
    }

    if (subjectId) {
      where.subjectId = subjectId;
    }

    return prisma.gameSession.findMany({
      where,
      orderBy: {
        startTime: 'desc',
      },
      take: limit,
      skip: offset,
    });
  },

  /**
   * Get total playtime grouped by game over the last N days
   */
  async getPlaytimeStats(accountId: number | null, days: number | 'all' = 7, subjectId?: bigint) {
    const where: Prisma.GameSessionWhereInput = {
      duration: { not: null },
    };
    if (accountId !== null) {
      where.robloxAccountId = accountId;
    }

    if (subjectId) {
      where.subjectId = subjectId;
    }

    if (days !== 'all') {
      const since = new Date();
      since.setDate(since.getDate() - days);
      where.startTime = { gte: since };
    }

    const sessions = await prisma.gameSession.findMany({
      where,
    });

    const stats = new Map<string, number>();

    for (const session of sessions) {
      if (!session.duration) continue;
      // Group by gameName or placeholder
      const key = session.gameName || `Place ID: ${session.placeId}`;
      const current = stats.get(key) || 0;
      stats.set(key, current + session.duration);
    }

    // Sort by duration descending
    return Array.from(stats.entries())
      .map(([game, duration]) => ({ game, duration }))
      .sort((a, b) => b.duration - a.duration);
  },

  /**
   * Get total presence playtime grouped by presence type over the last N days
   */
  async getPresenceStats(accountId: number | null, days: number | 'all' = 7, subjectId?: bigint) {
    const where: Prisma.PresenceSessionWhereInput = {
      duration: { not: null },
    };
    if (accountId !== null) {
      where.robloxAccountId = accountId;
    }

    if (subjectId) {
      where.subjectId = subjectId;
    }

    if (days !== 'all') {
      const since = new Date();
      since.setDate(since.getDate() - days);
      where.startTime = { gte: since };
    }

    const sessions = await prisma.presenceSession.findMany({
      where,
    });

    const stats = new Map<number, number>();

    for (const session of sessions) {
      if (!session.duration) continue;
      const key = session.presenceType;
      const current = stats.get(key) || 0;
      stats.set(key, current + session.duration);
    }

    const typeNames: Record<number, string> = {
      0: 'Offline',
      1: 'Website',
      2: 'Game',
      3: 'Studio',
    };

    return Array.from(stats.entries())
      .map(([type, duration]) => ({ type: typeNames[type] || 'Unknown', duration }))
      .sort((a, b) => b.duration - a.duration);
  },

  /**
   * Get presence summary for a single date
   */
  async getPresenceSummaryForDate(accountId: number | null, subjectId: bigint, targetDate: Date) {
    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);

    const where: Prisma.PresenceSessionWhereInput = {
      subjectId,
      startTime: {
        gte: targetDate,
        lt: nextDay,
      },
      duration: { not: null },
    };
    if (accountId !== null) {
      where.robloxAccountId = accountId;
    }

    const sessions = await prisma.presenceSession.findMany({
      where,
    });

    const stats = new Map<number, number>();

    for (const session of sessions) {
      if (!session.duration) continue;
      const key = session.presenceType;
      const current = stats.get(key) || 0;
      stats.set(key, current + session.duration);
    }

    const typeNames: Record<number, string> = {
      0: 'Offline',
      1: 'Website',
      2: 'Game',
      3: 'Studio',
    };

    return Array.from(stats.entries())
      .map(([type, duration]) => ({ type: typeNames[type] || 'Unknown', duration }))
      .sort((a, b) => b.duration - a.duration);
  },

  /**
   * Get completed game sessions for a single date
   */
  async getSessionsForDate(accountId: number | null, targetDate: Date, limit = 10, subjectId?: bigint, offset = 0) {
    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);

    const where: Prisma.GameSessionWhereInput = {
      startTime: {
        gte: targetDate,
        lt: nextDay,
      },
      endTime: { not: null },
    };

    if (accountId !== null) {
      where.robloxAccountId = accountId;
    }

    if (subjectId) {
      where.subjectId = subjectId;
    }

    return prisma.gameSession.findMany({
      where,
      orderBy: {
        startTime: 'desc',
      },
      take: limit,
      skip: offset,
    });
  },

  /**
   * Helper to fetch names for a list of subjectIds.
   *
   * Resolution order per id: current Friend/TrackedUser row → durable
   * SubjectIdentity row (survives unfriend/untrack) → newest stored session
   * name. Unlike the original implementation, subjects that are no longer in
   * the current lists still get a human-readable label.
   */
  async getSubjectNames(accountId: number | null, subjectIds: bigint[]): Promise<Map<bigint, string>> {
    const map = new Map<bigint, string>();
    if (subjectIds.length === 0) return map;

    const friendWhere: Prisma.FriendWhereInput = { friendUserId: { in: subjectIds } };
    const trackedWhere: Prisma.TrackedUserWhereInput = { robloxUserId: { in: subjectIds } };
    const identityWhere: Prisma.SubjectIdentityWhereInput = { robloxUserId: { in: subjectIds } };

    if (accountId !== null) {
      friendWhere.robloxAccountId = accountId;
      trackedWhere.robloxAccountId = accountId;
      identityWhere.robloxAccountId = accountId;
    }

    const [friends, tracked, identities] = await Promise.all([
      prisma.friend.findMany({
        where: friendWhere,
        select: { friendUserId: true, displayName: true, username: true },
      }),
      prisma.trackedUser.findMany({
        where: trackedWhere,
        select: { robloxUserId: true, displayName: true, username: true },
      }),
      prisma.subjectIdentity.findMany({
        where: identityWhere,
        select: { robloxUserId: true, displayName: true, username: true },
      }),
    ]);

    for (const i of identities) {
      const dName = i.displayName || 'Unknown';
      const uName = i.username || 'unknown';
      map.set(i.robloxUserId, `${dName} (@${uName})`);
    }
    for (const f of friends) {
      map.set(f.friendUserId, `${f.displayName} (@${f.username})`);
    }
    for (const t of tracked) {
      const dName = t.displayName || 'Unknown';
      const uName = t.username || 'unknown';
      map.set(t.robloxUserId, `${dName} (@${uName})`);
    }
    return map;
  },

  /**
   * Find a subject by username or displayName (case-insensitive).
   *
   * Membership in the current Friend/TrackedUser lists is NOT required: the
   * durable SubjectIdentity table (and its username history) is consulted
   * too, so `/history`, `/stats`, and `/gamestats` keep working after the user
   * is unfriended or `/untrack`ed. Every lookup stays scoped to `accountId`
   * (or is global for the admin path, exactly as before).
   */
  async getSubjectByName(accountId: number | null, name: string) {
    return (await subjectIdentityService.resolveByName(accountId, name))?.subjectId ?? null;
  },

  /**
   * Helper to get live presence (including lastOnline timestamp) from Roblox API
   */
  async getSubjectLivePresence(accountId: number | null, subjectId: bigint) {
    let cookie: string | null = null;
    if (accountId) {
      cookie = await accountService.getDecryptedCookieByAccountId(accountId);
    } else {
      // Admin case - use any available valid cookie
      const acc = await prisma.robloxAccount.findFirst({ select: { id: true } });
      if (acc) {
        cookie = await accountService.getDecryptedCookieByAccountId(acc.id);
      }
    }
    
    if (!cookie) return null;

    try {
      const { presence } = await robloxService.getPresence(cookie, [Number(subjectId)], 'interactive');
      return presence.get(Number(subjectId));
    } catch (err) {
      // Rate-limited or throttled: /history still renders, just without the
      // live status line. Never let an optional lookup break the command.
      console.warn(
        `[Analytics] Live presence unavailable for ${subjectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  },

  /**
   * Helper to get lastSeenAt from the database for a subject.
   *
   * Falls back to the newest stored session when the subject is no longer in
   * the current lists, so the "Last Online (from tracker cache)" line keeps
   * working for unfriended/untracked users.
   */
  async getSubjectLastSeenAt(accountId: number | null, subjectId: bigint): Promise<Date | null> {
    const friendWhere: Prisma.FriendWhereInput = { friendUserId: subjectId };
    const trackedWhere: Prisma.TrackedUserWhereInput = { robloxUserId: subjectId };
    const identityWhere: Prisma.SubjectIdentityWhereInput = { robloxUserId: subjectId };
    const gameWhere: Prisma.GameSessionWhereInput = { subjectId };
    const presenceWhere: Prisma.PresenceSessionWhereInput = { subjectId };

    if (accountId !== null) {
      friendWhere.robloxAccountId = accountId;
      trackedWhere.robloxAccountId = accountId;
      identityWhere.robloxAccountId = accountId;
      gameWhere.robloxAccountId = accountId;
      presenceWhere.robloxAccountId = accountId;
    }

    const [friend, tracked, identity, game, presence] = await Promise.all([
      prisma.friend.findFirst({ where: friendWhere, select: { lastSeenAt: true }, orderBy: { lastSeenAt: 'desc' } }),
      prisma.trackedUser.findFirst({ where: trackedWhere, select: { lastSeenAt: true }, orderBy: { lastSeenAt: 'desc' } }),
      prisma.subjectIdentity.findFirst({ where: identityWhere, select: { lastSeenAt: true } }),
      prisma.gameSession.findFirst({
        where: gameWhere,
        select: { endTime: true },
        orderBy: [{ startTime: 'desc' }, { id: 'desc' }],
      }),
      prisma.presenceSession.findFirst({
        where: presenceWhere,
        select: { endTime: true },
        orderBy: [{ startTime: 'desc' }, { id: 'desc' }],
      }),
    ]);

    const candidates = [
      friend?.lastSeenAt,
      tracked?.lastSeenAt,
      identity?.lastSeenAt,
      game?.endTime,
      presence?.endTime,
    ].filter((d): d is Date => d instanceof Date);

    if (candidates.length === 0) return null;
    return new Date(Math.max(...candidates.map((d) => d.getTime())));
  }
};
