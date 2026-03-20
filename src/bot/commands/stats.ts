import type { Bot } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import { analyticsService } from '../../services/analytics/analytics.service.js';

export function registerStatsCommand(bot: Bot): void {
  bot.command('stats', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const account = await accountService.getAccount(telegramId);
    if (!account) {
      await ctx.reply('⚠️ No account connected. Use <code>/setcookie &lt;cookie&gt;</code> first.', { parse_mode: 'HTML' });
      return;
    }

    // Parse argument: /stats, /stats 30d, /stats all
    const arg = ctx.match?.trim().toLowerCase();
    let days: number | 'all' = 7;
    let rangeLabel = 'Last 7 days';

    if (arg === '30d') {
      days = 30;
      rangeLabel = 'Last 30 days';
    } else if (arg === 'all') {
      days = 'all';
      rangeLabel = 'All Time';
    }

    const stats = await analyticsService.getPlaytimeStats(account.id, days);
    
    if (stats.length === 0) {
      const timeStr = days === 'all' ? 'at all' : `in the last ${days} days`;
      await ctx.reply(`📊 No playtime recorded ${timeStr}.`);
      return;
    }

    const lines: string[] = [`📊 <b>Playtime Stats (${rangeLabel})</b>`, ''];
    
    // show top 15 games
    const topStats = stats.slice(0, 15);
    const escapeHtml = (text: string) => text.replace(/[<>&]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m] as string));

    for (const stat of topStats) {
      const durationStr = formatDuration(stat.duration);
      lines.push(`• <b>${escapeHtml(stat.game)}</b>: ${durationStr}`);
    }

    if (stats.length > 15) {
      lines.push(`\n<i>...and ${stats.length - 15} more games</i>`);
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });
}

function formatDuration(seconds: number): string {
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = (seconds / 3600).toFixed(1);
  return `${hours} hours`;
}

