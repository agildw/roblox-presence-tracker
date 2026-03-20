import type { Bot } from 'grammy';

export function registerStartCommand(bot: Bot): void {
  bot.command('start', async (ctx) => {
    const name = ctx.from?.first_name ?? 'there';

    const escapeHtml = (text: string) => text.replace(/[<>&]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m] as string));

    await ctx.reply(
      `👋 Hey ${escapeHtml(name)}! Welcome to the <b>Roblox Tracker Bot</b>.\n\n` +
        `Here's what I can do:\n` +
        `🔗 /setcookie — Connect your Roblox account\n` +
        `🔄 /sync — Sync your friends list\n` +
        `📡 /status — Check a friend's presence\n` +
        `📊 /stats — View weekly playtime stats\n` +
        `📜 /history — View session history\n` +
        `🔔 /notify — Enable notifications for a user\n` +
        `🔕 /unnotify — Disable notifications for a user\n\n` +
        `To get started, use /setcookie to connect your account.`,
      { parse_mode: 'HTML' }
    );
  });
}
