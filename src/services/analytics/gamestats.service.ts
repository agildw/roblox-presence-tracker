/**
 * GameStats queries
 *
 * Read-only aggregates over `GameSession` for the `/gamestats` command.
 *
 * Design constraints (see the Phase-A proposal):
 *  - **All window math is clipped in SQL**, not by "sessions that started in the
 *    window": a session overlapping a boundary contributes only its in-window
 *    part, via `GREATEST(start, winFrom)` / `LEAST(end, winTo)`.
 *  - **A single `now` parameter** flows through every query. There is no `NOW()`
 *    in any statement, so results are deterministic and testable.
 *  - **In-progress sessions** (`endTime IS NULL`) count up to `now`.
 *  - **Monitoring-gap guard (read-only):** the effective end of a session is
 *    capped at the subject's last successful poll (`Friend.lastSeenAt` /
 *    `TrackedUser.lastSeenAt`). A session cannot legitimately run past the last
 *    moment we observed the player, so downtime / skipped cycles / throttle
 *    pauses that delay the closing poll no longer inflate the duration.
 *  - **Hidden and legacy rows excluded:** only rows with a non-null `universeId`
 *    match, by construction (we filter `universeId = ?`).
 *  - **Scope** is always one `robloxAccountId` (the requester's) intersected with
 *    the current scope subject ids (friends ∪ tracked users).
 *
 * Every statement is built with `Prisma.sql` tagged templates, so dynamic values
 * bind as parameters and only `Prisma.sql`/`Prisma.join` fragments compose.
 */

import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type { Window } from '../../lib/window.js';

/** Raw seconds-per-window aggregate for one game (or one user in that game). */
export interface WindowTotals {
  allSeconds: number;
  todaySeconds: number;
  last7Seconds: number;
  last30Seconds: number;
  /** Number of distinct subjects with at least one matching session. */
  playerCount: number;
  /** Earliest session start in scope (for "tracked since"), or null. */
  firstSeen: Date | null;
}

/** One row in the "recent/top players" list. */
export interface PlayerRow {
  subjectId: bigint;
  /** Seconds played in this game (all time, capped). */
  totalSeconds: number;
  /** Last moment the player was seen in this game (capped effective end). */
  lastSeenAt: Date;
  /** True when this player has a currently-open session in this game. */
  stillPlaying: boolean;
  /** True when any single session for this player exceeds the sanity threshold. */
  hasLongSession: boolean;
}

/** One raw session row for the `user:` merged list. */
export interface RawUserSession {
  id: number;
  startTime: Date;
  /** Effective end (endTime, or the open-session cap). */
  endTime: Date;
  /** True when the row was still open at `now`. */
  open: boolean;
}

export interface ScopeContext {
  accountId: number;
  subjectIds: bigint[];
  now: Date;
}

/** A merged, display-ready session in the `user:` list. */
export interface MergedSession {
  startTime: Date;
  endTime: Date;
  seconds: number;
  open: boolean;
  /** How many raw rows were merged into this one (≥1). */
  parts: number;
}

/**
 * Merges adjacent raw rows of the same subject+universe into one logical
 * session. Server hops split one real play session into several rows whose
 * `endTime` and next `startTime` are at most a few seconds apart; anything within
 * `gapSeconds` is treated as the same session. Rows are expected oldest-first.
 *
 * Totals are unaffected by merging — this only shapes the session *list*.
 */
export function mergeAdjacentSessions(
  rows: Array<{ startTime: Date; endTime: Date; open: boolean }>,
  gapSeconds: number,
): MergedSession[] {
  const sorted = [...rows].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  const merged: MergedSession[] = [];

  for (const row of sorted) {
    const last = merged[merged.length - 1];
    const gap = last ? (row.startTime.getTime() - last.endTime.getTime()) / 1000 : Infinity;

    if (last && gap <= gapSeconds) {
      // Extend the existing session if this row ends later; keep the last start.
      if (row.endTime > last.endTime) last.endTime = row.endTime;
      last.seconds = Math.floor((last.endTime.getTime() - last.startTime.getTime()) / 1000);
      last.open = last.open || row.open;
      last.parts += 1;
    } else {
      merged.push({
        startTime: row.startTime,
        endTime: row.endTime,
        seconds: Math.max(0, Math.floor((row.endTime.getTime() - row.startTime.getTime()) / 1000)),
        open: row.open,
        parts: 1,
      });
    }
  }

  return merged;
}

/** Orders merged sessions for display: newest first, or longest first for `most`. */
export function orderMergedSessions(
  sessions: MergedSession[],
  orderBy: 'recent' | 'most',
): MergedSession[] {
  const sorted = [...sessions];
  if (orderBy === 'most') {
    sorted.sort((a, b) => b.seconds - a.seconds || b.startTime.getTime() - a.startTime.getTime());
  } else {
    sorted.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
  }
  return sorted;
}

export interface WindowSpec {
  today: Window;
  last7: Window;
  last30: Window;
  all: Window;
}

/**
 * Coerces a numeric aggregate result from a raw query into a JS `number`.
 *
 * MySQL and MariaDB disagree on the type the driver hands back for `SUM(...)`
 * over an integer column: MySQL 8 typically returns `BIGINT` (a JS `bigint`),
 * while MariaDB 10.4 returns `DECIMAL` (a Decimal object that stringifies
 * exactly). `COUNT(...)` is likewise a `bigint` or a Decimal. `Number()` handles
 * every one of these losslessly (the Decimal's `toString()` round-trips), so we
 * funnel all of them through here rather than assuming a single shape.
 */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number(String(value));
}

/**
 * Parses a datetime value from a raw query into a UTC `Date`.
 *
 * The MariaDB driver returns plain column reads (`startTime`, `endTime`) as
 * proper `Date` objects, but a value that passed through SQL functions
 * (`LEAST`, `TIMESTAMPDIFF`, …) comes back as a **string without a timezone
 * suffix** (e.g. `"2026-06-04 12:57:49.888"`). `new Date()` would interpret that
 * as *local* time, silently shifting it. The connection is pinned to UTC
 * (`timezone=Z`), so the correct interpretation is UTC — append the marker
 * explicitly when it is missing.
 */
export function parseDbDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  const hasZone = /[zZ]|[+-]\d\d:?\d\d$/.test(value);
  return new Date(hasZone ? value : `${value.replace(' ', 'T')}Z`);
}

/**
 * Effective end of an open session is capped at the subject's last *observed*
 * moment. Two sources, whichever is later:
 *   - `lastPolledAt` — the subject's `lastSeenAt` (every answered presence poll);
 *   - `lastClosedEnd` — the end of the subject's most recent *closed* session in
 *     the tracker (a hard floor even when the subject row is gone, e.g. after an
 *     unfriend: the rows survive but `lastSeenAt` no longer advances).
 *
 * IMPORTANT: `GREATEST`/`LEAST` are NULL-propagating in MySQL/MariaDB — passing a
 * single NULL operand makes the whole expression NULL. Since `lastClosedEnd` is
 * NULL for any subject with no closed session, the two inputs are each
 * COALESCEd to the epoch before `GREATEST`, so a missing source is simply
 * ignored rather than disabling the cap. The result is then capped at `now` and
 * floored at the session's own start.
 */
function effectiveEnd(now: Date): Prisma.Sql {
  const epoch = new Date(0);
  return Prisma.sql`COALESCE(
    gs.endTime,
    GREATEST(
      gs.startTime,
      LEAST(${now}, COALESCE(
        GREATEST(COALESCE(sub.lastPolledAt, ${epoch}), COALESCE(sub.lastClosedEnd, ${epoch})),
        ${epoch}
      ))
    )
  )`;
}

/**
 * Derived table `subjectId → (lastPolledAt, lastClosedEnd)` for one account.
 *
 * `lastPolledAt` comes from the subject rows (friends ∪ tracked users);
 * `lastClosedEnd` is the newest closed-session end for that subject, which
 * survives unfriends/untracks (those only delete the subject row, not the
 * sessions). The outer join is a LEFT JOIN so a subject with sessions but no
 * current row still gets its `lastClosedEnd`.
 */
function scopeSubjectJoin(accountId: number): Prisma.Sql {
  return Prisma.sql`LEFT JOIN (
    SELECT s.subjectId AS subjectId,
           MAX(s.lastPolledAt) AS lastPolledAt,
           MAX(s.lastClosedEnd) AS lastClosedEnd
    FROM (
      SELECT friendUserId AS subjectId, MAX(lastSeenAt) AS lastPolledAt, NULL AS lastClosedEnd
        FROM Friend WHERE robloxAccountId = ${accountId} GROUP BY friendUserId
      UNION ALL
      SELECT robloxUserId AS subjectId, MAX(lastSeenAt) AS lastPolledAt, NULL AS lastClosedEnd
        FROM TrackedUser WHERE robloxAccountId = ${accountId} GROUP BY robloxUserId
      UNION ALL
      SELECT subjectId AS subjectId, NULL AS lastPolledAt, MAX(endTime) AS lastClosedEnd
        FROM GameSession
        WHERE robloxAccountId = ${accountId} AND endTime IS NOT NULL
        GROUP BY subjectId
    ) s
    GROUP BY s.subjectId
  ) sub ON sub.subjectId = gs.subjectId`;
}

/** One clipped-window sum over the session rows. */
function windowSum(from: Date, to: Date, now: Date): Prisma.Sql {
  return Prisma.sql`COALESCE(SUM(GREATEST(0, TIMESTAMPDIFF(SECOND,
    GREATEST(gs.startTime, ${from}),
    LEAST(${effectiveEnd(now)}, ${to})))), 0)`;
}

export const gameStatsService = {
  /**
   * Summary windows for a universe, aggregated entirely in SQL.
   *
   * Each window sums `max(0, min(effEnd, winTo) - max(start, winFrom))` seconds,
   * so a session crossing a window edge contributes only its in-window part.
   */
  async getWindowTotals(
    scope: ScopeContext,
    universeId: bigint,
    windows: WindowSpec,
    subjectId?: bigint,
  ): Promise<WindowTotals> {
    if (scope.subjectIds.length === 0) {
      return {
        allSeconds: 0,
        todaySeconds: 0,
        last7Seconds: 0,
        last30Seconds: 0,
        playerCount: 0,
        firstSeen: null,
      };
    }

    const subjectFilter =
      subjectId === undefined ? Prisma.empty : Prisma.sql`AND gs.subjectId = ${subjectId}`;

    const rows = await prisma.$queryRaw<
      Array<{
        allSeconds: unknown;
        todaySeconds: unknown;
        last7Seconds: unknown;
        last30Seconds: unknown;
        playerCount: unknown;
        firstSeen: Date | string | null;
      }>
    >(Prisma.sql`
      SELECT
        ${windowSum(windows.all.from, windows.all.to, scope.now)} AS allSeconds,
        ${windowSum(windows.today.from, windows.today.to, scope.now)} AS todaySeconds,
        ${windowSum(windows.last7.from, windows.last7.to, scope.now)} AS last7Seconds,
        ${windowSum(windows.last30.from, windows.last30.to, scope.now)} AS last30Seconds,
        COUNT(DISTINCT gs.subjectId) AS playerCount,
        MIN(gs.startTime) AS firstSeen
      FROM GameSession gs
      ${scopeSubjectJoin(scope.accountId)}
      WHERE gs.universeId = ${universeId}
        AND gs.robloxAccountId = ${scope.accountId}
        AND gs.subjectId IN (${Prisma.join(scope.subjectIds)})
        ${subjectFilter}
    `);

    const row = rows[0];
    return {
      allSeconds: toNumber(row?.allSeconds),
      todaySeconds: toNumber(row?.todaySeconds),
      last7Seconds: toNumber(row?.last7Seconds),
      last30Seconds: toNumber(row?.last30Seconds),
      playerCount: toNumber(row?.playerCount),
      firstSeen: row?.firstSeen ? parseDbDate(row.firstSeen) : null,
    };
  },

  /**
   * Players in this universe, one row each, with total time and last-seen.
   *
   * `orderBy`: `'recent'` sorts by last-seen desc; `'most'` by total desc. Both
   * append a deterministic `subjectId` tie-breaker so pagination is stable.
   */
  async getPlayerPage(
    scope: ScopeContext,
    universeId: bigint,
    orderBy: 'recent' | 'most',
    limit: number,
    offset: number,
    maxSessionSeconds: number,
  ): Promise<{ players: PlayerRow[]; total: number }> {
    if (scope.subjectIds.length === 0) return { players: [], total: 0 };

    const totalRows = await prisma.$queryRaw<Array<{ total: unknown }>>(Prisma.sql`
      SELECT COUNT(DISTINCT gs.subjectId) AS total
      FROM GameSession gs
      WHERE gs.universeId = ${universeId}
        AND gs.robloxAccountId = ${scope.accountId}
        AND gs.subjectId IN (${Prisma.join(scope.subjectIds)})
    `);

    const order = orderBy === 'most' ? Prisma.sql`totalSeconds DESC` : Prisma.sql`lastSeenAt DESC`;

    const players = await prisma.$queryRaw<
      Array<{
        subjectId: bigint;
        totalSeconds: unknown;
        lastSeenAt: Date | string;
        stillPlaying: unknown;
        hasLongSession: unknown;
      }>
    >(Prisma.sql`
      SELECT
        gs.subjectId AS subjectId,
        COALESCE(SUM(GREATEST(0, TIMESTAMPDIFF(SECOND,
          gs.startTime, ${effectiveEnd(scope.now)}))), 0) AS totalSeconds,
        MAX(${effectiveEnd(scope.now)}) AS lastSeenAt,
        MAX(gs.endTime IS NULL) AS stillPlaying,
        MAX(TIMESTAMPDIFF(SECOND, gs.startTime, ${effectiveEnd(scope.now)}) > ${maxSessionSeconds}) AS hasLongSession
      FROM GameSession gs
      ${scopeSubjectJoin(scope.accountId)}
      WHERE gs.universeId = ${universeId}
        AND gs.robloxAccountId = ${scope.accountId}
        AND gs.subjectId IN (${Prisma.join(scope.subjectIds)})
      GROUP BY gs.subjectId
      ORDER BY ${order}, gs.subjectId ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return {
      players: players.map((p) => ({
        subjectId: p.subjectId,
        totalSeconds: toNumber(p.totalSeconds),
        lastSeenAt: parseDbDate(p.lastSeenAt),
        stillPlaying: toNumber(p.stillPlaying) !== 0,
        hasLongSession: toNumber(p.hasLongSession) !== 0,
      })),
      total: toNumber(totalRows[0]?.total),
    };
  },

  /**
   * Raw sessions for one subject in a universe, newest first, capped at `cap`.
   *
   * The caller merges adjacent rows (server hops) and paginates in TypeScript —
   * window functions are avoided for MariaDB-10.x compatibility. A `cap + 1`
   * fetch lets the caller detect truncation.
   */
  async getUserSessions(
    scope: ScopeContext,
    universeId: bigint,
    subjectId: bigint,
    cap: number,
  ): Promise<RawUserSession[]> {
    const rows = await prisma.$queryRaw<
      Array<{
        id: number;
        startTime: Date | string;
        endTime: Date | string;
        open: unknown;
      }>
    >(Prisma.sql`
      SELECT
        gs.id AS id,
        gs.startTime AS startTime,
        ${effectiveEnd(scope.now)} AS endTime,
        (gs.endTime IS NULL) AS open
      FROM GameSession gs
      ${scopeSubjectJoin(scope.accountId)}
      WHERE gs.universeId = ${universeId}
        AND gs.robloxAccountId = ${scope.accountId}
        AND gs.subjectId = ${subjectId}
      ORDER BY gs.startTime DESC, gs.id DESC
      LIMIT ${cap}
    `);

    return rows.map((r) => {
      const startTime = parseDbDate(r.startTime);
      const endTime = parseDbDate(r.endTime);
      // Never let a capped/mis-ordered end render before the start.
      return {
        id: r.id,
        startTime,
        endTime: endTime < startTime ? startTime : endTime,
        open: toNumber(r.open) !== 0,
      };
    });
  },

  /**
   * Number of in-scope rows in this universe whose sessions predate usable
   * experience ids (`universeId IS NULL` with a real place) — the "N older
   * sessions without experience id excluded" footer count.
   */
  async countLegacyRows(scope: ScopeContext, universeId: bigint, placeIds: bigint[]): Promise<number> {
    if (scope.subjectIds.length === 0 || placeIds.length === 0) return 0;

    const rows = await prisma.$queryRaw<Array<{ n: unknown }>>(Prisma.sql`
      SELECT COUNT(*) AS n
      FROM GameSession gs
      WHERE gs.robloxAccountId = ${scope.accountId}
        AND gs.universeId IS NULL
        AND gs.placeId IN (${Prisma.join(placeIds)})
        AND gs.subjectId IN (${Prisma.join(scope.subjectIds)})
    `);
    return toNumber(rows[0]?.n);
  },
};
