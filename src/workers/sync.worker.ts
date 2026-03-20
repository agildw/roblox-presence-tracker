import { prisma } from '../lib/prisma.js';
import { syncService } from '../services/sync/sync.service.js';
import { accountService } from '../services/account/account.service.js';
import { notificationService } from '../services/notification/notification.service.js';

let intervalId: NodeJS.Timeout | null = null;
let isSyncing = false;
const SYNC_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes

export function startSyncWorker(): void {
  if (intervalId) return;
  console.log(`[Worker] Starting friend sync polling every ${SYNC_INTERVAL_MS / 60000}m...`);

  // Initial delay, then run
  intervalId = setInterval(() => {
    if (isSyncing) {
      console.warn('[Worker] Friend sync skipped: previous cycle still running.');
      return;
    }
    isSyncing = true;
    
    runSyncCycle().catch((err) => {
      console.error('[Worker] Error during friend sync cycle:', err);
    }).finally(() => {
      isSyncing = false;
    });
  }, SYNC_INTERVAL_MS);
}

export function stopSyncWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Worker] Friend sync polling stopped.');
  }
}

async function runSyncCycle() {
  const accounts = await prisma.robloxAccount.findMany({
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
          if (result.added.length > 10) lines.push(`  _…and ${result.added.length - 10} more_`);
        }
        
        if (result.removed.length > 0) {
          lines.push('', `➖ *Removed (${result.removed.length}):*`);
          result.removed.slice(0, 10).forEach((f) => lines.push(`  • ${f.displayName} (@${f.username})`));
          if (result.removed.length > 10) lines.push(`  _…and ${result.removed.length - 10} more_`);
        }

        await notificationService.sendDirectMessage(account.user.telegramId, lines.join('\n'));
      }
    } catch (err) {
      console.error(`[Worker] Failed to auto-sync account ${account.robloxUserId}:`, err);
    }
  }
}
