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
 * A cycle is also never *started* while a cooldown is active: that only burned a
 * cycle and produced a zero-data poll.
 */

import { prisma } from '../../lib/prisma.js';
import { robloxService } from '../roblox/roblox.service.js';
import { accountService } from '../account/account.service.js';
import { notificationService } from '../notification/notification.service.js';
import { sessionService } from '../session/session.service.js';
import { robloxRateLimiter } from '../../lib/ratelimit.js';
import { env } from '../../lib/env.js';
import type { RobloxUserPresence } from '../roblox/roblox.types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Per-account result of one presence poll. */
export interface PresenceAccountOutcome {
  /** Batches that returned data this poll. */
  batchesApplied: number;
  /** Batches the poll intended to issue. */
  batchesTotal: number;
  /** Requested ids with no presence record returned. */
  unansweredIds: number;
  /** True when the poll stopped early because Roblox throttled us. */
  throttled: boolean;
  /** True when there was nothing to poll (no cookie or no subjects). */
  skipped: boolean;
}

/** Aggregated result of one full presence cycle, for the worker's log line. */
export interface PresenceCycleOutcome {
  accountsTotal: number;
  accountsPolled: number;
  /** True when the cycle stopped early (throttled or started inside a cooldown). */
  halted: boolean;
  batchesApplied: number;
  batchesTotal: number;
  unansweredIds: number;
  throttled: boolean;
}

// ── Service ───────────────────────────────────────────────────────────────────

export const presenceService = {
  /**
   * Polls presence for all accounts and detects changes.
   *
   * Returns an aggregate outcome so the worker can log one summary line and
   * decide whether the cycle was clean (used to reset the throttle penalty).
   */
  async pollAllPresence(): Promise<PresenceCycleOutcome> {
    // 1. Fetch all connected accounts
    const accounts = await prisma.robloxAccount.findMany({
      where: {
        user: { isDisabled: false },
      },
      include: {
        user: { select: { telegramId: true } },
      },
    });

    const cycle: PresenceCycleOutcome = {
      accountsTotal: accounts.length,
      accountsPolled: 0,
      halted: false,
      batchesApplied: 0,
      batchesTotal: 0,
      unansweredIds: 0,
      throttled: false,
    };

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      if (!account) continue;

      // Don't open work we already know will be refused: an active cooldown
      // means every request rejects immediately, so the cycle would do nothing.
      const cooldown = robloxRateLimiter.snapshot().cooldownRemainingMs;
      if (cooldown > 0) {
        cycle.halted = true;
        logSkippedAccounts(accounts.length - i, cooldown, 'not started');
        break;
      }

      try {
        const result = await this.pollAccountPresence(account, account.user.telegramId);
        cycle.accountsPolled++;
        cycle.batchesApplied += result.batchesApplied;
        cycle.batchesTotal += result.batchesTotal;
        cycle.unansweredIds += result.unansweredIds;
        cycle.throttled ||= result.throttled;
      } catch (err) {
        console.error(`[PresenceService] Failed to poll for account ${account.robloxUserId}:`, err);
      }

      // Throttled mid-cycle: stop instead of queueing more doomed requests.
      const remainingCooldown = robloxRateLimiter.snapshot().cooldownRemainingMs;
      if (remainingCooldown > 0) {
        cycle.halted = true;
        logSkippedAccounts(accounts.length - i - 1, remainingCooldown, 'halted');
        break;
      }
    }

    return cycle;
  },

  async pollAccountPresence(
    account: { id: number; robloxUserId: bigint },
    telegramId: string
  ): Promise<PresenceAccountOutcome> {
    // Get decrypted cookie
    const cookie = await accountService.getDecryptedCookie(telegramId);
    if (!cookie) {
      return { batchesApplied: 0, batchesTotal: 0, unansweredIds: 0, throttled: false, skipped: true };
    }

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
    if (uniqueUserIds.length === 0) {
      return { batchesApplied: 0, batchesTotal: 0, unansweredIds: 0, throttled: false, skipped: true };
    }

    // Convert bigints to number for the API call (safe as long as it fits in JS number/safe int, standard for roblox API)
    const numericIds = uniqueUserIds.map((id) => Number(id));
    const batchCount = Math.ceil(numericIds.length / env.PRESENCE_BATCH_SIZE);

    console.log(
      `[PresenceService] Account ${account.robloxUserId}: polling ${numericIds.length} users ` +
        `(${trackedUsers.length} tracked, ${friends.length} friends, ${numericIds.length} unique) ` +
        `in ${batchCount} batch(es).${robloxRateLimiter.describe()}`,
    );

    const fetch = await robloxService.getPresence(cookie, numericIds);

    const outcome: PresenceAccountOutcome = {
      batchesApplied: fetch.batchesSucceeded,
      batchesTotal: fetch.batchesTotal,
      unansweredIds: fetch.unansweredIds,
      throttled: fetch.throttled,
      skipped: false,
    };

    // ══ PARTIAL-DATA INVARIANT ═══════════════════════════════════════════════
    // Iterate `fetch.presence` (only users Roblox actually answered for) — NEVER
    // `numericIds` / `userMap`. A user with no entry was NOT answered, and
    // treating that absence as "offline" would emit a false went-offline
    // notification and write a bogus state transition. Unanswered users must
    // keep their cached state untouched so the next successful poll compares
    // against real data.
    // ═════════════════════════════════════════════════════════════════════════
    if (fetch.presence.size === 0) {
      if (fetch.throttled) {
        console.log(
          `[PresenceService] Account ${account.robloxUserId}: no presence data this cycle ` +
            `(throttled); cached state left untouched for ${numericIds.length} user(s).${robloxRateLimiter.describe()}`,
        );
      } else {
        console.warn(
          `[PresenceService] No presence data returned for account ${account.robloxUserId} ` +
            `(${numericIds.length} requested).${robloxRateLimiter.describe()}`,
        );
      }
      return outcome;
    }

    for (const [userIdNum, newPresence] of fetch.presence.entries()) {
      const userId = BigInt(userIdNum);
      const cached = userMap.get(userId);
      if (!cached) continue;

      await this.compareAndHandleChanges(telegramId, account.id, cached.id, userId, cached.type, cached, newPresence);
    }

    if (outcome.unansweredIds > 0) {
      console.warn(
        `[PresenceService] Account ${account.robloxUserId}: applied ${outcome.batchesApplied}/${outcome.batchesTotal} ` +
          `batches, ${outcome.unansweredIds} unanswered id(s) left at their cached state.${robloxRateLimiter.describe()}`,
      );
    }

    return outcome;
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

/**
 * Info-level notice that accounts were left unpolled. Silent when there are
 * none, so a single-account setup does not log "Skipping 0 account(s)".
 */
function logSkippedAccounts(count: number, cooldownMs: number, cause: 'halted' | 'not started'): void {
  const reason = `Roblox cooldown active for another ${Math.ceil(cooldownMs / 1000)}s`;
  if (count <= 0) {
    console.log(`[PresenceService] Cycle ${cause}: ${reason}.${robloxRateLimiter.describe()}`);
    return;
  }
  console.log(
    `[PresenceService] Cycle ${cause}: ${reason}. Skipping ${count} account(s) this cycle.` +
      robloxRateLimiter.describe(),
  );
}