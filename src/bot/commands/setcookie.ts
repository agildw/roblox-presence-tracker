/**
 * /setcookie command
 *
 * Usage: /setcookie <.ROBLOSECURITY cookie>
 *
 * Flow:
 *  1. Parse cookie from the message
 *  2. Delete the user's message immediately (security — don't leave cookie in chat)
 *  3. Validate cookie via Roblox API
 *  4. Encrypt + store in DB
 *  5. Trigger friend sync in background (non-blocking)
 *  6. Reply with result
 */

import type { Bot } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import { syncService } from '../../services/sync/sync.service.js';
import { RobloxApiError } from '../../services/roblox/roblox.service.js';

export function registerSetCookieCommand(bot: Bot): void {
  bot.command('setcookie', async (ctx) => {
    // ── 1. Delete user message immediately to protect the cookie ────────────
    // Best-effort — it's fine if Telegram doesn't allow it in some chat types
    try {
      await ctx.deleteMessage();
    } catch {
      // Ignore deletion errors (e.g. in group chats, or message too old)
    }

    // ── 2. Parse the cookie argument ─────────────────────────────────────────
    const cookie = ctx.match?.trim();

    if (!cookie) {
      await ctx.reply(
        '⚠️ Please provide your <code>.ROBLOSECURITY</code> cookie.\n\n' +
          'Usage: <code>/setcookie &lt;your_cookie&gt;</code>\n\n' +
          '🔐 Your message will be deleted immediately for security.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const processing = await ctx.reply('🔄 Validating your cookie…');

    try {
      // ── 3. Upsert TelegramUser ──────────────────────────────────────────────
      const telegramUser = await accountService.upsertTelegramUser({
        telegramId,
        username: ctx.from?.username ?? undefined,
        firstName: ctx.from?.first_name ?? undefined,
      });

      // ── 4. Validate + store account ─────────────────────────────────────────
      const { account, isNew } = await accountService.connectAccount(
        telegramUser,
        cookie,
      );

      const greeting = isNew ? '✅ Account connected!' : '✅ Account updated!';
      const escapeHtml = (text: string) => text.replace(/[<>&]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m] as string));

      await ctx.api.editMessageText(
        ctx.chat.id,
        processing.message_id,
        `${greeting}\n\n` +
          `👤 <b>${escapeHtml(account.displayName || '')}</b> (@${escapeHtml(account.username || '')})\n` +
          `🆔 Roblox ID: <code>${account.robloxUserId}</code>\n\n` +
          `🔄 Syncing friends in the background…`,
        { parse_mode: 'HTML' },
      );

      // ── 5. Trigger friend sync in background (non-blocking) ──────────────────
      void triggerSync(
        ctx.chat.id,
        processing.message_id,
        account,
        cookie,
        ctx,
      );
    } catch (err) {
      // ── Handle validation errors ────────────────────────────────────────────
      let errorMsg = '❌ Failed to connect account.';

      if (err instanceof RobloxApiError) {
        if (err.code === 401 || err.code === 403) {
          errorMsg =
            '❌ <b>Invalid cookie.</b> It may have expired or be incorrect.\n\n' +
            'Please log out and back in to Roblox, then copy a fresh cookie.';
        } else {
          errorMsg = `❌ Roblox API error (${err.code}): ${err.message}`;
        }
      }

      await ctx.api.editMessageText(
        ctx.chat.id,
        processing.message_id,
        errorMsg,
        { parse_mode: 'HTML' },
      );
    }
  });
}

// ── Background sync helper ─────────────────────────────────────────────────────

async function triggerSync(
  chatId: number,
  messageId: number,
  account: Awaited<ReturnType<typeof accountService.connectAccount>>['account'],
  cookie: string,
  ctx: { api: { editMessageText: (chatId: number, messageId: number, text: string, opts?: object) => Promise<unknown> } },
): Promise<void> {
  try {
    const result = await syncService.syncFriends(account, cookie);

    const lines: string[] = [
      `✅ Sync complete!`,
      ``,
      `👥 Friends synced:`,
      `  • Unchanged: ${result.unchanged}`,
    ];

    if (result.added.length > 0) {
      lines.push(`  • ➕ Added: ${result.added.length}`);
      result.added.slice(0, 5).forEach((f) => {
        lines.push(`    — ${f.displayName} (@${f.username})`);
      });
      if (result.added.length > 5) {
        lines.push(`    … and ${result.added.length - 5} more`);
      }
    }

    if (result.removed.length > 0) {
      lines.push(`  • ➖ Removed: ${result.removed.length}`);
      result.removed.slice(0, 5).forEach((f) => {
        lines.push(`    — ${f.displayName} (@${f.username})`);
      });
      if (result.removed.length > 5) {
        lines.push(`    … and ${result.removed.length - 5} more`);
      }
    }

    if (result.added.length === 0 && result.removed.length === 0) {
      lines.push(`  • No changes detected`);
    }

    await ctx.api.editMessageText(chatId, messageId, lines.join('\n'));
  } catch (err) {
    console.error('[setcookie] Background sync failed:', err);
    await ctx.api.editMessageText(
      chatId,
      messageId,
      '✅ Account connected! ⚠️ Auto-sync failed — use /sync to retry.',
    );
  }
}
