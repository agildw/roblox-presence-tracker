/**
 * GameResolver
 *
 * Turns a Roblox **place id** (the number in a /games/<id>/… URL) into the
 * **universe id** (the experience id) plus a display name, so that
 * `/gamestats` can group every sub-place of one experience together.
 *
 * Both Roblox calls are public (no cookie), and both are cached in-process:
 *   - positive results (a resolved universe + name) for `GAMESTATS_RESOLVE_TTL_MS`
 *     (default 24 h);
 *   - negative results (place exists but has no universe — `universeId: null`,
 *     which Roblox returns with HTTP 200) for `GAMESTATS_RESOLVE_NEGATIVE_TTL_MS`
 *     (default 5 min).
 *
 * The cache is intentionally process-local (no table): a restart simply re-costs
 * one lookup per distinct game, which is negligible. Callback handlers never
 * call this — they read the name from the cache or fall back to the stored
 * `GameSession.gameName` (see the command handler).
 */

import { createPublicRobloxClient, robloxGet } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import type {
  RobloxGamesResponse,
  RobloxPlaceUniverseResponse,
} from './roblox.types.js';

const UNIVERSE_BASE = 'https://apis.roblox.com';
const GAMES_BASE = 'https://games.roblox.com';

/** A resolved place → universe mapping, or an explicit negative result. */
export type ResolveResult =
  | { status: 'ok'; placeId: bigint; universeId: bigint; rootPlaceId: bigint | null; name: string | null }
  | { status: 'not_found'; placeId: bigint }
  | { status: 'error'; placeId: bigint; message: string };

interface CacheEntry {
  expiresAt: number;
  value: ResolveResult;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(placeId: bigint): string {
  return placeId.toString();
}

function readCache(placeId: bigint, nowMs: number): ResolveResult | undefined {
  const entry = cache.get(cacheKey(placeId));
  if (!entry) return undefined;
  if (entry.expiresAt <= nowMs) {
    cache.delete(cacheKey(placeId));
    return undefined;
  }
  return entry.value;
}

function writeCache(placeId: bigint, value: ResolveResult, nowMs: number): void {
  const ttl =
    value.status === 'ok' ? env.GAMESTATS_RESOLVE_TTL_MS : env.GAMESTATS_RESOLVE_NEGATIVE_TTL_MS;
  cache.set(cacheKey(placeId), { expiresAt: nowMs + ttl, value });
  // Bound the cache defensively; the number of distinct tracked games is tiny,
  // but a long-lived process should never grow this without limit.
  if (cache.size > 5_000) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Clears the resolver cache. Test seam — never called in production paths. */
export function clearResolveCache(): void {
  cache.clear();
}

export const gameResolver = {
  /**
   * Resolves a place id to its universe id and game name.
   *
   * Never throws: a network/limiter failure returns `{ status: 'error' }` so the
   * command can degrade gracefully (and never leak the failure as a crash).
   * `nowMs` is injectable for deterministic TTL tests.
   */
  async resolve(placeId: bigint, nowMs: number = Date.now()): Promise<ResolveResult> {
    const cached = readCache(placeId, nowMs);
    if (cached) return cached;

    const client = createPublicRobloxClient();

    let universeId: bigint;
    try {
      const res = await robloxGet<RobloxPlaceUniverseResponse>(
        client,
        `${UNIVERSE_BASE}/universes/v1/places/${placeId.toString()}/universe`,
        { label: 'resolvePlaceUniverse', priority: 'interactive', retryOn429: true },
      );

      if (res.universeId === null || res.universeId === undefined) {
        const value: ResolveResult = { status: 'not_found', placeId };
        writeCache(placeId, value, nowMs);
        return value;
      }
      universeId = BigInt(res.universeId);
    } catch (err) {
      // Do not cache errors: a transient failure should retry on the next call.
      return {
        status: 'error',
        placeId,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    let name: string | null = null;
    let rootPlaceId: bigint | null = null;
    try {
      const games = await robloxGet<RobloxGamesResponse>(
        client,
        `${GAMES_BASE}/v1/games?universeIds=${universeId.toString()}`,
        { label: 'getGameName', priority: 'interactive', retryOn429: true },
      );
      const detail = games.data?.[0];
      if (detail) {
        name = detail.name || null;
        rootPlaceId = detail.rootPlaceId ? BigInt(detail.rootPlaceId) : null;
      }
    } catch (err) {
      // The universe is known even if the name lookup failed; cache the id with a
      // null name so grouping works and the name is retried after the TTL.
      console.warn(
        `[GameResolver] Name lookup failed for universe ${universeId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const value: ResolveResult = { status: 'ok', placeId, universeId, rootPlaceId, name };
    writeCache(placeId, value, nowMs);
    return value;
  },

  /**
   * Returns the cached display name for a place, if a successful resolve is
   * still cached. Callback paths use this so they never trigger a Roblox call.
   */
  cachedNameForPlace(placeId: bigint, nowMs: number = Date.now()): string | null {
    const cached = readCache(placeId, nowMs);
    if (cached && cached.status === 'ok') return cached.name;
    return null;
  },
};
