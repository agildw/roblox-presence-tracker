import type { Bot } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import { analyticsService } from '../../services/analytics/analytics.service.js';

export function registerStatsCommand(bot: Bot): void {
  bot.command('stats', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const account = await accountService.getAccount(telegramId);
    if (!account) {
      await ctx.reply('⚠️ No account connected. Use `/setcookie <cookie>` first.', { parse_mode: 'Markdown' });
      return;
    }

    const days = 7;
    const stats = await analyticsService.getPlaytimeStats(account.id, days);
    
    if (stats.length === 0) {
      await ctx.reply(`📊 No playtime recorded in the last ${days} days.`);
      return;
    }

    const lines: string[] = [`📊 *Playtime Stats (Last ${days} days)*`, ''];
    
    // show top 15 games
    const topStats = stats.slice(0, 15);
    for (const stat of topStats) {
      const durationHours = (stat.duration / 3600).toFixed(1);
      lines.push(`• **${stat.game}**: ${durationHours} hours`);
    }

    if (stats.length > 15) {
      lines.push(`\n_...and ${stats.length - 15} more games_`);
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
  });
}
