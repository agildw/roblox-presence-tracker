import type { Bot } from 'grammy';
import { prisma } from '../../lib/prisma.js';
import { accountService } from '../../services/account/account.service.js';

export function registerNotifyCommand(bot: Bot): void {
  bot.command('notify', async (ctx) => {
    const telegramId = String(ctx.from?.id ?? '');
    if (!telegramId) return;

    // Check account
    const account = await accountService.getAccount(telegramId);
    if (!account) {
      await ctx.reply('⚠️ Connect your Roblox account first using `/setcookie`.', { parse_mode: 'Markdown' });
      return;
    }

    // Parse args
    const rawArgs = ctx.match?.trim().split(/\s+/);
    if (!rawArgs || rawArgs.length < 1 || !rawArgs[0]) {
      await ctx.reply(
        '⚠️ Usage: `/notify <username> [online|offline|game|all]`\n\n' +
        'Example: `/notify RobloxUser123 all`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const targetUsername = rawArgs[0];
    const eventType = rawArgs[1]?.toLowerCase() || 'all';

    const validTypes = ['online', 'offline', 'game', 'all'];
    if (!validTypes.includes(eventType)) {
      await ctx.reply('⚠️ Invalid event type. Use `online`, `offline`, `game`, or `all`.', { parse_mode: 'Markdown' });
      return;
    }

    // Find the user in Friend or TrackedUser
    const friend = await prisma.friend.findFirst({
      where: { robloxAccountId: account.id, username: { equals: targetUsername } }
    });

    const tracked = !friend ? await prisma.trackedUser.findFirst({
      where: { robloxAccountId: account.id, username: { equals: targetUsername } }
    }) : null;

    if (!friend && !tracked) {
      await ctx.reply(`⚠️ Cannot find user \`${targetUsername}\` in your friends or tracked users.`, { parse_mode: 'Markdown' });
      return;
    }

    const dbId = friend ? friend.id : tracked!.id;
    const isFriend = !!friend;

    const dataToUpdate: any = {};
    if (eventType === 'online' || eventType === 'all') dataToUpdate.notifyOnline = true;
    if (eventType === 'offline' || eventType === 'all') dataToUpdate.notifyOffline = true;
    if (eventType === 'game' || eventType === 'all') dataToUpdate.notifyGame = true;

    if (isFriend) {
      await prisma.friend.update({ where: { id: dbId }, data: dataToUpdate });
    } else {
      await prisma.trackedUser.update({ where: { id: dbId }, data: dataToUpdate });
    }

    await ctx.reply(`✅ Added notification filters for **${targetUsername}**.\n\nFilters enabled: \`${eventType}\``, { parse_mode: 'Markdown' });
  });
}
