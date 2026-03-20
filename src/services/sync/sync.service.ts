/**
 * SyncService
 *
 * Syncs a user's Roblox friend list with the local database.
 *
 * Algorithm:
 *  1. Fetch current DB friends (Set of BigInt friendUserId)
 *  2. Fetch live friends from Roblox API
 *  3. Compute diff: added vs removed
 *  4. For added: fetch usernames via getUsersBatch, upsert Friend rows
 *  5. For removed: delete Friend rows
 *  6. Return a SyncResult summary
 *
 * Rules:
 *  - Never overwrite blindly — always diff before writing
 *  - Only notify caller if there are actual changes
 *  - Do NOT block the bot handler — call this in a background job
 */

import { prisma } from '../../lib/prisma.js';
import { robloxService } from '../roblox/roblox.service.js';
import type { RobloxAccount } from '../../generated/prisma/client.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SyncResult {
  added: SyncedFriend[];
  removed: SyncedFriend[];
  unchanged: number;
}

export interface SyncedFriend {
  robloxUserId: bigint;
  username: string;
  displayName: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

export const syncService = {
  // ── syncFriends ─────────────────────────────────────────────────────────────
  /**
   * Full friend sync for a RobloxAccount.
   * Returns a SyncResult describing what changed.
   */
  async syncFriends(
    account: RobloxAccount,
    cookie: string,
  ): Promise<SyncResult> {
    // 1. Load current friends from DB (we only need their IDs)
    const dbFriends = await prisma.friend.findMany({
      where: { robloxAccountId: account.id },
      select: { friendUserId: true, username: true, displayName: true },
    });

    const dbFriendIds = new Set(dbFriends.map((f) => f.friendUserId));

    // 2. Fetch live friends from Roblox
    const apiFriends = await robloxService.getFriends(cookie, account.robloxUserId);
    const apiFriendIds = new Set(apiFriends.map((f) => BigInt(f.id)));

    // 3. Compute diff
    const addedIds = apiFriends
      .filter((f) => !dbFriendIds.has(BigInt(f.id)))
      .map((f) => f.id);

    const removedIds = dbFriends
      .filter((f) => !apiFriendIds.has(f.friendUserId))
      .map((f) => f.friendUserId);

    const unchanged = dbFriends.length - removedIds.length;

    // 4. Handle added friends
    const added: SyncedFriend[] = [];

    if (addedIds.length > 0) {
      // Batch-fetch usernames for the new friends
      const userInfos = await robloxService.getUsersBatch(cookie, addedIds);
      const infoMap = new Map(userInfos.map((u) => [u.id, u]));

      for (const id of addedIds) {
        const info = infoMap.get(id);
        const username = info?.name ?? `User_${id}`;
        const displayName = info?.displayName ?? username;

        await prisma.friend.upsert({
          where: {
            robloxAccountId_friendUserId: {
              robloxAccountId: account.id,
              friendUserId: BigInt(id),
            },
          },
          create: {
            robloxAccountId: account.id,
            friendUserId: BigInt(id),
            username,
            displayName,
          },
          update: {
            username,
            displayName,
          },
        });

        added.push({ robloxUserId: BigInt(id), username, displayName });
      }
    }

    // 5. Handle removed friends
    const removed: SyncedFriend[] = [];

    if (removedIds.length > 0) {
      // Capture info before deleting for the return value
      for (const dbFriend of dbFriends) {
        if (removedIds.includes(dbFriend.friendUserId)) {
          removed.push({
            robloxUserId: dbFriend.friendUserId,
            username: dbFriend.username,
            displayName: dbFriend.displayName,
          });
        }
      }

      await prisma.friend.deleteMany({
        where: {
          robloxAccountId: account.id,
          friendUserId: { in: removedIds },
        },
      });
    }

    // 6. Handle TrackedUsers metadata refresh
    const trackedUsers = await prisma.trackedUser.findMany({
      where: { robloxAccountId: account.id },
      select: { robloxUserId: true },
    });

    if (trackedUsers.length > 0) {
      const trackedUserIds = trackedUsers.map((u) => Number(u.robloxUserId));
      const userInfos = await robloxService.getUsersBatch(cookie, trackedUserIds);
      const infoMap = new Map(userInfos.map((u) => [BigInt(u.id), u]));

      for (const tu of trackedUsers) {
        const info = infoMap.get(tu.robloxUserId);
        if (info) {
          await prisma.trackedUser.update({
            where: {
              robloxAccountId_robloxUserId: {
                robloxAccountId: account.id,
                robloxUserId: tu.robloxUserId,
              },
            },
            data: {
              username: info.name,
              displayName: info.displayName,
            },
          });
        }
      }
    }

    return { added, removed, unchanged };
  },
};
