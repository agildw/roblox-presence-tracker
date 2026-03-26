import { prisma } from '../../lib/prisma.js';

export const analyticsService = {
  /**
   * Get all active game sessions for an account (or globally if accountId is null)
   */
  async getActiveSessions(accountId: number | null) {
    const where: any = { endTime: null };
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
    const where: any = {
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
    const where: any = {
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
    const where: any = {
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
    const where: any = {
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

    const where: any = {
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

    const where: any = {
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
   * Helper to fetch names for a list of subjectIds
   */
  async getSubjectNames(accountId: number | null, subjectIds: bigint[]): Promise<Map<bigint, string>> {
    const map = new Map<bigint, string>();
    if (subjectIds.length === 0) return map;

    const friendWhere: any = { friendUserId: { in: subjectIds } };
    const trackedWhere: any = { robloxUserId: { in: subjectIds } };

    if (accountId !== null) {
      friendWhere.robloxAccountId = accountId;
      trackedWhere.robloxAccountId = accountId;
    }

    const [friends, tracked] = await Promise.all([
      prisma.friend.findMany({
        where: friendWhere,
        select: { friendUserId: true, displayName: true, username: true },
      }),
      prisma.trackedUser.findMany({
        where: trackedWhere,
        select: { robloxUserId: true, displayName: true, username: true },
      })
    ]);

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
   * Find a subject (Friend or TrackedUser) by username or displayName (case-insensitive)
   */
  async getSubjectByName(accountId: number | null, name: string) {
    const normalized = name.toLowerCase().replace('@', '');

    const friendWhere: any = {
      OR: [
        { username: { equals: normalized } },
        { displayName: { equals: name } }
      ]
    };
    const trackedWhere: any = {
      OR: [
        { username: { equals: normalized } },
        { displayName: { equals: name } }
      ]
    };

    if (accountId !== null) {
      friendWhere.robloxAccountId = accountId;
      trackedWhere.robloxAccountId = accountId;
    }

    // 1. Try friends
    const friend = await prisma.friend.findFirst({
      where: friendWhere,
      select: { friendUserId: true }
    });
    if (friend) return friend.friendUserId;

    // 2. Try tracked users
    const tracked = await prisma.trackedUser.findFirst({
      where: trackedWhere,
      select: { robloxUserId: true }
    });
    if (tracked) return tracked.robloxUserId;

    return null;
  }
};
