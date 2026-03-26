import type { Bot } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import { trackService } from '../../services/presence/track.service.js';
import { env } from '../../lib/env.js';

export function registerListCommand(bot: Bot): void {
  bot.command(['list', 'tracked'], async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    const isAdmin = env.ADMIN_USER_IDS.includes(telegramId);
    let targetAccountId: number | null = null;

    if (!isAdmin) {
      const account = await accountService.getAccount(telegramId);
      if (!account) {
        await ctx.reply('⚠️ No account connected. Use <code>/setcookie &lt;cookie&gt;</code> first.', { parse_mode: 'HTML' });
        return;
      }
      targetAccountId = account.id;
    }

    const trackedUsersRaw = await trackService.getTrackedUsers(targetAccountId);
    
    // Deduplicate for global admin view
    const trackedUsers = [];
    const seenUsers = new Set<bigint>();
    for (const tu of trackedUsersRaw) {
      if (!seenUsers.has(tu.robloxUserId)) {
        trackedUsers.push(tu);
        seenUsers.add(tu.robloxUserId);
      }
    }

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
