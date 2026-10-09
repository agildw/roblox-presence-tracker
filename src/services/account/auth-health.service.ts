/**
 * AuthHealthService
 *
 * Guards against the failure mode that produced the long 429 incident: a stored
 * `.ROBLOSECURITY` cookie that has expired. Roblox does **not** reject an
 * expired cookie on `presence.roblox.com` with a 401 — it answers 200 and treats
 * the caller as anonymous, subjecting it to the much stricter unauthenticated
 * limiter. The bot therefore sees "429 on a normal poll" while nothing is wrong
 * with its pacing, and every presence request is silently downgraded.
 *
 * This service validates the cookie against `users.roblox.com/v1/users/authenticated`
 * (the endpoint that *does* answer 401) through the same shared limiter:
 *  - at startup
 *  - every `AUTH_CHECK_INTERVAL_MS`
 *  - immediately whenever a presence cycle is throttled
 *
 * While an account is known to be invalid, presence cycles skip it entirely
 * rather than processing anonymous results. A successful `/setcookie` clears the
 * state and polling resumes automatically.
 *
 * Safety: the cookie is only ever passed to the Roblox client. It is never
 * logged, and no error message here includes it.
 */

import { env } from '../../lib/env.js';
import { prisma } from '../../lib/prisma.js';
import { accountService } from './account.service.js';
import { robloxService, RobloxApiError } from '../roblox/roblox.service.js';
import { notificationService } from '../notification/notification.service.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuthStatus = 'valid' | 'invalid' | 'unknown';

interface AuthState {
  /** True once a 401/403 has been observed and not yet cleared. */
  invalid: boolean;
  /** Last validation outcome, for diagnostics. */
  status: AuthStatus;
  /** When the last validation ran. */
  lastCheckAt: number;
  /** When the last alert was sent (0 = never). */
  lastAlertAt: number;
  /** Safe, cookie-free description of the last failure. */
  lastError: string | null;
}

// ── State ─────────────────────────────────────────────────────────────────────

const states = new Map<number, AuthState>();

function stateFor(accountId: number): AuthState {
  let state = states.get(accountId);
  if (!state) {
    state = { invalid: false, status: 'unknown', lastCheckAt: 0, lastAlertAt: 0, lastError: null };
    states.set(accountId, state);
  }
  return state;
}

// ── Service ───────────────────────────────────────────────────────────────────

export const authHealthService = {
  /** True while the account's cookie is known invalid; presence skips it. */
  isInvalid(accountId: number): boolean {
    return stateFor(accountId).invalid;
  },

  /** Current state, for diagnostics/tests. */
  snapshot(accountId: number): Readonly<AuthState> {
    return stateFor(accountId);
  },

  /** Clears the invalid flag after a fresh cookie is stored (`/setcookie`). */
  markValid(accountId: number): void {
    const state = stateFor(accountId);
    if (state.invalid) {
      console.log(`[AuthHealth] Account ${accountId}: cookie replaced; resuming presence polling.`);
    }
    state.invalid = false;
    state.status = 'valid';
    state.lastError = null;
  },

  /**
   * Validates the account's stored cookie, updates state, and alerts once if it
   * has become invalid. Returns the outcome; never throws for an invalid cookie
   * (that is a normal, handled result).
   */
  async checkAccount(accountId: number): Promise<AuthStatus> {
    const account = await prisma.robloxAccount.findUnique({
      where: { id: accountId },
      select: { id: true, username: true, displayName: true, user: { select: { telegramId: true } } },
    });
    if (!account) return 'unknown';

    const cookie = await accountService.getDecryptedCookieByAccountId(accountId);
    if (!cookie) {
      this.recordInvalid(accountId, account.user.telegramId, account.displayName || account.username || String(accountId), 'No stored cookie.');
      return 'invalid';
    }

    const state = stateFor(accountId);
    state.lastCheckAt = Date.now();

    try {
      await robloxService.validateCookie(cookie);
      const wasInvalid = state.invalid;
      state.invalid = false;
      state.status = 'valid';
      state.lastError = null;
      if (wasInvalid) {
        console.log(`[AuthHealth] Account ${accountId}: cookie is valid again.`);
      }
      return 'valid';
    } catch (err) {
      const code = err instanceof RobloxApiError ? err.code : 0;

      // Only an explicit 401/403 proves the cookie is dead. Anything else
      // (cooldown, network, 5xx) is 'unknown' and must NOT trip the flag —
      // otherwise a transient throttle would be misread as an expired cookie.
      if (code === 401 || code === 403) {
        this.recordInvalid(
          accountId,
          account.user.telegramId,
          account.displayName || account.username || String(accountId),
          `Roblox rejected the cookie (HTTP ${code}).`,
        );
        return 'invalid';
      }

      state.status = 'unknown';
      state.lastError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[AuthHealth] Account ${accountId}: cookie check inconclusive (${state.lastError}); ` +
          `leaving auth state unchanged.`,
      );
      return 'unknown';
    }
  },

  /** Validates every connected, non-disabled account. */
  async checkAll(): Promise<void> {
    const accounts = await prisma.robloxAccount.findMany({
      where: { user: { isDisabled: false } },
      select: { id: true },
    });

    for (const account of accounts) {
      try {
        await this.checkAccount(account.id);
      } catch (err) {
        console.error(`[AuthHealth] Check failed for account ${account.id}:`, err);
      }
    }
  },

  /** Marks an account invalid and alerts the owner/admin, rate-limited. */
  recordInvalid(accountId: number, telegramId: string, label: string, reason: string): void {
    const state = stateFor(accountId);
    const firstTime = !state.invalid;
    state.invalid = true;
    state.status = 'invalid';
    state.lastError = reason;
    state.lastCheckAt = Date.now();

    if (firstTime) {
      console.error(
        `[AuthHealth] Account ${accountId} (${label}) cookie is INVALID — presence polling paused. ${reason} ` +
          `Reconnect with /setcookie.`,
      );
    }

    void this.alertIfDue(accountId, telegramId, label, reason);
  },

  /** Sends the owner/admin alert, at most once per `AUTH_ALERT_COOLDOWN_HOURS`. */
  async alertIfDue(accountId: number, telegramId: string, label: string, reason: string): Promise<void> {
    const state = stateFor(accountId);
    const cooldownMs = env.AUTH_ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;
    const now = Date.now();
    if (state.lastAlertAt !== 0 && now - state.lastAlertAt < cooldownMs) return;
    state.lastAlertAt = now;

    const escapeHtml = (text: string) =>
      text.replace(/[<>&]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m] as string));

    const message =
      `🔐 <b>Roblox account disconnected</b>\n\n` +
      `The stored <code>.ROBLOSECURITY</code> cookie for <b>${escapeHtml(label)}</b> is no longer valid.\n\n` +
      `${escapeHtml(reason)}\n\n` +
      `Presence tracking is paused until a valid cookie is saved — Roblox serves anonymous ` +
      `requests far more restrictively, so continuing would only produce rate-limit errors.\n\n` +
      `Fix: log out and back in to Roblox, then send <code>/setcookie &lt;fresh cookie&gt;</code>.`;

    const recipients = new Set<string>([telegramId, ...env.ADMIN_USER_IDS]);
    for (const recipient of recipients) {
      if (!recipient) continue;
      await notificationService.sendDirectMessage(recipient, message);
    }

    console.warn(
      `[AuthHealth] Alerted ${recipients.size} recipient(s) about account ${accountId}; ` +
        `next alert allowed in ${env.AUTH_ALERT_COOLDOWN_HOURS}h.`,
    );
  },
};