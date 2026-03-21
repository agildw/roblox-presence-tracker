import type { Bot } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import { analyticsService } from '../../services/analytics/analytics.service.js';
import { formatWIB, formatDuration } from '../../lib/date.js';

export function registerHistoryCommand(bot: Bot): void {
  bot.command('history', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const account = await accountService.getAccount(telegramId);
    if (!account) {
      await ctx.reply('⚠️ No account connected. Use `/setcookie <cookie>` first.', { parse_mode: 'Markdown' });
      return;
    }

    const args = ctx.match?.trim().split(/\s+/) ?? [];
    let nameArg: string | undefined;
    let dateArg: string | undefined;

    if (args.length > 0 && args[0] !== '') {
      const lastArg = args[args.length - 1];
      if (/^\d{2}-\d{2}-\d{4}$/.test(lastArg!)) {
        dateArg = lastArg;
        nameArg = args.slice(0, -1).join(' ').trim();
        if (!nameArg) nameArg = undefined;
      } else {
        nameArg = args.join(' ').trim();
        if (!nameArg) nameArg = undefined;
      }
    }

    let targetDate = new Date();
    if (dateArg) {
      const [dd, mm, yyyy] = dateArg.split('-');
      targetDate = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    }
    targetDate.setHours(0, 0, 0, 0);
    const targetDateStr = targetDate.toISOString().split('T')[0];

    let subjectId: bigint | undefined;
    let title = `📜 <b>Game Sessions on ${targetDateStr}</b>`;

    if (nameArg) {
      const foundId = await analyticsService.getSubjectByName(account.id, nameArg!);
      if (!foundId) {
        await ctx.reply(`🔍 User "<code>${nameArg}</code>" not found in your tracked friends or users.`, { parse_mode: 'HTML' });
        return;
      }
      subjectId = foundId;
      title = `📜 <b>Activity for ${nameArg} on ${targetDateStr}</b>`;
    }

    const sessions = await analyticsService.getSessionsForDate(account.id, targetDate, 15, subjectId);
    let dailySummary: { type: string; duration: number }[] | null = null;
    
    if (subjectId) {
      dailySummary = await analyticsService.getPresenceSummaryForDate(account.id, subjectId, targetDate);
    }
    
    if (sessions.length === 0 && (!dailySummary || dailySummary.length === 0)) {
      await ctx.reply(`📭 No activity history found for ${nameArg ? `<b>${nameArg}</b>` : 'anyone'} on <b>${targetDateStr}</b>.`, { parse_mode: 'HTML' });
      return;
    }

    const lines: string[] = [title, ''];
    
    if (dailySummary && dailySummary.length > 0) {
      lines.push('<b>Presence Summary:</b>');
      for (const s of dailySummary) {
        lines.push(`- ${s.type}: ${formatDuration(s.duration)}`);
      }
      lines.push('');
    }

    if (sessions.length > 0) {
      lines.push('<b>Game Sessions:</b>');
      const subjectIds = Array.from(new Set(sessions.map(s => s.subjectId)));
      const namesMap = await analyticsService.getSubjectNames(account.id, subjectIds);

      for (const s of sessions) {
        const gName = s.gameName || 'Unknown Game';
        const durationMins = s.duration ? Math.floor(s.duration / 60) : 0;
        const name = namesMap.get(s.subjectId) || s.subjectId.toString();
        
        const escapeHtml = (text: string) => text.replace(/[<>&]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m] as string));
        const dateStr = formatWIB(s.startTime);
        
        lines.push(`• <b>${escapeHtml(name)}</b> played <b>${escapeHtml(gName)}</b> for ${durationMins} mins <i>(${dateStr})</i>`);
      }
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });
}
