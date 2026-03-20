import type { Bot } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import { trackService } from '../../services/presence/track.service.js';

export function registerListCommand(bot: Bot): void {
  bot.command(['list', 'tracked'], async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const account = await accountService.getAccount(telegramId);
    if (!account) {
      await ctx.reply('⚠️ No account connected. Use <code>/setcookie &lt;cookie&gt;</code> first.', { parse_mode: 'HTML' });
      return;
    }

    const trackedUsers = await trackService.getTrackedUsers(account.id);

    if (trackedUsers.length === 0) {
      await ctx.reply('📭 You are not manually tracking anyone right now.\nUse <code>/track &lt;username&gt;</code> to start.', { parse_mode: 'HTML' });
      return;
    }

    const escapeHtml = (text: string) => text.replace(/[<>&]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m] as string));

    const lines = ['📋 <b>Manually Tracked Users</b>', ''];
    for (const user of trackedUsers) {
      lines.push(`• ${escapeHtml(user.displayName ?? user.username ?? 'Unknown')} (@${escapeHtml(user.username ?? 'unknown')})`);
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });
}
