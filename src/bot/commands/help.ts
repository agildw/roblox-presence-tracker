import type { Bot } from 'grammy';

export function registerHelpCommand(bot: Bot): void {
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `📖 <b>Roblox Tracker Bot — Commands</b>\n\n` +
        `<b>Account</b>\n` +
        `/setcookie &lt;cookie&gt; — Connect your Roblox account\n` +
        `/sync — Manually sync your friends list\n\n` +
        `<b>Tracking</b>\n` +
        `/status &lt;username&gt; — Current presence of a user\n` +
        `/notify &lt;username&gt; — Enable notifications\n` +
        `/unnotify &lt;username&gt; — Disable notifications\n` +
        `/track &lt;username&gt; — Track a user who is not your friend\n` +
        `/untrack &lt;username&gt; — Stop tracking a user\n` +
        `/list — List your manually tracked users\n\n` +
        `<b>Analytics</b>\n` +
        `/stats — Weekly playtime breakdown\n` +
        `/gamestats &lt;game URL&gt; [most] [user:&lt;name&gt;] — Per-game player-hours and recent players\n` +
        `/history &lt;username&gt; — Session history for a user\n` +
        `/badges &lt;username&gt; — Recent badges for a user`,
      { parse_mode: 'HTML' }
    );
  });
}
