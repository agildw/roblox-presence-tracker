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
   * Get recent completed game sessions
   */
  async getRecentSessions(accountId: number, limit = 10, subjectId?: bigint) {
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
        endTime: 'desc',
      },
      take: limit,
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
   * Get daily presence summary for a specific subject
   */
  async getDailyPresenceSummary(accountId: number, subjectId: bigint, daysLimit = 7) {
    const since = new Date();
    since.setDate(since.getDate() - daysLimit);
    since.setHours(0, 0, 0, 0);

    const sessions = await prisma.presenceSession.findMany({
      where: {
        robloxAccountId: accountId,
        subjectId,
        startTime: { gte: since },
        duration: { not: null },
      },
      orderBy: {
        startTime: 'desc',
      },
    });

    // Group by date and type
    const dailyMap = new Map<string, Map<number, number>>();

    for (const s of sessions) {
      if (!s.duration) continue;
      const dateKey = s.startTime.toISOString().split('T')[0]!;
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, new Map());
      }
      const typeMap = dailyMap.get(dateKey)!;
      const current = typeMap.get(s.presenceType) || 0;
      typeMap.set(s.presenceType, current + s.duration);
    }

    const typeNames: Record<number, string> = {
      0: 'Offline',
      1: 'Website',
      2: 'Game',
      3: 'Studio',
    };

    return Array.from(dailyMap.entries()).map(([date, typeMap]) => ({
      date,
      stats: Array.from(typeMap.entries()).map(([type, duration]) => ({
        type: typeNames[type] || 'Unknown',
        duration,
      })),
    }));
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
