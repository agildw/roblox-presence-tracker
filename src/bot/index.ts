import { Bot } from 'grammy';
import { env } from '../lib/env.js';
import { registerStartCommand } from './commands/start.js';
import { registerHelpCommand } from './commands/help.js';
import { registerSetCookieCommand } from './commands/setcookie.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerNotifyCommand } from './commands/notify.js';
import { registerUnnotifyCommand } from './commands/unnotify.js';
import { registerStatusCommand } from './commands/status.js';
import { registerHistoryCommand } from './commands/history.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerTrackCommand } from './commands/track.js';
import { registerUntrackCommand } from './commands/untrack.js';
import { registerListCommand } from './commands/list.js';
import { notificationService } from '../services/notification/notification.service.js';

export function createBot(): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  // Set bot instance for external services
  notificationService.setBot(bot);

  // ─── Global error handler ──────────────────────────────────────────────────
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`[Bot] Error while handling update ${ctx.update.update_id}:`);
    console.error(err.error);
  });

  // ─── Register commands ─────────────────────────────────────────────────────
  registerStartCommand(bot);
  registerHelpCommand(bot);
  registerSetCookieCommand(bot);
  registerSyncCommand(bot);
  registerNotifyCommand(bot);
  registerUnnotifyCommand(bot);
  registerStatusCommand(bot);
  registerHistoryCommand(bot);
  registerStatsCommand(bot);
  registerTrackCommand(bot);
  registerUntrackCommand(bot);
  registerListCommand(bot);

  return bot;
}
