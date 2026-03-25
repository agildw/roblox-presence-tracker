/**
 * RobloxService
 *
 * All interactions with the Roblox API go through this service.
 * Rules:
 *  - Always inject the .ROBLOSECURITY cookie per request
 *  - Batch user lookups: max 100 user IDs per request
 *  - Retry on rate limits (429) with exponential back-off
 *  - Return typed responses — never return raw axios data
 */

import { chunk, createRobloxClient, robloxGet, robloxPost } from '../../lib/http.js';
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

const BATCH_SIZE = 100; // Roblox API hard limit per request

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
   * Fetches user info (username, displayName) for up to N user IDs.
   * Automatically batches into chunks of 100 and merges results.
   * IDs not found in Roblox's response are silently skipped.
   */
  async getUsersBatch(cookie: string, userIds: number[]): Promise<RobloxUser[]> {
    if (userIds.length === 0) return [];

    const client = createRobloxClient(cookie);
    const batches = chunk(userIds, BATCH_SIZE);
    const results: RobloxUser[] = [];

    for (const batch of batches) {
      try {
        const res = await robloxPost<RobloxUsersResponse>(
          client,
          `${USERS_BASE}/v1/users`,
          {
            userIds: batch,
            excludeBannedUsers: false,
          },
        );
        results.push(...res.data);
      } catch (err) {
        // Log but don't throw — partial results are acceptable
        console.error(
          `[RobloxService] getUsersBatch batch failed: ${extractRobloxError(err)}`,
        );
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
        {
          usernames: [username],
          excludeBannedUsers: false,
        },
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
   * Fetches presence data for up to N user IDs.
   * Automatically batches into chunks of 100.
   * Returns a Map<userId, RobloxUserPresence> for O(1) lookups.
   */
  async getPresence(cookie: string, userIds: number[]): Promise<PresenceMap> {
    if (userIds.length === 0) return new Map();

    const client = createRobloxClient(cookie);
    const batches = chunk(userIds, BATCH_SIZE);
    const presenceMap: PresenceMap = new Map();

    for (const batch of batches) {
      try {
        const res = await robloxPost<RobloxPresenceResponse>(
          client,
          `${PRESENCE_BASE}/v1/presence/users`,
          { userIds: batch },
        );

        for (const presence of res.userPresences) {
          presenceMap.set(presence.userId, presence);
        }
      } catch (err) {
        // Log but continue — avoid killing the entire poll cycle on one bad batch
        console.error(
          `[RobloxService] getPresence batch failed: ${extractRobloxError(err)}`,
        );
      }
    }

    return presenceMap;
  },

  // ── getBadges ───────────────────────────────────────────────────────────────
  /**
   * Fetches the recent badges for a user.
   */
  async getBadges(cookie: string, userId: number | bigint, cursor?: string): Promise<RobloxBadgesResponse | null> {
    const client = createRobloxClient(cookie);
    let url = `https://badges.roblox.com/v1/users/${userId}/badges?limit=25&sortOrder=Desc`;
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }

    try {
      return await robloxGet<RobloxBadgesResponse>(client, url);
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
    const url = `https://badges.roblox.com/v1/users/${userId}/badges/awarded-dates?badgeIds=${badgeIds.join(',')}`;

    try {
      return await robloxGet<RobloxBadgeAwardedDatesResponse>(client, url);
    } catch (err) {
      console.error(`[RobloxService] getBadgeAwardedDates failed for ${userId}: ${extractRobloxError(err)}`);
      return null;
    }
  },
};
