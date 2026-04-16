import { Bot, InlineKeyboard } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import { analyticsService } from '../../services/analytics/analytics.service.js';
import { formatWIB, formatDuration } from '../../lib/date.js';
import { env } from '../../lib/env.js';

async function buildHistoryMessage(accountId: number | null, targetDateStr: string, nameArg?: string, page = 0) {
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

  if (page > 0) {
    title += ` (Page ${page + 1})`;
  }

  const limit = 15;
  const offset = page * limit;
  const sessionsAndNext = await analyticsService.getSessionsForDate(accountId, targetDate, limit + 1, subjectId, offset);
  const hasMore = sessionsAndNext.length > limit;
  const sessions = sessionsAndNext.slice(0, limit);

  let dailySummary: { type: string; duration: number }[] | null = null;
  
  if (subjectId) {
    dailySummary = await analyticsService.getPresenceSummaryForDate(accountId, subjectId, targetDate);
  }
  
  if (sessions.length === 0 && (!dailySummary || dailySummary.length === 0)) {
    const emptyText = `📭 No activity history found for ${nameArg ? `<b>${nameArg}</b>` : 'anyone'} on <b>${targetIsoStr}</b>.`;
    return { text: emptyText, keyboard: buildKeyboard(targetDate, nameArg, page, false) };
  }

  const lines: string[] = [title, ''];
  
  if (page === 0 && dailySummary && dailySummary.length > 0) {
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

  return { text: lines.join('\n'), keyboard: buildKeyboard(targetDate, nameArg, page, hasMore) };
}

function buildKeyboard(targetDate: Date, nameArg: string | undefined, page: number, hasMore: boolean): InlineKeyboard {
  const prevDate = new Date(targetDate);
  prevDate.setDate(prevDate.getDate() - 1);
  const prevStr = `${String(prevDate.getDate()).padStart(2, '0')}-${String(prevDate.getMonth() + 1).padStart(2, '0')}-${prevDate.getFullYear()}`;
  
  const nextDate = new Date(targetDate);
  nextDate.setDate(nextDate.getDate() + 1);
  const nextStr = `${String(nextDate.getDate()).padStart(2, '0')}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${nextDate.getFullYear()}`;
  const currStr = `${String(targetDate.getDate()).padStart(2, '0')}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${targetDate.getFullYear()}`;

  const safeName = nameArg || '';
  const kb = new InlineKeyboard();

  if (hasMore) {
    kb.text('« Prev', `hist:${currStr}:${safeName}:${page + 1}`);
  } else {
    kb.text('« Prev', `hist:${prevStr}:${safeName}:0`);
  }

  if (page > 0) {
    kb.text('Next »', `hist:${currStr}:${safeName}:${page - 1}`);
  } else {
    kb.text('Next »', `hist:${nextStr}:${safeName}:0`);
  }

  return kb;
}

async function buildAllHistoryMessage(accountId: number | null, nameArg: string | undefined, page: number) {
  let subjectId: bigint | undefined;
  let title = `📜 <b>All-Time Game Sessions</b>`;

  if (nameArg) {
    const foundId = await analyticsService.getSubjectByName(accountId, nameArg);
    if (!foundId) {
      return { text: `🔍 User "<code>${nameArg}</code>" not found in your tracked friends or users.`, keyboard: null };
    }
    subjectId = foundId;
    title = `📜 <b>All-Time Activity for ${nameArg}</b>`;
  }

  const limit = 15;
  const offset = page * limit;
  const sessions = await analyticsService.getRecentSessions(accountId, limit, subjectId, offset);
  
  let pStats: { type: string; duration: number }[] = [];
  if (subjectId) {
    pStats = await analyticsService.getPresenceStats(accountId, 'all', subjectId);
  }

  if (sessions.length === 0 && pStats.length === 0) {
    const emptyText = `📭 No activity history found for ${nameArg ? `<b>${nameArg}</b>` : 'anyone'}.`;
    return { text: emptyText, keyboard: null };
  }

  const lines: string[] = [title, ''];
  
  if (page === 0 && subjectId) {
    const livePresence = await analyticsService.getSubjectLivePresence(accountId, subjectId);
    if (livePresence) {
      const types = ['Offline', 'Online (Website)', 'In Game', 'In Studio'];
      const statusStr = types[livePresence.userPresenceType] || 'Unknown';
      const locStr = livePresence.lastLocation ? ` - ${livePresence.lastLocation}` : '';
      
      const lastOnlineDate = new Date(livePresence.lastOnline);
      const loStr = formatWIB(lastOnlineDate);
      
      lines.push(`<b>Current Status:</b> ${statusStr}${locStr}`);
      lines.push(`<b>Last Online:</b> ${loStr}`);
      lines.push('');
    }
  }

  // Only show presence summary on page 0
  if (page === 0 && pStats.length > 0) {
    lines.push('<b>All-Time Presence:</b>');
    for (const s of pStats) {
      lines.push(`- ${s.type}: ${formatDuration(s.duration)}`);
    }
    lines.push('');
  }

  if (sessions.length > 0) {
    lines.push(`<b>Game Sessions (Page ${page + 1}):</b>`);
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

  const safeName = nameArg || '';
  const kb = new InlineKeyboard();
  if (page > 0) {
    kb.text('« Prev', `histAll:${page - 1}:${safeName}`);
  }
  if (sessions.length === limit) {
    kb.text('Next »', `histAll:${page + 1}:${safeName}`);
  }

  return { text: lines.join('\n'), keyboard: kb.inline_keyboard.length > 0 ? kb : null };
}

export function registerHistoryCommand(bot: Bot): void {
  bot.command('history', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const isAdmin = env.ADMIN_USER_IDS.includes(telegramId);
    let targetAccountId: number | null = null;

    if (!isAdmin) {
      const account = await accountService.getAccount(telegramId);
      if (!account) {
        await ctx.reply('⚠️ No account connected. Use `/setcookie <cookie>` first.', { parse_mode: 'Markdown' });
        return;
      }
      targetAccountId = account.id;
    }

    const args = ctx.match?.trim().split(/\s+/) ?? [];
    let nameArg: string | undefined;
    let dateArg: string | undefined;

    if (args.length > 0 && args[0] !== '') {
      const lastArg = args[args.length - 1]!;
      if (lastArg.toLowerCase() === 'all') {
        dateArg = 'all';
        nameArg = args.slice(0, -1).join(' ').trim();
        if (!nameArg) nameArg = undefined;
      } else if (/^\d{2}-\d{2}-\d{4}$/.test(lastArg!)) {
        dateArg = lastArg;
        nameArg = args.slice(0, -1).join(' ').trim();
        if (!nameArg) nameArg = undefined;
      } else {
        nameArg = args.join(' ').trim();
        if (!nameArg) nameArg = undefined;
      }
    }

    if (dateArg === 'all') {
      const { text, keyboard } = await buildAllHistoryMessage(targetAccountId, nameArg, 0);
      if (keyboard) {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
      } else {
        await ctx.reply(text, { parse_mode: 'HTML' });
      }
      return;
    }

    if (!dateArg) {
      const now = new Date();
      dateArg = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
    }

    const { text, keyboard } = await buildHistoryMessage(targetAccountId, dateArg, nameArg);
    if (keyboard) {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML' });
    }
  });

  bot.callbackQuery(/^hist:([0-9-]{10}):([^:]*)(?::(\d+))?$/, async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const isAdmin = env.ADMIN_USER_IDS.includes(telegramId);
    let targetAccountId: number | null = null;

    if (!isAdmin) {
      const account = await accountService.getAccount(telegramId);
      if (!account) {
        await ctx.answerCallbackQuery('No account connected.');
        return;
      }
      targetAccountId = account.id;
    }

    const match = ctx.match;
    if (!match) {
      await ctx.answerCallbackQuery('Invalid callback data.');
      return;
    }

    const dateArg = match[1] as string;
    let nameArg: string | undefined = match[2];
    if (!nameArg || nameArg === '') nameArg = undefined;
    const page = match[3] ? parseInt(match[3], 10) : 0;

    const { text, keyboard } = await buildHistoryMessage(targetAccountId, dateArg, nameArg, page);
    
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

  bot.callbackQuery(/^histAll:(\d+):(.*)$/, async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const isAdmin = env.ADMIN_USER_IDS.includes(telegramId);
    let targetAccountId: number | null = null;

    if (!isAdmin) {
      const account = await accountService.getAccount(telegramId);
      if (!account) {
        await ctx.answerCallbackQuery('No account connected.');
        return;
      }
      targetAccountId = account.id;
    }

    const match = ctx.match;
    if (!match) {
      await ctx.answerCallbackQuery('Invalid callback data.');
      return;
    }

    const page = parseInt(match[1] as string, 10);
    let nameArg: string | undefined = match[2];
    if (!nameArg || nameArg === '') nameArg = undefined;

    const { text, keyboard } = await buildAllHistoryMessage(targetAccountId, nameArg, page);
    
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
