// ─────────────────────────────────────────────────────────────────────────────
// Roblox API — TypeScript Interfaces
// All shapes match the real Roblox API v1 responses.
// ─────────────────────────────────────────────────────────────────────────────

// ── Auth ─────────────────────────────────────────────────────────────────────

/** Response from GET /v1/users/authenticated */
export interface RobloxAuthUser {
  id: number;
  name: string;       // username
  displayName: string;
}

// ── Friends ──────────────────────────────────────────────────────────────────

export interface RobloxFriend {
  id: number;
  name: string;       // username
  displayName: string;
  isOnline?: boolean;
}

/** Response from GET /v1/users/{userId}/friends */
export interface RobloxFriendsResponse {
  data: RobloxFriend[];
}

// ── Batch user lookup ─────────────────────────────────────────────────────────

/** Single user in the batch response */
export interface RobloxUser {
  id: number;
  name: string;       // username
  displayName: string;
  requestedUsername?: string;
  hasVerifiedBadge?: boolean;
}

/** Response from POST /v1/users */
export interface RobloxUsersResponse {
  data: RobloxUser[];
}

// ── Presence ─────────────────────────────────────────────────────────────────

/**
 * Presence type values from the Roblox API:
 *  0 = Offline
 *  1 = Online (website)
 *  2 = InGame
 *  3 = InStudio
 */
export type RobloxPresenceType = 0 | 1 | 2 | 3;

export interface RobloxUserPresence {
  userPresenceType: RobloxPresenceType;
  lastLocation: string;        // e.g. "Adopt Me!" or "Website"
  placeId: number | null;
  rootPlaceId: number | null;
  gameId: string | null;       // game session UUID
  universeId: number | null;
  userId: number;
  lastOnline: string;          // ISO 8601 datetime string
}

/** Response from POST /v1/presence/users */
export interface RobloxPresenceResponse {
  userPresences: RobloxUserPresence[];
}

// ── Error ─────────────────────────────────────────────────────────────────────

export interface RobloxApiError {
  code: number;
  message: string;
  userFacingMessage?: string;
}

export interface RobloxErrorResponse {
  errors: RobloxApiError[];
}

// ── Service return types ──────────────────────────────────────────────────────

export type PresenceMap = Map<number, RobloxUserPresence>;

// ── Badges ───────────────────────────────────────────────────────────────────

export interface RobloxBadge {
  id: number;
  name: string;
  description: string;
  iconImageId?: number;
  displayIconImageId?: number;
}

export interface RobloxBadgesResponse {
  previousPageCursor: string | null;
  nextPageCursor: string | null;
  data: RobloxBadge[];
}

export interface RobloxBadgeAwardedDate {
  badgeId: number;
  awardedDate: string;
}

export interface RobloxBadgeAwardedDatesResponse {
  data: RobloxBadgeAwardedDate[];
}
