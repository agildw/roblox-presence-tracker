import type { Bot } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import { analyticsService } from '../../services/analytics/analytics.service.js';

export function registerHistoryCommand(bot: Bot): void {
  bot.command('history', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const account = await accountService.getAccount(telegramId);
    if (!account) {
      await ctx.reply('⚠️ No account connected. Use `/setcookie <cookie>` first.', { parse_mode: 'Markdown' });
      return;
    }

    const sessions = await analyticsService.getRecentSessions(account.id, 10);
    
    if (sessions.length === 0) {
      await ctx.reply('📭 No recent game sessions found.');
      return;
    }

    const subjectIds = Array.from(new Set(sessions.map(s => s.subjectId)));
    const namesMap = await analyticsService.getSubjectNames(account.id, subjectIds);

    const lines: string[] = ['📜 <b>Recent Game Sessions (Last 10)</b>', ''];
    for (const s of sessions) {
      const gName = s.gameName || 'Unknown Game';
      const durationMins = s.duration ? Math.floor(s.duration / 60) : 0;
      const name = namesMap.get(s.subjectId) || s.subjectId.toString();
      
      const escapeHtml = (text: string) => text.replace(/[<>&]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m] as string));

      // format date nicely
      const dateStr = s.startTime.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      
      lines.push(`• <b>${escapeHtml(name)}</b> played <b>${escapeHtml(gName)}</b> for ${durationMins} mins <i>(${dateStr})</i>`);
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });
}
