import { createBot } from './bot/index.js';
import { prisma } from './lib/prisma.js';
import { startPresenceWorker, stopPresenceWorker } from './workers/presence.worker.js';
import { startSyncWorker, stopSyncWorker } from './workers/sync.worker.js';
import { subjectIdentityService } from './services/identity/subject-identity.service.js';
import { describeRobloxForensicsSettings } from './lib/roblox-forensics.js';

async function main(): Promise<void> {
  console.log('[App] Starting Roblox Tracker Bot...');
  console.log(`[App] Roblox client: ${describeRobloxForensicsSettings()}`);

  // Verify DB connection on startup
  await prisma.$connect();
  console.log('[App] Database connected.');

  // Rebuild durable subject identities from current lists + existing session
  // history. Idempotent and cheap; keeps history for users removed before the
  // identity table existed (or if a crash interrupted an earlier write).
  try {
    const count = await subjectIdentityService.backfill();
    console.log(`[App] Subject identity backfill: ${count} subject(s) ensured.`);
  } catch (err) {
    // Never block startup on this: history queries also fall back to the
    // current lists and sessions.
    console.error('[App] Subject identity backfill failed:', err);
  }

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
