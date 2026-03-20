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
        '⚠️ No account connected.\n\nUse `/setcookie <cookie>` to connect your Roblox account first.',
        { parse_mode: 'Markdown' },
      );
      return;
    }

    const progress = await ctx.reply('🔄 Syncing friends…');

    try {
      // ── 2. Decrypt cookie ──────────────────────────────────────────────────
      const cookie = decrypt(account.roblosecurity);

      // ── 3. Run sync ────────────────────────────────────────────────────────
      const result = await syncService.syncFriends(account, cookie);

      // ── 4. Format result ───────────────────────────────────────────────────
      const lines: string[] = ['🔄 *Sync complete!*', ''];

      if (result.added.length === 0 && result.removed.length === 0) {
        lines.push(`✅ No changes — ${result.unchanged} friend(s) up to date.`);
      } else {
        lines.push(`👥 ${result.unchanged} friend(s) unchanged`);

        if (result.added.length > 0) {
          lines.push('', `➕ *Added (${result.added.length}):*`);
          result.added.slice(0, 10).forEach((f) => {
            lines.push(`  • ${f.displayName} (@${f.username})`);
          });
          if (result.added.length > 10) {
            lines.push(`  _…and ${result.added.length - 10} more_`);
          }
        }

        if (result.removed.length > 0) {
          lines.push('', `➖ *Removed (${result.removed.length}):*`);
          result.removed.slice(0, 10).forEach((f) => {
            lines.push(`  • ${f.displayName} (@${f.username})`);
          });
          if (result.removed.length > 10) {
            lines.push(`  _…and ${result.removed.length - 10} more_`);
          }
        }
      }

      await ctx.api.editMessageText(
        ctx.chat.id,
        progress.message_id,
        lines.join('\n'),
        { parse_mode: 'Markdown' },
      );
    } catch (err) {
      console.error('[sync] Sync failed:', err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        progress.message_id,
        '❌ Sync failed. Your cookie may have expired — use `/setcookie` to reconnect.',
        { parse_mode: 'Markdown' },
      );
    }
  });
}
