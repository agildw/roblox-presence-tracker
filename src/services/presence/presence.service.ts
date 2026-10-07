/**
 * PresenceService
 *
 * Handles polling Roblox presence for all tracked users across all accounts.
 *
 * Ordering matters: batches are filled with manually tracked users before
 * friends, so when the per-cycle batch cap truncates a poll, the subjects the
 * user explicitly asked to watch are the ones that stay fresh.
 *
 * If Roblox throttles mid-cycle, the cycle stops for the remaining accounts and
 * the worker reschedules after the shared cooldown — it never retries in place.
 */

import { prisma } from '../../lib/prisma.js';
import { robloxService } from '../roblox/roblox.service.js';
import { accountService } from '../account/account.service.js';
import { notificationService } from '../notification/notification.service.js';
import { sessionService } from '../session/session.service.js';
import { robloxRateLimiter } from '../../lib/ratelimit.js';
import { env } from '../../lib/env.js';
import type { RobloxUserPresence } from '../roblox/roblox.types.js';

export const presenceService = {
  /**
   * Polls presence for all accounts and detects changes.
   */
  async pollAllPresence(): Promise<void> {
    // 1. Fetch all connected accounts
    const accounts = await prisma.robloxAccount.findMany({
      where: {
        user: { isDisabled: false },
      },
      include: {
        user: { select: { telegramId: true } },
      },
    });

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      if (!account) continue;

      try {
        await this.pollAccountPresence(account, account.user.telegramId);
      } catch (err) {
        console.error(`[PresenceService] Failed to poll for account ${account.robloxUserId}:`, err);
      }

      // Throttled: stop the cycle instead of queueing more doomed requests.
      const cooldown = robloxRateLimiter.snapshot().cooldownRemainingMs;
      if (cooldown > 0) {
        console.warn(
          `[PresenceService] Cycle halted: Roblox cooldown active, ${Math.ceil(cooldown / 1000)}s remaining.` +
            ` Skipping ${accounts.length - i - 1} remaining account(s) this cycle.` +
            robloxRateLimiter.describe(),
        );
        break;
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

    // Combine and deduplicate IDs. Tracked users are inserted first so they own
    // the earliest batches; a tracked user that is also a friend counts once.
    const userMap = new Map<bigint, { id: number; type: 'FRIEND' | 'TRACKED'; lastPresence: number | null; lastGameId: string | null }>();

    for (const t of trackedUsers) {
      userMap.set(t.robloxUserId, { id: t.id, type: 'TRACKED', lastPresence: t.lastPresence, lastGameId: t.lastGameId });
    }
    for (const f of friends) {
      if (userMap.has(f.friendUserId)) continue;
      userMap.set(f.friendUserId, { id: f.id, type: 'FRIEND', lastPresence: f.lastPresence, lastGameId: f.lastGameId });
    }

    const uniqueUserIds = Array.from(userMap.keys());
    if (uniqueUserIds.length === 0) return;

    // Convert bigints to number for the API call (safe as long as it fits in JS number/safe int, standard for roblox API)
    const numericIds = uniqueUserIds.map((id) => Number(id));
    const batchCount = Math.ceil(numericIds.length / env.PRESENCE_BATCH_SIZE);

    console.log(
      `[PresenceService] Account ${account.robloxUserId}: polling ${numericIds.length} users ` +
        `(${trackedUsers.length} tracked, ${friends.length} friends, ${numericIds.length} unique) ` +
        `in ${batchCount} batch(es).${robloxRateLimiter.describe()}`,
    );

    const presenceMap = await robloxService.getPresence(cookie, numericIds);

    if (presenceMap.size === 0 && numericIds.length > 0) {
      console.warn(
        `[PresenceService] No presence data returned for account ${account.robloxUserId} ` +
          `(${numericIds.length} requested).${robloxRateLimiter.describe()}`,
      );
      return;
    }

    for (const [userIdNum, newPresence] of presenceMap.entries()) {
      const userId = BigInt(userIdNum);
      const cached = userMap.get(userId);
      if (!cached) continue;

      await this.compareAndHandleChanges(telegramId, account.id, cached.id, userId, cached.type, cached, newPresence);
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

    // Update DB (awaited so the next cycle reads fresh state instead of
    // re-detecting — and re-notifying — the same transition)
    const updateData = {
      lastPresence: newState.userPresenceType,
      lastGameId: newState.gameId,
      lastLocation: newState.lastLocation,
      lastSeenAt: new Date(),
    };

    if (type === 'FRIEND') {
      await prisma.friend.update({ where: { id: recordId }, data: updateData }).catch((e) => console.error(e));
    } else {
      await prisma.trackedUser.update({ where: { id: recordId }, data: {
        lastPresence: updateData.lastPresence,
        lastGameId: updateData.lastGameId,
        lastSeenAt: updateData.lastSeenAt,
      } }).catch((e) => console.error(e));
    }
  },
};