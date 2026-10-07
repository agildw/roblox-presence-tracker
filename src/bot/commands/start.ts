import type { Bot } from 'grammy';

import { env } from '../../lib/env.js';

export function registerStartCommand(bot: Bot): void {
  bot.command('start', async (ctx) => {
    const name = ctx.from?.first_name ?? 'there';
    const userId = String(ctx.from?.id ?? '');
    const isAdmin = env.ADMIN_USER_IDS.includes(userId);

    const escapeHtml = (text: string) => text.replace(/[<>&]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m] as string));

    let msg = `👋 Hey ${escapeHtml(name)}! Welcome to the <b>Roblox Tracker Bot</b>.\n\n` +
      `Here's what I can do:\n` +
      `🔗 /setcookie — Connect your Roblox account\n` +
      `🔄 /sync — Sync your friends list\n` +
      `📡 /status — Check a friend's presence\n` +
      `📊 /stats — View weekly playtime stats\n` +
      `📜 /history — View session history\n` +
      `🔔 /notify — Enable notifications for a user\n` +
      `🔕 /unnotify — Disable notifications for a user\n` +
      `👁️ /track — Track a user who is not your friend\n` +
      `🙈 /untrack — Stop tracking a user\n` +
      `📋 /list — List your manually tracked users\n\n`;

    if (isAdmin) {
      msg += `👮 <b>Admin Commands:</b>\n` +
        `🛑 /disable — Disable a user\n` +
        `✅ /enable — Re-enable a user\n\n`;
    }

    msg += `To get started, use /setcookie to connect your account.`;

    await ctx.reply(msg, { parse_mode: 'HTML' });
  });
}
