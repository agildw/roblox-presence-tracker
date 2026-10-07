import type { Context, NextFunction } from 'grammy';
import { accountService } from '../../services/account/account.service.js';

export async function disabledGuard(ctx: Context, next: NextFunction): Promise<void> {
  const telegramId = String(ctx.from?.id ?? '');
  if (!telegramId) return next();

  const disabled = await accountService.isUserDisabled(telegramId);
  if (disabled) {
    await ctx.reply('🚫 Your account has been disabled. Contact an admin for assistance.');
    return; // don't call next() — block all further processing
  }

  return next();
}
