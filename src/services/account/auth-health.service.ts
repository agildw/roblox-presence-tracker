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
 *  - whenever a presence cycle is throttled (as a hint; a 429 never proves it)
 *
 * **Classification.** A cookie is marked invalid only when:
 *  - HTTP **401** with Roblox's "not authenticated" body — the unambiguous case; or
 *  - **two consecutive** failing checks of any kind (counts persisted in the DB).
 * A single 403 is deliberately *not* enough: 403 also comes from edge blocks and
 * challenge pages, and pausing polling on one would be a false positive. A 429,
 * cooldown, or network error alone never marks invalid.
 *
 * While an account is known invalid, presence cycles skip it entirely rather than
 * processing anonymous results. A successful `/setcookie` clears the state, and
 * so does any later 200 check (self-healing — see `checkAccount`).
 *
 * Safety: the cookie is only ever passed to the Roblox client. It is never
 * logged, and no error message here includes it. `lastError` stores only the
 * endpoint's own error text.
 */

import { env } from '../../lib/env.js';
import { prisma } from '../../lib/prisma.js';
import { accountService } from './account.service.js';
import { robloxService, RobloxApiError } from '../roblox/roblox.service.js';
import { notificationService } from '../notification/notification.service.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuthStatus = 'valid' | 'invalid' | 'unknown';

interface AuthState {
  /** True once the cookie has been proven dead and not yet cleared. */
  invalid: boolean;
  /** Last validation outcome, for diagnostics. */
  status: AuthStatus;
  /** When the last validation ran. */
  lastCheckAt: number;
  /** When the last alert was sent (mirrors the persisted value). */
  lastAlertAt: number;
  /** Safe, cookie-free description of the last failure. */
  lastError: string | null;
}

/** In-memory mirror of per-account auth state, hydrated from the DB lazily. */
const states = new Map<number, AuthState>();

/**
 * Roblox's error text for a genuinely dead cookie. Exact-match against this is
 * what makes a 401 conclusive; anything else needs the consecutive-failure rule.
 * Measured: `9002` "User is not authenticated" (invalid cookie) vs
 * `9002` "Authentication token is missing" (no cookie at all).
 */
const NOT_AUTHENTICATED = 'user is not authenticated';

function stateFor(accountId: number): AuthState {
  let state = states.get(accountId);
  if (!state) {
    state = { invalid: false, status: 'unknown', lastCheckAt: 0, lastAlertAt: 0, lastError: null };
    states.set(accountId, state);
  }
  return state;
}

// ── Persistence helpers ───────────────────────────────────────────────────────

/** Loads persisted failure counts + last alert into the in-memory mirror. */
async function hydrate(accountId: number): Promise<{ consecutiveFailures: number; lastAlertAt: number }> {
  const row = await prisma.robloxAccount.findUnique({
    where: { id: accountId },
    select: { authFailureCount: true, authLastAlertAt: true },
  });

  const state = stateFor(accountId);
  state.lastAlertAt = row?.authLastAlertAt ? row.authLastAlertAt.getTime() : 0;
  return {
    consecutiveFailures: row?.authFailureCount ?? 0,
    lastAlertAt: state.lastAlertAt,
  };
}

/** Persists failure count and (optionally) the alert time. Never throws. */
async function persist(accountId: number, failures: number, lastAlertAt: Date | null): Promise<void> {
  try {
    await prisma.robloxAccount.update({
      where: { id: accountId },
      data: {
        authFailureCount: failures,
        ...(lastAlertAt ? { authLastAlertAt: lastAlertAt } : {}),
      },
    });
  } catch (err) {
    console.error(`[AuthHealth] Failed to persist auth state for account ${accountId}:`, err);
  }
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
    void persist(accountId, 0, null);
  },

  /**
   * Validates the account's stored cookie, updates state, and alerts once if it
   * has become invalid. Returns the outcome; never throws for an invalid cookie
   * (that is a normal, handled result).
   *
   * Self-healing: any successful check clears the invalid flag and resets the
   * failure count, so a cookie fixed directly in the DB (or a false positive)
   * resumes polling on the next check without `/setcookie`.
   */
  async checkAccount(accountId: number): Promise<AuthStatus> {
    const account = await prisma.robloxAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        username: true,
        displayName: true,
        user: { select: { telegramId: true } },
      },
    });
    if (!account) return 'unknown';

    const label = account.displayName || account.username || String(accountId);
    const state = stateFor(accountId);
    state.lastCheckAt = Date.now();

    const { consecutiveFailures } = await hydrate(accountId);

    const cookie = await accountService.getDecryptedCookieByAccountId(accountId);
    if (!cookie) {
      await this.registerFailure(accountId, account.user.telegramId, label, 'No stored cookie.', false);
      return 'invalid';
    }

    try {
      await robloxService.validateCookie(cookie);

      // ── Valid: clear everything, including a persisted failure count ───────
      const wasInvalid = state.invalid;
      state.invalid = false;
      state.status = 'valid';
      state.lastError = null;
      if (consecutiveFailures > 0 || wasInvalid) {
        await persist(accountId, 0, null);
      }
      if (wasInvalid) {
        console.log(`[AuthHealth] Account ${accountId}: cookie is valid again; resuming presence polling.`);
      }
      return 'valid';
    } catch (err) {
      const code = err instanceof RobloxApiError ? err.code : 0;
      const body = err instanceof RobloxApiError ? (err.bodyMessage ?? '') : '';
      const conclusive = code === 401 && body.toLowerCase().includes(NOT_AUTHENTICATED);

      if (conclusive) {
        await this.registerFailure(
          accountId,
          account.user.telegramId,
          label,
          `Roblox rejected the cookie (HTTP 401: ${body || 'not authenticated'}).`,
          true,
        );
        return 'invalid';
      }

      if (code === 401 || code === 403) {
        // Our own 401/403 that is not the known "not authenticated" body, or a
        // 403 (edge block / challenge) — plausible auth failure, but not proof.
        await this.registerFailure(
          accountId,
          account.user.telegramId,
          label,
          `Roblox returned HTTP ${code}${body ? `: ${body}` : ''}.`,
          false,
        );
        return state.invalid ? 'invalid' : 'unknown';
      }

      // 429, cooldown, or network: never counts toward the invalid decision.
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

  /**
   * Records one failed check. `conclusive` (401 + "not authenticated") trips the
   * invalid flag immediately; otherwise two consecutive failures are required.
   */
  async registerFailure(
    accountId: number,
    telegramId: string,
    label: string,
    reason: string,
    conclusive: boolean,
  ): Promise<void> {
    const state = stateFor(accountId);
    const { consecutiveFailures } = await hydrate(accountId);
    const failures = consecutiveFailures + 1;
    const shouldTrip = conclusive || failures >= 2;

    await persist(accountId, failures, null);

    state.lastError = reason;
    state.lastCheckAt = Date.now();

    if (!shouldTrip) {
      state.status = 'unknown';
      console.warn(
        `[AuthHealth] Account ${accountId}: check failed (${reason}) — ` +
          `${failures}/2 consecutive; not pausing yet.`,
      );
      return;
    }

    const firstTime = !state.invalid;
    state.invalid = true;
    state.status = 'invalid';

    if (firstTime) {
      console.error(
        `[AuthHealth] Account ${accountId} (${label}) cookie is INVALID — presence polling paused. ` +
          `${reason} Reconnect with /setcookie.`,
      );
    }

    // Awaited (not fire-and-forget) so the alert is delivered before the check
    // resolves: the caller can then rely on the owner having been notified, and
    // tests are not subject to a race. Send failures are swallowed inside
    // `sendDirectMessage`, so this cannot fail the check.
    await this.alertIfDue(accountId, telegramId, label, reason).catch((err) => {
      console.error(`[AuthHealth] Failed to send auth alert for account ${accountId}:`, err);
    });
  },

  /** Sends the owner/admin alert, at most once per `AUTH_ALERT_COOLDOWN_HOURS`. */
  async alertIfDue(accountId: number, telegramId: string, label: string, reason: string): Promise<void> {
    const state = stateFor(accountId);
    const cooldownMs = env.AUTH_ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;
    const now = Date.now();

    // The persisted timestamp is authoritative, so a restart/crash loop while the
    // cookie is invalid cannot re-alert every time.
    const { consecutiveFailures, lastAlertAt } = await hydrate(accountId);
    if (lastAlertAt !== 0 && now - lastAlertAt < cooldownMs) return;

    state.lastAlertAt = now;
    await persist(accountId, consecutiveFailures, new Date(now));

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