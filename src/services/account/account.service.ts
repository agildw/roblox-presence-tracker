/**
 * AccountService
 *
 * Handles connecting/updating a Roblox account for a Telegram user.
 * Responsibilities:
 *  - Upsert TelegramUser
 *  - Validate .ROBLOSECURITY cookie
 *  - Encrypt and store the cookie
 *  - Create or update the RobloxAccount record
 */

import { prisma } from '../../lib/prisma.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { robloxService, RobloxApiError } from '../roblox/roblox.service.js';
import type { RobloxAccount, TelegramUser } from '../../generated/prisma/client.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TelegramUserInfo {
  telegramId: string;
  username?: string | undefined;
  firstName?: string | undefined;
}

export interface ConnectAccountResult {
  account: RobloxAccount;
  isNew: boolean;       // true = first time connecting; false = updated existing
}

// ── Service ───────────────────────────────────────────────────────────────────

export const accountService = {
  // ── upsertTelegramUser ──────────────────────────────────────────────────────
  /**
   * Ensures a TelegramUser record exists for this chat participant.
   * Called before any account operation.
   */
  async upsertTelegramUser(info: TelegramUserInfo): Promise<TelegramUser> {
    return prisma.telegramUser.upsert({
      where: { telegramId: info.telegramId },
      create: {
        telegramId: info.telegramId,
        username: info.username ?? null,
        firstName: info.firstName ?? null,
      },
      update: {
        username: info.username ?? null,
        firstName: info.firstName ?? null,
      },
    });
  },

  // ── connectAccount ──────────────────────────────────────────────────────────
  /**
   * Validates a .ROBLOSECURITY cookie, then creates or updates the
   * RobloxAccount linked to the given Telegram user.
   *
   * Throws RobloxApiError if the cookie is invalid.
   */
  async connectAccount(
    telegramUser: TelegramUser,
    rawCookie: string,
  ): Promise<ConnectAccountResult> {
    // 1. Validate cookie → get Roblox identity
    const robloxUser = await robloxService.validateCookie(rawCookie);

    // 2. Encrypt cookie for storage
    const encryptedCookie = encrypt(rawCookie);

    // 3. Upsert RobloxAccount
    const existing = await prisma.robloxAccount.findUnique({
      where: { userId: telegramUser.id },
    });

    const account = await prisma.robloxAccount.upsert({
      where: { userId: telegramUser.id },
      create: {
        userId: telegramUser.id,
        robloxUserId: BigInt(robloxUser.id),
        username: robloxUser.name,
        displayName: robloxUser.displayName,
        roblosecurity: encryptedCookie,
      },
      update: {
        robloxUserId: BigInt(robloxUser.id),
        username: robloxUser.name,
        displayName: robloxUser.displayName,
        roblosecurity: encryptedCookie,
      },
    });

    return { account, isNew: existing === null };
  },

  // ── getDecryptedCookie ──────────────────────────────────────────────────────
  /**
   * Retrieves and decrypts the stored cookie for a Telegram user.
   * Returns null if the user has no connected account.
   */
  async getDecryptedCookie(telegramId: string): Promise<string | null> {
    const user = await prisma.telegramUser.findUnique({
      where: { telegramId },
      include: { robloxAccount: { select: { roblosecurity: true } } },
    });

    const encrypted = user?.robloxAccount?.roblosecurity;
    if (!encrypted) return null;

    return decrypt(encrypted);
  },

  // ── getAccount ─────────────────────────────────────────────────────────────
  /**
   * Returns the full RobloxAccount for a Telegram user, or null if not connected.
   */
  async getAccount(telegramId: string): Promise<RobloxAccount | null> {
    const user = await prisma.telegramUser.findUnique({
      where: { telegramId },
      include: { robloxAccount: true },
    });
    return user?.robloxAccount ?? null;
  },

  // ── getDecryptedCookieByAccountId ───────────────────────────────────────────
  /**
   * Retrieves and decrypts the stored cookie for a specific RobloxAccount.
   */
  async getDecryptedCookieByAccountId(accountId: number): Promise<string | null> {
    const account = await prisma.robloxAccount.findUnique({
      where: { id: accountId },
      select: { roblosecurity: true },
    });

    const encrypted = account?.roblosecurity;
    if (!encrypted) return null;

    return decrypt(encrypted);
  },
};
