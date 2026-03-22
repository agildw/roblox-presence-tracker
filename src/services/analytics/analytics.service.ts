import { prisma } from '../../lib/prisma.js';

export const analyticsService = {
  /**
   * Get all active game sessions for an account
   */
  async getActiveSessions(accountId: number) {
    return prisma.gameSession.findMany({
      where: {
        robloxAccountId: accountId,
        endTime: null,
      },
      orderBy: {
        startTime: 'desc',
      },
    });
  },

  /**
   * Get all active website sessions for an account
   */
  async getActiveWebsiteSessions(accountId: number) {
    return prisma.presenceSession.findMany({
      where: {
        robloxAccountId: accountId,
        presenceType: 1, // 1 = Website
        endTime: null,
      },
      orderBy: {
        startTime: 'desc',
      },
    });
  },

  /**
   * Get recent completed game sessions
   */
  async getRecentSessions(accountId: number, limit = 10, subjectId?: bigint, offset = 0) {
    const where: any = {
      robloxAccountId: accountId,
      endTime: { not: null },
    };

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
  async getPlaytimeStats(accountId: number, days: number | 'all' = 7, subjectId?: bigint) {
    const where: any = {
      robloxAccountId: accountId,
      duration: { not: null },
    };

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
  async getPresenceStats(accountId: number, days: number | 'all' = 7, subjectId?: bigint) {
    const where: any = {
      robloxAccountId: accountId,
      duration: { not: null },
    };

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
  async getPresenceSummaryForDate(accountId: number, subjectId: bigint, targetDate: Date) {
    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);

    const sessions = await prisma.presenceSession.findMany({
      where: {
        robloxAccountId: accountId,
        subjectId,
        startTime: {
          gte: targetDate,
          lt: nextDay,
        },
        duration: { not: null },
      },
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
  async getSessionsForDate(accountId: number, targetDate: Date, limit = 10, subjectId?: bigint) {
    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);

    const where: any = {
      robloxAccountId: accountId,
      startTime: {
        gte: targetDate,
        lt: nextDay,
      },
      endTime: { not: null },
    };

    if (subjectId) {
      where.subjectId = subjectId;
    }

    return prisma.gameSession.findMany({
      where,
      orderBy: {
        startTime: 'desc',
      },
      take: limit,
    });
  },

  /**
   * Helper to fetch names for a list of subjectIds
   */
  async getSubjectNames(accountId: number, subjectIds: bigint[]): Promise<Map<bigint, string>> {
    const map = new Map<bigint, string>();
    if (subjectIds.length === 0) return map;

    const [friends, tracked] = await Promise.all([
      prisma.friend.findMany({
        where: { robloxAccountId: accountId, friendUserId: { in: subjectIds } },
        select: { friendUserId: true, displayName: true, username: true },
      }),
      prisma.trackedUser.findMany({
        where: { robloxAccountId: accountId, robloxUserId: { in: subjectIds } },
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
  async getSubjectByName(accountId: number, name: string) {
    const normalized = name.toLowerCase().replace('@', '');

    // 1. Try friends
    const friend = await prisma.friend.findFirst({
      where: {
        robloxAccountId: accountId,
        OR: [
          { username: { equals: normalized } },
          { displayName: { equals: name } }
        ]
      },
      select: { friendUserId: true }
    });
    if (friend) return friend.friendUserId;

    // 2. Try tracked users
    const tracked = await prisma.trackedUser.findFirst({
      where: {
        robloxAccountId: accountId,
        OR: [
          { username: { equals: normalized } },
          { displayName: { equals: name } }
        ]
      },
      select: { robloxUserId: true }
    });
    if (tracked) return tracked.robloxUserId;

    return null;
  }
};
