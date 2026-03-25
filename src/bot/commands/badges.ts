import { Bot, InlineKeyboard } from 'grammy';
import { randomUUID } from 'crypto';
import { accountService } from '../../services/account/account.service.js';
import { robloxService } from '../../services/roblox/roblox.service.js';
import { formatWIB } from '../../lib/date.js';

// ── Pagination Cache ──────────────────────────────────────────────────────────

// Light memory cache mapping short UUIDs to full cursor strings for pagination.
// This prevents hitting Telegram's 64-byte callback_data limit since cursors are ~230 bytes.
const cursorCache = new Map<string, string>();
const MAX_CACHE_SIZE = 1000;

function storeCursor(cursor: string | null | undefined): string {
  if (!cursor) return 'null';
  
  if (cursorCache.size > MAX_CACHE_SIZE) {
    // Evict oldest items simply
    const keysToEvict = Array.from(cursorCache.keys()).slice(0, Math.floor(MAX_CACHE_SIZE / 2));
    for (const key of keysToEvict) cursorCache.delete(key);
  }
  
  const shortId = randomUUID().substring(0, 8);
  cursorCache.set(shortId, cursor);
  return shortId;
}

// ── Message Builder ───────────────────────────────────────────────────────────

async function buildBadgesMessage(cookie: string, userId: number, username: string, cursorId?: string) {
  let actualCursor: string | undefined;
  
  if (cursorId && cursorId !== 'start') {
    const cached = cursorCache.get(cursorId);
    if (!cached) {
      return { 
        text: `⚠️ Pagination session expired or invalid. Please run <code>/badges ${username}</code> again.`, 
        keyboard: null 
      };
    }
    actualCursor = cached;
  }

  const badgesRes = await robloxService.getBadges(cookie, userId, actualCursor);
  
  if (!badgesRes || !badgesRes.data) {
    return { 
      text: `❌ Failed to fetch badges for <b>${username}</b>.`, 
      keyboard: null 
    };
  }

  if (badgesRes.data.length === 0) {
    return { 
      text: `📭 No badges found for <b>${username}</b>.`, 
      keyboard: null 
    };
  }

  const badgeIds = badgesRes.data.map((b) => b.id);
  const awardRes = await robloxService.getBadgeAwardedDates(cookie, userId, badgeIds);
  
  // Map badgeId -> awardedDate
  const awardedMap = new Map<number, string>();
  if (awardRes && awardRes.data) {
    for (const ad of awardRes.data) {
      awardedMap.set(ad.badgeId, ad.awardedDate);
    }
  }

  const escapeHtml = (text: string) => text.replace(/[<>&]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m] as string));

  let text = `🏆 <b>Recent Badges for ${escapeHtml(username)}</b>\n\n`;
  for (const b of badgesRes.data) {
    const dateStr = awardedMap.get(b.id);
    let dateFormatted = 'Unknown Date';
    if (dateStr) {
      const d = new Date(dateStr);
      dateFormatted = formatWIB(d);
    }
    text += `• <b>${escapeHtml(b.name)}</b> <i>(${dateFormatted})</i>\n`;
  }

  const kb = new InlineKeyboard();
  let hasButtons = false;

  const callbackUser = encodeURIComponent(username);

  if (badgesRes.previousPageCursor) {
    const prevId = storeCursor(badgesRes.previousPageCursor);
    kb.text('« Prev', `bdg:${userId}:${prevId}:${callbackUser}`);
    hasButtons = true;
  }
  
  if (badgesRes.nextPageCursor) {
    const nextId = storeCursor(badgesRes.nextPageCursor);
    kb.text('Next »', `bdg:${userId}:${nextId}:${callbackUser}`);
    hasButtons = true;
  }

  return { text, keyboard: hasButtons ? kb : null };
}

// ── Command Registration ──────────────────────────────────────────────────────

export function registerBadgesCommand(bot: Bot): void {
  bot.command('badges', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const cookie = await accountService.getDecryptedCookie(telegramId);
    if (!cookie) {
      await ctx.reply('⚠️ No account connected. Use `/setcookie <cookie>` first.', { parse_mode: 'Markdown' });
      return;
    }

    const args = ctx.match?.trim().split(/\s+/) ?? [];
    let usernameArg = args.join(' ').trim();

    if (!usernameArg) {
      const account = await accountService.getAccount(telegramId);
      if (account && account.username) {
        usernameArg = account.username;
      } else {
        await ctx.reply(`Usage: <code>/badges &lt;username&gt;</code>`, { parse_mode: 'HTML' });
        return;
      }
    }

    const robloxUser = await robloxService.getUserByUsername(cookie, usernameArg);
    if (!robloxUser) {
      await ctx.reply(`🔍 Could not find user: <b>${usernameArg}</b>`, { parse_mode: 'HTML' });
      return;
    }

    const { text, keyboard } = await buildBadgesMessage(cookie, robloxUser.id, robloxUser.name);
    
    if (keyboard) {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML' });
    }
  });

  bot.callbackQuery(/^bdg:(\d+):([a-z0-9-]+):(.*)$/, async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const cookie = await accountService.getDecryptedCookie(telegramId);
    if (!cookie) {
      await ctx.answerCallbackQuery('No account connected.');
      return;
    }

    const match = ctx.match;
    if (!match) {
      await ctx.answerCallbackQuery('Invalid callback data.');
      return;
    }

    const userId = parseInt(match[1] as string, 10);
    const cursorId = match[2] as string;
    const username = decodeURIComponent(match[3] as string);

    const { text, keyboard } = await buildBadgesMessage(cookie, userId, username, cursorId);
    
    try {
      if (keyboard) {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
      } else {
        await ctx.editMessageText(text, { parse_mode: 'HTML' });
      }
    } catch (e) {
      // Ignore identical message errors
    }
    await ctx.answerCallbackQuery();
  });
}
