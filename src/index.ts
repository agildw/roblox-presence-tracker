import { createBot } from './bot/index.js';
import { prisma } from './lib/prisma.js';

async function main(): Promise<void> {
  console.log('[App] Starting Roblox Tracker Bot...');

  // Verify DB connection on startup
  await prisma.$connect();
  console.log('[App] Database connected.');

  const bot = createBot();

  // Graceful shutdown
  process.once('SIGINT', () => void bot.stop());
  process.once('SIGTERM', () => void bot.stop());

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
