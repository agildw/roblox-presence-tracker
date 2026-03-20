import { prisma } from '../../lib/prisma.js';
import type { RobloxUser } from '../roblox/roblox.types.js';

export const trackService = {
  async trackUser(accountId: number, robloxUser: RobloxUser) {
    return prisma.trackedUser.upsert({
      where: {
        robloxAccountId_robloxUserId: {
          robloxAccountId: accountId,
          robloxUserId: BigInt(robloxUser.id),
        },
      },
      create: {
        robloxAccountId: accountId,
        robloxUserId: BigInt(robloxUser.id),
        username: robloxUser.name,
        displayName: robloxUser.displayName,
      },
      update: {
        username: robloxUser.name,
        displayName: robloxUser.displayName,
      },
    });
  },

  async untrackUser(accountId: number, username: string): Promise<boolean> {
    const result = await prisma.trackedUser.deleteMany({
      where: {
        robloxAccountId: accountId,
        username,
      },
    });
    return result.count > 0;
  },

  async getTrackedUsers(accountId: number) {
    return prisma.trackedUser.findMany({
      where: { robloxAccountId: accountId },
      orderBy: { username: 'asc' },
    });
  },
};
