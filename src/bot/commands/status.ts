import type { Bot } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import { analyticsService } from '../../services/analytics/analytics.service.js';

export function registerStatusCommand(bot: Bot): void {
  bot.command('status', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const account = await accountService.getAccount(telegramId);
    if (!account) {
      await ctx.reply('⚠️ No account connected. Use `/setcookie <cookie>` first.', { parse_mode: 'Markdown' });
      return;
    }

    const sessions = await analyticsService.getActiveSessions(account.id);
    
    if (sessions.length === 0) {
      await ctx.reply('💤 No friends or tracked users are currently playing any games.');
      return;
    }

    const subjectIds = Array.from(new Set(sessions.map(s => s.subjectId)));
    const namesMap = await analyticsService.getSubjectNames(account.id, subjectIds);

    const lines: string[] = ['🎮 <b>Current Active Sessions</b>', ''];
    for (const s of sessions) {
      const gName = s.gameName || 'Unknown Game';
      const durationMins = Math.floor((new Date().getTime() - s.startTime.getTime()) / 1000 / 60);
      const name = namesMap.get(s.subjectId) || s.subjectId.toString();
      
      const escapeHtml = (text: string) => text.replace(/[<>&]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m] as string));

      let sessionStr = `• <b>${escapeHtml(name)}</b> has been playing <b>${escapeHtml(gName)}</b> for ${durationMins} mins`;
      if (s.placeId && s.serverId) {
        sessionStr += `\n  <a href="https://www.roblox.com/games/start?placeId=${s.placeId}&gameId=${s.serverId}">🎮 Join Game</a>`;
      }
      lines.push(sessionStr);
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });
}
