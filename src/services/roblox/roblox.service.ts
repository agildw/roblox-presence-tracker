/**
 * RobloxService
 *
 * All interactions with the Roblox API go through this service.
 * Rules:
 *  - Always inject the .ROBLOSECURITY cookie per request
 *  - Batch user lookups within the endpoint limits
 *  - Every request goes through the shared limiter (`lib/ratelimit.ts`)
 *  - Return typed responses — never return raw axios data
 *
 * Batch behaviour: a worker cycle only issues up to
 * `ROBLOX_MAX_BATCHES_PER_CYCLE` batches (callers order batches by priority),
 * and stops as soon as Roblox throttles — the cycle's worker then reschedules
 * after the cooldown instead of retrying inline and stacking requests.
 */

import { chunk, createRobloxClient, robloxGet, robloxPost } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import { RateLimitRejection, robloxRateLimiter, type RequestPriority } from '../../lib/ratelimit.js';
import type {
  PresenceMap,
  RobloxAuthUser,
  RobloxErrorResponse,
  RobloxFriend,
  RobloxFriendsResponse,
  RobloxPresenceResponse,
  RobloxUser,
  RobloxUsersResponse,
  RobloxBadgesResponse,
  RobloxBadgeAwardedDatesResponse,
} from './roblox.types.js';
import type { AxiosError } from 'axios';

// ── Base URLs ─────────────────────────────────────────────────────────────────

const USERS_BASE    = 'https://users.roblox.com';
const FRIENDS_BASE  = 'https://friends.roblox.com';
const PRESENCE_BASE = 'https://presence.roblox.com';
const BADGES_BASE   = 'https://badges.roblox.com';

// ── Custom error ──────────────────────────────────────────────────────────────

export class RobloxApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RobloxApiError';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractRobloxError(err: unknown): string {
  const axiosErr = err as AxiosError<RobloxErrorResponse>;
  const errors = axiosErr.response?.data?.errors;
  if (errors && errors.length > 0) {
    return errors.map((e) => e.message).join('; ');
  }
  return String((err as Error).message ?? 'Unknown error');
}

/** True when the failure is Roblox throttling us (HTTP 429 or a limiter cooldown). */
function isThrottled(err: unknown): boolean {
  if (err instanceof RateLimitRejection) return true;
  return (err as AxiosError).response?.status === 429;
}

/**
 * Outcome of a batched presence fetch.
 *
 * `presence` holds **only** the users Roblox answered for; `unansweredIds` is
 * the difference between that and what was requested.
 */
export interface PresenceFetchResult {
  presence: PresenceMap;
  /** Batches the loop actually started. */
  batchesAttempted: number;
  /** Batches the request asked for (before the per-cycle cap). */
  batchesTotal: number;
  /** Batches that returned a response. */
  batchesSucceeded: number;
  /** Batches never answered (throttled or capped away). */
  unansweredBatches: number;
  /** Requested ids with no presence record in the response. */
  unansweredIds: number;
  /** True when the loop stopped early because Roblox throttled us. */
  throttled: boolean;
}

/** Caps the number of batches a single cycle may issue; logs when it truncates. */
function batchLimit(totalBatches: number, label: string, priority: RequestPriority): number {
  if (priority !== 'cycle') return totalBatches;

  const cap = env.ROBLOX_MAX_BATCHES_PER_CYCLE;
  if (totalBatches <= cap) return totalBatches;

  console.warn(
    `[RobloxService] ${label}: ${totalBatches} batches exceed the per-cycle cap ` +
      `(ROBLOX_MAX_BATCHES_PER_CYCLE=${cap}); issuing the first ${cap}, the rest follow next cycle.`,
  );
  return cap;
}

// ── Service ───────────────────────────────────────────────────────────────────

export const robloxService = {
  // ── validateCookie ──────────────────────────────────────────────────────────
  /**
   * Validates a .ROBLOSECURITY cookie by calling the authenticated user endpoint.
   * Returns the Roblox user info on success, throws RobloxApiError on failure.
   */
  async validateCookie(cookie: string): Promise<RobloxAuthUser> {
    const client = createRobloxClient(cookie);

    try {
      return await robloxGet<RobloxAuthUser>(
        client,
        `${USERS_BASE}/v1/users/authenticated`,
        { label: 'validateCookie', priority: 'interactive', retryOn429: true },
      );
    } catch (err) {
      const status = (err as AxiosError).response?.status;

      if (status === 401 || status === 403) {
        throw new RobloxApiError(status, 'Invalid or expired .ROBLOSECURITY cookie.');
      }

      throw new RobloxApiError(
        status ?? 0,
        `Failed to validate cookie: ${extractRobloxError(err)}`,
      );
    }
  },

  // ── getFriends ──────────────────────────────────────────────────────────────
  /**
   * Fetches the full friends list for a given Roblox user ID.
   * Returns an array of RobloxFriend objects.
   */
  async getFriends(cookie: string, robloxUserId: bigint): Promise<RobloxFriend[]> {
    const client = createRobloxClient(cookie);

    try {
      const res = await robloxGet<RobloxFriendsResponse>(
        client,
        `${FRIENDS_BASE}/v1/users/${robloxUserId}/friends`,
        { label: 'getFriends' },
      );
      return res.data;
    } catch (err) {
      throw new RobloxApiError(
        (err as AxiosError).response?.status ?? 0,
        `Failed to fetch friends: ${extractRobloxError(err)}`,
      );
    }
  },

  // ── getUsersBatch ───────────────────────────────────────────────────────────
  /**
   * Fetches user info (username, displayName) for a list of user IDs,
   * batching within Roblox's limit. On throttling it stops early and returns
   * whatever it managed to fetch — partial results are acceptable.
   */
  async getUsersBatch(
    cookie: string,
    userIds: number[],
    priority: RequestPriority = 'cycle',
  ): Promise<RobloxUser[]> {
    if (userIds.length === 0) return [];

    const client = createRobloxClient(cookie);
    const batches = chunk(userIds, env.USER_BATCH_SIZE);
    const limit = batchLimit(batches.length, 'getUsersBatch', priority);
    const results: RobloxUser[] = [];

    for (let i = 0; i < limit; i++) {
      const batch = batches[i];
      if (!batch) break;

      try {
        const res = await robloxPost<RobloxUsersResponse>(
          client,
          `${USERS_BASE}/v1/users`,
          { userIds: batch, excludeBannedUsers: false },
          { label: `getUsersBatch ${i + 1}/${limit}`, priority },
        );
        results.push(...res.data);
      } catch (err) {
        if (isThrottled(err)) {
          console.warn(
            `[RobloxService] getUsersBatch stopped at batch ${i + 1}/${limit}: ` +
              `${extractRobloxError(err)}.${robloxRateLimiter.describe()}`,
          );
          break;
        }
        // Log but don't throw — partial results are acceptable
        console.error(`[RobloxService] getUsersBatch batch failed: ${extractRobloxError(err)}`);
      }
    }

    return results;
  },

  // ── getUserByUsername ────────────────────────────────────────────────────────
  /**
   * Resolves a single username to a Roblox User ID and display name.
   */
  async getUserByUsername(cookie: string, username: string): Promise<RobloxUser | null> {
    const client = createRobloxClient(cookie);
    try {
      const res = await robloxPost<RobloxUsersResponse>(
        client,
        `${USERS_BASE}/v1/usernames/users`,
        { usernames: [username], excludeBannedUsers: false },
        { label: 'getUserByUsername', priority: 'interactive', retryOn429: true },
      );
      return res.data?.[0] ?? null;
    } catch (err) {
      console.error(
        `[RobloxService] getUserByUsername failed for ${username}: ${extractRobloxError(err)}`,
      );
      return null;
    }
  },

  // ── getPresence ─────────────────────────────────────────────────────────────
  /**
   * Fetches presence data for a list of user IDs, in the given order.
   *
   * Roblox rejects more than 50 IDs per request (HTTP 400), so batches are
   * capped at `PRESENCE_BATCH_SIZE`. Callers pass the most important IDs first
   * (tracked users before friends) so that when the per-cycle batch cap kicks
   * in, the high-priority subjects are the ones that stay fresh.
   *
   * **Partial-data invariant:** the returned map contains *only* users Roblox
   * actually answered for. A caller must never iterate the requested ID set
   * against this map — an unanswered user has no entry, and treating absence as
   * "offline" would emit false notifications. See `pollAccountPresence`.
   *
   * Returns the presence map plus per-batch accounting for logging.
   */
  async getPresence(
    cookie: string,
    userIds: number[],
    priority: RequestPriority = 'cycle',
  ): Promise<PresenceFetchResult> {
    if (userIds.length === 0) {
      return {
        presence: new Map(),
        batchesAttempted: 0,
        batchesTotal: 0,
        batchesSucceeded: 0,
        unansweredBatches: 0,
        unansweredIds: 0,
        throttled: false,
      };
    }

    const client = createRobloxClient(cookie);
    const batches = chunk(userIds, env.PRESENCE_BATCH_SIZE);
    const limit = batchLimit(batches.length, 'getPresence', priority);
    const presenceMap: PresenceMap = new Map();
    let attempted = 0;
    let succeeded = 0;
    let throttled = false;

    for (let i = 0; i < limit; i++) {
      const batch = batches[i];
      if (!batch) break;
      attempted++;

      try {
        const res = await robloxPost<RobloxPresenceResponse>(
          client,
          `${PRESENCE_BASE}/v1/presence/users`,
          { userIds: batch },
          { label: `getPresence ${i + 1}/${limit}`, priority },
        );

        for (const presence of res.userPresences) {
          presenceMap.set(presence.userId, presence);
        }
        succeeded++;
      } catch (err) {
        if (isThrottled(err)) {
          throttled = true;
          console.warn(
            `[RobloxService] getPresence stopped at batch ${i + 1}/${limit}: ` +
              `${extractRobloxError(err)}.${robloxRateLimiter.describe()}`,
          );
          break;
        }
        // Log but continue — avoid killing the entire poll cycle on one bad batch
        console.error(
          `[RobloxService] getPresence batch failed: ${extractRobloxError(err)}`,
        );
      }
    }

    const answeredIds = presenceMap.size;
    return {
      presence: presenceMap,
      batchesAttempted: attempted,
      batchesTotal: batches.length,
      batchesSucceeded: succeeded,
      unansweredBatches: Math.max(0, batches.length - succeeded),
      unansweredIds: Math.max(0, userIds.length - answeredIds),
      throttled,
    };
  },

  // ── getBadges ───────────────────────────────────────────────────────────────
  /**
   * Fetches the recent badges for a user.
   */
  async getBadges(cookie: string, userId: number | bigint, cursor?: string): Promise<RobloxBadgesResponse | null> {
    const client = createRobloxClient(cookie);
    let url = `${BADGES_BASE}/v1/users/${userId}/badges?limit=10&sortOrder=Desc`;
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }

    try {
      return await robloxGet<RobloxBadgesResponse>(client, url, {
        label: 'getBadges',
        priority: 'interactive',
        retryOn429: true,
      });
    } catch (err) {
      console.error(`[RobloxService] getBadges failed for ${userId}: ${extractRobloxError(err)}`);
      return null;
    }
  },

  // ── getBadgeAwardedDates ────────────────────────────────────────────────────
  /**
   * Fetches the awarded dates for specific badges for a user.
   */
  async getBadgeAwardedDates(cookie: string, userId: number | bigint, badgeIds: number[]): Promise<RobloxBadgeAwardedDatesResponse | null> {
    if (badgeIds.length === 0) return { data: [] };

    const client = createRobloxClient(cookie);
    const url = `${BADGES_BASE}/v1/users/${userId}/badges/awarded-dates?badgeIds=${badgeIds.join(',')}`;

    try {
      return await robloxGet<RobloxBadgeAwardedDatesResponse>(client, url, {
        label: 'getBadgeAwardedDates',
        priority: 'interactive',
        retryOn429: true,
      });
    } catch (err) {
      console.error(`[RobloxService] getBadgeAwardedDates failed for ${userId}: ${extractRobloxError(err)}`);
      return null;
    }
  },
};