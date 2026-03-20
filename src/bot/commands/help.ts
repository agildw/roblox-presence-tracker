import type { Bot } from 'grammy';

export function registerHelpCommand(bot: Bot): void {
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `📖 *Roblox Tracker Bot — Commands*\n\n` +
        `*Account*\n` +
        `/setcookie \\<cookie\\> — Connect your Roblox account\n` +
        `/sync — Manually sync your friends list\n\n` +
        `*Tracking*\n` +
        `/status \\<username\\> — Current presence of a user\n` +
        `/notify \\<username\\> — Enable notifications\n` +
        `/unnotify \\<username\\> — Disable notifications\n\n` +
        `*Analytics*\n` +
        `/stats — Weekly playtime breakdown\n` +
        `/history \\<username\\> — Session history for a user`,
      { parse_mode: 'MarkdownV2' }
    );
  });
}
