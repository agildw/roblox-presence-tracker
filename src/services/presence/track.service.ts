import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { subjectIdentityService } from '../identity/subject-identity.service.js';
import type { RobloxUser } from '../roblox/roblox.types.js';

export const trackService = {
  async trackUser(accountId: number, robloxUser: RobloxUser) {
    const tracked = await prisma.trackedUser.upsert({
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

    // Durable identity outlives the tracking row, so `/untrack` leaves history
    // resolvable by username.
    await subjectIdentityService.remember({
      robloxAccountId: accountId,
      subjectId: BigInt(robloxUser.id),
      username: robloxUser.name,
      displayName: robloxUser.displayName,
    });

    return tracked;
  },

  async untrackUser(accountId: number, username: string): Promise<boolean> {
    // Identity is refreshed BEFORE the delete so the tracking row's handle is
    // guaranteed to be in the username history. Only the TrackedUser row is
    // removed: GameSession/PresenceSession rows and SubjectIdentity history are
    // intentionally left intact.
    const existing = await prisma.trackedUser.findFirst({
      where: { robloxAccountId: accountId, username },
      select: { robloxUserId: true, username: true, displayName: true },
    });
    if (existing) {
      await subjectIdentityService.remember({
        robloxAccountId: accountId,
        subjectId: existing.robloxUserId,
        username: existing.username,
        displayName: existing.displayName,
      });
    }

    const result = await prisma.trackedUser.deleteMany({
      where: {
        robloxAccountId: accountId,
        username,
      },
    });
    return result.count > 0;
  },

  async getTrackedUsers(accountId: number | null) {
    const where: Prisma.TrackedUserWhereInput = {};
    if (accountId !== null) {
      where.robloxAccountId = accountId;
    }
    return prisma.trackedUser.findMany({
      where,
      orderBy: { username: 'asc' },
    });
  },
};
