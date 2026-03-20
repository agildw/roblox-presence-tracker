/**
 * /sync command
 *
 * Manually re-syncs the user's Roblox friend list.
 * Always replies with a result (even if no changes).
 *
 * Runs in the foreground (awaited) since the user explicitly asked for it,
 * so they get immediate feedback. For scheduled/auto sync, use the worker.
 */

import type { Bot } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import { syncService } from '../../services/sync/sync.service.js';
import { decrypt } from '../../lib/crypto.js';

export function registerSyncCommand(bot: Bot): void {
  bot.command('sync', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    // ── 1. Check account is connected ─────────────────────────────────────────
    const account = await accountService.getAccount(telegramId);
    if (!account) {
      await ctx.reply(
        '⚠️ No account connected.\n\nUse <code>/setcookie &lt;cookie&gt;</code> to connect your Roblox account first.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const progress = await ctx.reply('🔄 Syncing friends…');

    try {
      // ── 2. Decrypt cookie ──────────────────────────────────────────────────
      const cookie = decrypt(account.roblosecurity);

      // ── 3. Run sync ────────────────────────────────────────────────────────
      const result = await syncService.syncFriends(account, cookie);

      const escapeHtml = (text: string) => text.replace(/[<>&]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m] as string));

      // ── 4. Format result ───────────────────────────────────────────────────
      const lines: string[] = ['🔄 <b>Sync complete!</b>', ''];

      if (result.added.length === 0 && result.removed.length === 0) {
        lines.push(`✅ No changes — ${result.unchanged} friend(s) up to date.`);
      } else {
        lines.push(`👥 ${result.unchanged} friend(s) unchanged`);

        if (result.added.length > 0) {
          lines.push('', `➕ <b>Added (${result.added.length}):</b>`);
          result.added.slice(0, 10).forEach((f) => {
            lines.push(`  • ${escapeHtml(f.displayName)} (@${escapeHtml(f.username)})`);
          });
          if (result.added.length > 10) {
            lines.push(`  <i>…and ${result.added.length - 10} more</i>`);
          }
        }

        if (result.removed.length > 0) {
          lines.push('', `➖ <b>Removed (${result.removed.length}):</b>`);
          result.removed.slice(0, 10).forEach((f) => {
            lines.push(`  • ${escapeHtml(f.displayName)} (@${escapeHtml(f.username)})`);
          });
          if (result.removed.length > 10) {
            lines.push(`  <i>…and ${result.removed.length - 10} more</i>`);
          }
        }
      }

      await ctx.api.editMessageText(
        ctx.chat.id,
        progress.message_id,
        lines.join('\n'),
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      console.error('[sync] Sync failed:', err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        progress.message_id,
        '❌ Sync failed. Your cookie may have expired — use <code>/setcookie</code> to reconnect.',
        { parse_mode: 'HTML' },
      );
    }
  });
}
