import type { Bot } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import { analyticsService } from '../../services/analytics/analytics.service.js';
import { formatDuration } from '../../lib/date.js';

export function registerStatsCommand(bot: Bot): void {
  bot.command('stats', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const account = await accountService.getAccount(telegramId);
    if (!account) {
      await ctx.reply('⚠️ No account connected. Use <code>/setcookie &lt;cookie&gt;</code> first.', { parse_mode: 'HTML' });
      return;
    }

    // Parse arguments: /stats, /stats 30d, /stats Agil, /stats Agil 30d
    const args = ctx.match?.trim().split(/\s+/) ?? [];
    let days: number | 'all' = 7;
    let nameArg: string | undefined;

    for (const arg of args) {
      if (!arg) continue;
      const lowered = arg.toLowerCase();
      if (lowered === '30d') {
        days = 30;
      } else if (lowered === 'all') {
        days = 'all';
      } else if (lowered === '7d' || lowered === '7') {
        days = 7;
      } else {
        // Assume anything else is part of the username
        nameArg = nameArg ? `${nameArg} ${arg}` : arg;
      }
    }

    let rangeLabel = days === 'all' ? 'All Time' : `Last ${days} days`;
    let subjectId: bigint | undefined;
    let titlePrefix = '📊 <b>Playtime Stats';

    if (nameArg) {
      const foundId = await analyticsService.getSubjectByName(account.id, nameArg);
      if (!foundId) {
        await ctx.reply(`🔍 User "<code>${nameArg}</code>" not found in your tracked friends or users.`, { parse_mode: 'HTML' });
        return;
      }
      subjectId = foundId;
      titlePrefix += ` for ${nameArg}`;
    }

    const stats = await analyticsService.getPlaytimeStats(account.id, days, subjectId);
    const pStats = await analyticsService.getPresenceStats(account.id, days, subjectId);
    
    if (stats.length === 0 && pStats.length === 0) {
      const timeStr = days === 'all' ? 'at all' : `in the last ${days} days`;
      const userStr = nameArg ? ` for <b>${nameArg}</b>` : '';
      await ctx.reply(`📊 No activity recorded${userStr} ${timeStr}.`, { parse_mode: 'HTML' });
      return;
    }

    const lines: string[] = [`${titlePrefix} (${rangeLabel})</b>`, ''];
    
    if (pStats.length > 0) {
      lines.push('<b>Presence:</b>');
      for (const p of pStats) {
        lines.push(`• ${p.type}: ${formatDuration(p.duration)}`);
      }
      lines.push('');
    }

    if (stats.length > 0) {
      lines.push('<b>Games Played:</b>');
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
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });
}

