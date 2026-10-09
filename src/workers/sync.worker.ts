/**
 * Sync Worker
 *
 * Runs the friend-sync loop for all connected accounts.
 *
 * Like the presence worker, this re-arms a single timer after each cycle
 * finishes so cycles never overlap and the interval stretches when Roblox
 * throttles us.
 */

import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { describeCycleFailure, scheduleDelayMs } from '../lib/adaptive.js';
import { robloxRateLimiter } from '../lib/ratelimit.js';
import { syncService } from '../services/sync/sync.service.js';
import { accountService } from '../services/account/account.service.js';
import { notificationService } from '../services/notification/notification.service.js';

let timer: NodeJS.Timeout | undefined = undefined;
let running = false;
let stopped = true;

export function startSyncWorker(): void {
  if (running || timer) return;

  stopped = false;
  console.log(`[Worker] Starting friend sync polling every ${env.FRIEND_SYNC_INTERVAL_MS / 60000}m...`);
  schedule(0);
}

export function stopSyncWorker(): void {
  stopped = true;
  clearTimeout(timer);
  timer = undefined;
  console.log('[Worker] Friend sync polling stopped.');
}

function schedule(delayMs: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    timer = undefined;
    void runSyncCycle();
  }, delayMs);
}

async function runSyncCycle(): Promise<void> {
  if (stopped || running) return;
  running = true;

  try {
    const accounts = await prisma.robloxAccount.findMany({
      where: {
        user: { isDisabled: false },
      },
      include: {
        user: { select: { telegramId: true } },
      },
    });

    for (const account of accounts) {
      try {
        const cookie = await accountService.getDecryptedCookie(account.user.telegramId);
        if (!cookie) continue;

        const result = await syncService.syncFriends(account, cookie);

        if (result.added.length > 0 || result.removed.length > 0) {
          // notify user
          const lines: string[] = ['🔄 *Automatic Friend Sync*'];

          if (result.added.length > 0) {
            lines.push('', `➕ *Added (${result.added.length}):*`);
            result.added.slice(0, 10).forEach((f) => lines.push(`  • ${f.displayName} (@${f.username})`));
            if (result.added.length > 10) lines.push(`  _...and ${result.added.length - 10} more_`);
          }

          if (result.removed.length > 0) {
            lines.push('', `➖ *Removed (${result.removed.length}):*`);
            result.removed.slice(0, 10).forEach((f) => lines.push(`  • ${f.displayName} (@${f.username})`));
            if (result.removed.length > 10) lines.push(`  _...and ${result.removed.length - 10} more_`);
          }

          await notificationService.sendDirectMessage(account.user.telegramId, lines.join('\n'));
        }
      } catch (err) {
        console.error(
          `[Worker] Failed to auto-sync account ${account.robloxUserId}: ${describeCycleFailure(err)}`,
        );
      }

      // Throttled: stop instead of running the remaining accounts into a cooldown.
      const cooldown = robloxRateLimiter.snapshot().cooldownRemainingMs;
      if (cooldown > 0) {
        console.warn(
          `[Worker] Friend sync halted: Roblox cooldown active, ${Math.ceil(cooldown / 1000)}s remaining.` +
            robloxRateLimiter.describe(),
        );
        break;
      }
    }
  } catch (err) {
    console.error(`[Worker] Friend sync cycle failed: ${describeCycleFailure(err)}`);
  } finally {
    running = false;
  }

  const { delayMs, multiplier, cooldownRemainingMs } = scheduleDelayMs(
    env.FRIEND_SYNC_INTERVAL_MS,
    robloxRateLimiter,
  );
  if (cooldownRemainingMs > delayMs) {
    console.log(
      `[Worker] Next friend sync in ${(delayMs / 60000).toFixed(1)}m ` +
        `(waiting out ${(cooldownRemainingMs / 1000).toFixed(1)}s cooldown).`,
    );
  } else if (multiplier > 1) {
    console.log(
      `[Worker] Next friend sync in ${(delayMs / 60000).toFixed(1)}m ` +
        `(base ${env.FRIEND_SYNC_INTERVAL_MS / 60000}m, ×${multiplier.toFixed(1)}).`,
    );
  }
  schedule(delayMs);
}