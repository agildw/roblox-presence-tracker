/**
 * NotificationService
 *
 * Sends Telegram messages on presence changes and handles debounce logic.
 */

import type { Bot } from 'grammy';
import { prisma } from '../../lib/prisma.js';

export const notificationService = {
  bot: null as Bot | null,

  setBot(botInstance: Bot) {
    this.bot = botInstance;
  },

  /**
   * Sends a generic markdown message to a user.
   */
  async sendDirectMessage(telegramId: string, message: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.sendMessage(telegramId, message, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(`[NotificationService] Failed to send direct message to ${telegramId}:`, err);
    }
  },

  /**
   * Evaluates toggles and debounce before sending a notification.
   */
  async notifyPresenceChange(
    telegramId: string,
    recordId: number,
    type: 'FRIEND' | 'TRACKED',
    message: string,
    event: 'online' | 'offline' | 'game'
  ): Promise<void> {
    if (!this.bot) {
      console.warn('[NotificationService] Bot instance not set. Skipping notification.');
      return;
    }

    // 1. Fetch record to check toggles and debounce target
    let notifyToggle = false;
    let lastNotifiedAt: Date | null = null;
    let displayName = 'Unknown';

    if (type === 'FRIEND') {
      const f = await prisma.friend.findUnique({ where: { id: recordId } });
      if (!f) return;
      notifyToggle = event === 'online' ? f.notifyOnline : event === 'offline' ? f.notifyOffline : f.notifyGame;
      lastNotifiedAt = f.lastNotifiedAt;
      displayName = f.displayName;
    } else {
      const t = await prisma.trackedUser.findUnique({ where: { id: recordId } });
      if (!t) return;
      notifyToggle = event === 'online' ? t.notifyOnline : event === 'offline' ? t.notifyOffline : t.notifyGame;
      lastNotifiedAt = t.lastNotifiedAt;
      displayName = t.displayName ?? t.username ?? 'Unknown';
    }

    // 2. Check if user has opted in to this specific event type
    if (!notifyToggle) return;

    // 3. Debounce — prevent spam if the state flickers heavily (10 seconds)
    if (lastNotifiedAt && (Date.now() - lastNotifiedAt.getTime()) < 10000) {
      console.log(`[NotificationService] Debounced notification for ${displayName} (${event})`);
      return;
    }

    // 4. Send the message
    try {
      await this.bot.api.sendMessage(telegramId, `🔔 *${displayName}*\n\n${message}`, { parse_mode: 'Markdown' });

      // 5. Update debounce timestamp
      const updateData = { lastNotifiedAt: new Date() };
      if (type === 'FRIEND') {
        await prisma.friend.update({ where: { id: recordId }, data: updateData });
      } else {
        await prisma.trackedUser.update({ where: { id: recordId }, data: updateData });
      }
    } catch (err) {
      console.error(`[NotificationService] Failed to send message to ${telegramId}:`, err);
    }
  }
};
