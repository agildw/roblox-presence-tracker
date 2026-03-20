import type { Bot } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import { robloxService, RobloxApiError } from '../../services/roblox/roblox.service.js';
import { decrypt } from '../../lib/crypto.js';
import { trackService } from '../../services/presence/track.service.js';

export function registerTrackCommand(bot: Bot): void {
  bot.command('track', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const account = await accountService.getAccount(telegramId);
    if (!account) {
      await ctx.reply('⚠️ No account connected. Use <code>/setcookie &lt;cookie&gt;</code> first.', { parse_mode: 'HTML' });
      return;
    }

    const usernameArg = ctx.match?.trim();
    if (!usernameArg) {
      await ctx.reply('⚠️ Please provide a username. Usage: <code>/track &lt;username&gt;</code>', { parse_mode: 'HTML' });
      return;
    }

    const progress = await ctx.reply(`🔍 Looking up user <b>${usernameArg}</b>...`, { parse_mode: 'HTML' });

    try {
      const cookie = decrypt(account.roblosecurity);
      const user = await robloxService.getUserByUsername(cookie, usernameArg);

      if (!user) {
        await ctx.api.editMessageText(ctx.chat.id, progress.message_id, `❌ Could not find a Roblox user named <b>${usernameArg}</b>.`, { parse_mode: 'HTML' });
        return;
      }

      await trackService.trackUser(account.id, user);

      await ctx.api.editMessageText(ctx.chat.id, progress.message_id, `✅ Now tracking <b>${user.displayName}</b> (@${user.name}).`, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[track] Failed to track user:', err);
      const msg = err instanceof RobloxApiError ? err.message : 'Unknown error';
      await ctx.api.editMessageText(ctx.chat.id, progress.message_id, `❌ Failed to track user: ${msg}`, { parse_mode: 'HTML' });
    }
  });
}
