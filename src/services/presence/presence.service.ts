/**
 * PresenceService
 *
 * Handles polling Roblox presence for all tracked users across all accounts.
 */

import { prisma } from '../../lib/prisma.js';
import { robloxService } from '../roblox/roblox.service.js';
import { accountService } from '../account/account.service.js';
import { notificationService } from '../notification/notification.service.js';
import { sessionService } from '../session/session.service.js';
import type { RobloxUserPresence } from '../roblox/roblox.types.js';
import { chunk } from '../../lib/http.js';

export const presenceService = {
  /**
   * Polls presence for all accounts and detects changes.
   */
  async pollAllPresence(): Promise<void> {
    // 1. Fetch all connected accounts
    const accounts = await prisma.robloxAccount.findMany({
      include: {
        user: { select: { telegramId: true } },
      },
    });

    for (const account of accounts) {
      try {
        await this.pollAccountPresence(account, account.user.telegramId);
      } catch (err) {
        console.error(`[PresenceService] Failed to poll for account ${account.robloxUserId}:`, err);
      }
    }
  },

  async pollAccountPresence(
    account: { id: number; robloxUserId: bigint },
    telegramId: string
  ): Promise<void> {
    // Get decrypted cookie
    const cookie = await accountService.getDecryptedCookie(telegramId);
    if (!cookie) return;

    // Fetch friends and tracked users to poll
    const [friends, trackedUsers] = await Promise.all([
      prisma.friend.findMany({ where: { robloxAccountId: account.id } }),
      prisma.trackedUser.findMany({ where: { robloxAccountId: account.id } }),
    ]);

    // Combine and deduplicate IDs
    const userMap = new Map<bigint, { id: number; type: 'FRIEND' | 'TRACKED'; lastPresence: number | null; lastGameId: string | null }>();

    for (const f of friends) {
      userMap.set(f.friendUserId, { id: f.id, type: 'FRIEND', lastPresence: f.lastPresence, lastGameId: f.lastGameId });
    }
    for (const t of trackedUsers) {
      userMap.set(t.robloxUserId, { id: t.id, type: 'TRACKED', lastPresence: t.lastPresence, lastGameId: t.lastGameId });
    }

    const uniqueUserIds = Array.from(userMap.keys());
    if (uniqueUserIds.length === 0) return;

    // Convert bigints to number for the API call (safe as long as it fits in JS number/safe int, standard for roblox API)
    const numericIds = uniqueUserIds.map((id) => Number(id));

    // Batch requests (100 is max per SKILL.md and roblox.service.ts handles batching anyway, but let's be sure)
    const presenceMap = await robloxService.getPresence(cookie, numericIds);

    for (const [userIdNum, newPresence] of presenceMap.entries()) {
      const userId = BigInt(userIdNum);
      const cached = userMap.get(userId);
      if (!cached) continue;

      this.compareAndHandleChanges(telegramId, account.id, cached.id, userId, cached.type, cached, newPresence);
    }
  },

  async compareAndHandleChanges(
    telegramId: string,
    accountId: number,
    recordId: number,
    subjectId: bigint,
    type: 'FRIEND' | 'TRACKED',
    oldState: { lastPresence: number | null; lastGameId: string | null },
    newState: RobloxUserPresence
  ) {
    const presenceChanged = oldState.lastPresence !== newState.userPresenceType;
    const gameChanged = oldState.lastGameId !== newState.gameId;

    if (!presenceChanged && !gameChanged) return;

    if (presenceChanged) {
      void sessionService.startPresenceSession(accountId, subjectId, type, newState.userPresenceType);
    }

    // Trigger events logically
    if (oldState.lastPresence !== 2 && newState.userPresenceType === 2) {
      console.log(`[PresenceService] [${type}] User started playing game: ${newState.gameId}`);
      
      const escapeHtml = (text: string) => text.replace(/[<>&]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m] as string));
      let msg = `Started playing <b>${escapeHtml(newState.lastLocation || 'a game')}</b>.`;
      if (newState.placeId && newState.gameId) {
        msg += `\n<a href="https://www.roblox.com/games/start?placeId=${newState.placeId}&gameId=${newState.gameId}">🎮 Join Game</a>`;
      }
      
      void notificationService.notifyPresenceChange(telegramId, recordId, type, msg, 'game');
      void sessionService.startGameSession(
        accountId,
        subjectId,
        type,
        BigInt(newState.placeId || 0),
        newState.universeId ? BigInt(newState.universeId) : null,
        newState.gameId,
        newState.lastLocation
      );
    } else if (gameChanged && oldState.lastPresence === 2 && newState.userPresenceType === 2) {
      console.log(`[PresenceService] [${type}] User changed game sequence: ${oldState.lastGameId} -> ${newState.gameId}`);
      
      const escapeHtml = (text: string) => text.replace(/[<>&]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m] as string));
      let msg = `Changed game to <b>${escapeHtml(newState.lastLocation || 'another game')}</b>.`;
      if (newState.placeId && newState.gameId) {
        msg += `\n<a href="https://www.roblox.com/games/start?placeId=${newState.placeId}&gameId=${newState.gameId}">🎮 Join Game</a>`;
      }
      
      void notificationService.notifyPresenceChange(telegramId, recordId, type, msg, 'game');
      void sessionService.changeGameSession(
        accountId,
        subjectId,
        type,
        BigInt(newState.placeId || 0),
        newState.universeId ? BigInt(newState.universeId) : null,
        newState.gameId,
        newState.lastLocation
      );
    } else if (oldState.lastPresence === 2 && newState.userPresenceType !== 2) {
      console.log(`[PresenceService] [${type}] User stopped playing game: ${oldState.lastGameId}`);
      void sessionService.endGameSession(accountId, subjectId);
      
      // Notify they became idle (if not going offline entirely, as that is handled below)
      if (newState.userPresenceType !== 0) {
        void notificationService.notifyPresenceChange(telegramId, recordId, type, `Stopped playing and is now idle.`, 'game');
      }
    }

    if (oldState.lastPresence === 0 && newState.userPresenceType !== 0) {
      console.log(`[PresenceService] [${type}] User came online`);
      void notificationService.notifyPresenceChange(telegramId, recordId, type, `Is now online.`, 'online');
    } else if (oldState.lastPresence !== 0 && newState.userPresenceType === 0) {
      console.log(`[PresenceService] [${type}] User went offline`);
      void notificationService.notifyPresenceChange(telegramId, recordId, type, `Went offline.`, 'offline');
    }

    // Update DB
    const updateData = {
      lastPresence: newState.userPresenceType,
      lastGameId: newState.gameId,
      lastLocation: newState.lastLocation,
      lastSeenAt: new Date(),
    };

    if (type === 'FRIEND') {
      prisma.friend.update({ where: { id: recordId }, data: updateData }).catch((e) => console.error(e));
    } else {
      prisma.trackedUser.update({ where: { id: recordId }, data: {
        lastPresence: updateData.lastPresence,
        lastGameId: updateData.lastGameId,
        lastSeenAt: updateData.lastSeenAt,
      } }).catch((e) => console.error(e));
    }
  },
};
