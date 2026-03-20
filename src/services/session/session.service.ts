import { prisma } from '../../lib/prisma.js';

export const sessionService = {
  /**
   * Starts a new game session
   */
  async startGameSession(
    accountId: number,
    subjectId: bigint,
    subjectType: 'FRIEND' | 'TRACKED',
    placeId: bigint,
    universeId?: bigint | null,
    serverId?: string | null,
    gameName?: string | null
  ): Promise<void> {
    // End any existing open sessions for this subject first (defensive programming)
    await this.endGameSession(accountId, subjectId);

    await prisma.gameSession.create({
      data: {
        robloxAccountId: accountId,
        subjectId,
        subjectType,
        placeId,
        universeId: universeId ?? null,
        serverId: serverId ?? null,
        gameName: gameName ?? null,
        startTime: new Date(),
      },
    });
  },

  /**
   * Ends an active game session and calculates duration
   */
  async endGameSession(accountId: number, subjectId: bigint): Promise<void> {
    const activeSession = await prisma.gameSession.findFirst({
      where: {
        robloxAccountId: accountId,
        subjectId,
        endTime: null,
      },
      orderBy: {
        startTime: 'desc',
      },
    });

    if (activeSession) {
      const now = new Date();
      const durationSeconds = Math.floor((now.getTime() - activeSession.startTime.getTime()) / 1000);

      await prisma.gameSession.update({
        where: { id: activeSession.id },
        data: {
          endTime: now,
          duration: durationSeconds,
        },
      });
    }
  },

  /**
   * Changes the current game directly (close old, start new)
   */
  async changeGameSession(
    accountId: number,
    subjectId: bigint,
    subjectType: 'FRIEND' | 'TRACKED',
    placeId: bigint,
    universeId?: bigint | null,
    serverId?: string | null,
    gameName?: string | null
  ): Promise<void> {
    await this.endGameSession(accountId, subjectId);
    await this.startGameSession(accountId, subjectId, subjectType, placeId, universeId, serverId, gameName);
  },
};
