import type { Bot } from 'grammy';
import { env } from '../../lib/env.js';
import { accountService } from '../../services/account/account.service.js';
import { prisma } from '../../lib/prisma.js';

export function registerDisableCommand(bot: Bot): void {
  bot.command('disable', async (ctx) => {
    const callerId = String(ctx.from?.id ?? '');
    
    // Check if caller is admin
    if (!env.ADMIN_USER_IDS.includes(callerId)) {
      await ctx.reply('⛔ You do not have permission to use this command.');
      return;
    }

    const target = ctx.match?.trim();
    if (!target) {
      await ctx.reply(
        '⚠️ Please provide the Telegram ID or username of the user to disable.\n\n' +
        'Usage: <code>/disable &lt;id or @username&gt;</code>',
        { parse_mode: 'HTML' }
      );
      return;
    }

    try {
      let telegramId = target;
      
      // If a username was provided (with or without @)
      if (target.startsWith('@') || isNaN(Number(target))) {
        const username = target.startsWith('@') ? target.substring(1) : target;
        const user = await prisma.telegramUser.findFirst({
          where: { username: { equals: username } },
        });
        
        if (!user) {
          await ctx.reply(`❌ Could not find a user with the username @${username}.`);
          return;
        }
        telegramId = user.telegramId;
      }

      // Prevent self-disable
      if (telegramId === callerId) {
        await ctx.reply('❌ You cannot disable yourself.');
        return;
      }

      const disabledUser = await accountService.disableUser(telegramId);
      
      if (!disabledUser) {
        await ctx.reply(`❌ Could not find a user with ID ${telegramId}.`);
        return;
      }

      const escapeHtml = (text: string) => text.replace(/[<>&]/g, (m) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m] as string));
      const displayName = disabledUser.firstName || disabledUser.username || telegramId;

      await ctx.reply(`✅ <b>Successfully disabled user:</b>\n👤 ${escapeHtml(displayName)} (ID: <code>${telegramId}</code>)`, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[disable command] Error:', err);
      await ctx.reply('❌ An error occurred while trying to disable the user.');
    }
  });
}
