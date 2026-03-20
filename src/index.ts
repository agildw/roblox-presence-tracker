import { createBot } from './bot/index.js';
import { prisma } from './lib/prisma.js';
import { startPresenceWorker, stopPresenceWorker } from './workers/presence.worker.js';
import { startSyncWorker, stopSyncWorker } from './workers/sync.worker.js';

async function main(): Promise<void> {
  console.log('[App] Starting Roblox Tracker Bot...');

  // Verify DB connection on startup
  await prisma.$connect();
  console.log('[App] Database connected.');

  const bot = createBot();

  // Start background workers
  startPresenceWorker();
  startSyncWorker();

  // Graceful shutdown
  process.once('SIGINT', () => {
    stopPresenceWorker();
    stopSyncWorker();
    void bot.stop();
  });
  process.once('SIGTERM', () => {
    stopPresenceWorker();
    stopSyncWorker();
    void bot.stop();
  });

  // Start long polling
  await bot.start({
    onStart: (botInfo) => {
      console.log(`[Bot] Running as @${botInfo.username}`);
    },
  });
}

main().catch((err) => {
  console.error('[App] Fatal error:', err);
  process.exit(1);
});
