import { Bot } from 'grammy';
import { env } from '../lib/env.js';
import { registerStartCommand } from './commands/start.js';
import { registerHelpCommand } from './commands/help.js';

export function createBot(): Bot {
  const bot = new Bot(env.BOT_TOKEN);

  // ─── Global error handler ──────────────────────────────────────────────────
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`[Bot] Error while handling update ${ctx.update.update_id}:`);
    console.error(err.error);
  });

  // ─── Register commands ─────────────────────────────────────────────────────
  registerStartCommand(bot);
  registerHelpCommand(bot);

  return bot;
}
