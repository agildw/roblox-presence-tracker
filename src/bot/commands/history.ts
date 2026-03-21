import { Bot, InlineKeyboard } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import { analyticsService } from '../../services/analytics/analytics.service.js';
import { formatWIB, formatDuration } from '../../lib/date.js';

async function buildHistoryMessage(accountId: number, targetDateStr: string, nameArg?: string) {
  const [dd, mm, yyyy] = targetDateStr.split('-');
  const targetDate = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  targetDate.setHours(0, 0, 0, 0);
  const targetIsoStr = targetDate.toISOString().split('T')[0];

  let subjectId: bigint | undefined;
  let title = `📜 <b>Game Sessions on ${targetIsoStr}</b>`;

  if (nameArg) {
    const foundId = await analyticsService.getSubjectByName(accountId, nameArg);
    if (!foundId) {
      return { text: `🔍 User "<code>${nameArg}</code>" not found in your tracked friends or users.`, keyboard: null };
    }
    subjectId = foundId;
    title = `📜 <b>Activity for ${nameArg} on ${targetIsoStr}</b>`;
  }

  const sessions = await analyticsService.getSessionsForDate(accountId, targetDate, 15, subjectId);
  let dailySummary: { type: string; duration: number }[] | null = null;
  
  if (subjectId) {
    dailySummary = await analyticsService.getPresenceSummaryForDate(accountId, subjectId, targetDate);
  }
  
  if (sessions.length === 0 && (!dailySummary || dailySummary.length === 0)) {
    const emptyText = `📭 No activity history found for ${nameArg ? `<b>${nameArg}</b>` : 'anyone'} on <b>${targetIsoStr}</b>.`;
    return { text: emptyText, keyboard: buildKeyboard(targetDate, nameArg) };
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
    const namesMap = await analyticsService.getSubjectNames(accountId, subjectIds);

    for (const s of sessions) {
      const gName = s.gameName || 'Unknown Game';
      const durationMins = s.duration ? Math.floor(s.duration / 60) : 0;
      const name = namesMap.get(s.subjectId) || s.subjectId.toString();
      
      const escapeHtml = (text: string) => text.replace(/[<>&]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m] as string));
      const dateStr = formatWIB(s.startTime);
      
      lines.push(`• <b>${escapeHtml(name)}</b> played <b>${escapeHtml(gName)}</b> for ${durationMins} mins <i>(${dateStr})</i>`);
    }
  }

  return { text: lines.join('\n'), keyboard: buildKeyboard(targetDate, nameArg) };
}

function buildKeyboard(targetDate: Date, nameArg?: string): InlineKeyboard {
  const prevDate = new Date(targetDate);
  prevDate.setDate(prevDate.getDate() - 1);
  const prevStr = `${String(prevDate.getDate()).padStart(2, '0')}-${String(prevDate.getMonth() + 1).padStart(2, '0')}-${prevDate.getFullYear()}`;
  
  const nextDate = new Date(targetDate);
  nextDate.setDate(nextDate.getDate() + 1);
  const nextStr = `${String(nextDate.getDate()).padStart(2, '0')}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${nextDate.getFullYear()}`;

  const safeName = nameArg || '';

  return new InlineKeyboard()
    .text('« Prev', `hist:${prevStr}:${safeName}`)
    .text('Next »', `hist:${nextStr}:${safeName}`);
}

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

    if (!dateArg) {
      const now = new Date();
      dateArg = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
    }

    const { text, keyboard } = await buildHistoryMessage(account.id, dateArg, nameArg);
    if (keyboard) {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML' });
    }
  });

  bot.callbackQuery(/^hist:(.+):(.*)$/, async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const account = await accountService.getAccount(telegramId);
    if (!account) {
      await ctx.answerCallbackQuery('No account connected.');
      return;
    }

    const match = ctx.match;
    if (!match) {
      await ctx.answerCallbackQuery('Invalid callback data.');
      return;
    }

    const dateArg = match[1] as string;
    let nameArg: string | undefined = match[2];
    if (!nameArg || nameArg === '') nameArg = undefined;

    const { text, keyboard } = await buildHistoryMessage(account.id, dateArg, nameArg);
    
    try {
      if (keyboard) {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
      } else {
        await ctx.editMessageText(text, { parse_mode: 'HTML' });
      }
    } catch (e) {
      // Ignore "message is not modified" errors
    }
    await ctx.answerCallbackQuery();
  });
}
