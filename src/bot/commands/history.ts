import type { Bot } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import { analyticsService } from '../../services/analytics/analytics.service.js';
import { formatWIB } from '../../lib/date.js';

export function registerHistoryCommand(bot: Bot): void {
  bot.command('history', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const account = await accountService.getAccount(telegramId);
    if (!account) {
      await ctx.reply('⚠️ No account connected. Use `/setcookie <cookie>` first.', { parse_mode: 'Markdown' });
      return;
    }

    const nameArg = ctx.match?.trim();
    let subjectId: bigint | undefined;
    let title = '📜 <b>Recent Game Sessions (Last 10)</b>';

    if (nameArg) {
      const foundId = await analyticsService.getSubjectByName(account.id, nameArg);
      if (!foundId) {
        await ctx.reply(`🔍 User "<code>${nameArg}</code>" not found in your tracked friends or users.`, { parse_mode: 'HTML' });
        return;
      }
      subjectId = foundId;
      title = `📜 <b>Recent Sessions for ${nameArg}</b>`;
    }

    const sessions = await analyticsService.getRecentSessions(account.id, 10, subjectId);
    
    if (sessions.length === 0) {
      await ctx.reply(nameArg ? `📭 No recent game sessions found for <b>${nameArg}</b>.` : '📭 No recent game sessions found.', { parse_mode: 'HTML' });
      return;
    }

    const subjectIds = Array.from(new Set(sessions.map(s => s.subjectId)));
    const namesMap = await analyticsService.getSubjectNames(account.id, subjectIds);

    const lines: string[] = [title, ''];
    for (const s of sessions) {
      const gName = s.gameName || 'Unknown Game';
      const durationMins = s.duration ? Math.floor(s.duration / 60) : 0;
      const name = namesMap.get(s.subjectId) || s.subjectId.toString();
      
      const escapeHtml = (text: string) => text.replace(/[<>&]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m] as string));

      // format date nicely
      const dateStr = formatWIB(s.startTime);
      
      lines.push(`• <b>${escapeHtml(name)}</b> played <b>${escapeHtml(gName)}</b> for ${durationMins} mins <i>(${dateStr})</i>`);
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });
}
