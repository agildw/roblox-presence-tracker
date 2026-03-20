import type { Bot } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import { trackService } from '../../services/presence/track.service.js';

export function registerUntrackCommand(bot: Bot): void {
  bot.command('untrack', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const account = await accountService.getAccount(telegramId);
    if (!account) {
      await ctx.reply('⚠️ No account connected. Use <code>/setcookie &lt;cookie&gt;</code> first.', { parse_mode: 'HTML' });
      return;
    }

    const usernameArg = ctx.match?.trim();
    if (!usernameArg) {
      await ctx.reply('⚠️ Please provide a username. Usage: <code>/untrack &lt;username&gt;</code>', { parse_mode: 'HTML' });
      return;
    }

    const success = await trackService.untrackUser(account.id, usernameArg);

    if (success) {
      await ctx.reply(`✅ No longer tracking <b>${usernameArg}</b>.`, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`⚠️ Was not tracking anyone by the name <b>${usernameArg}</b>.`, { parse_mode: 'HTML' });
    }
  });
}
