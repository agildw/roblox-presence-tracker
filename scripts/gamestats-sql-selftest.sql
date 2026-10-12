-- ============================================================================
-- /gamestats SQL self-test — runnable with the `mysql` client against production
-- ============================================================================
--
-- SAFETY: this script creates ONLY TEMPORARY tables. In MySQL/MariaDB a
-- TEMPORARY table with the same name as a base table SHADOWS the base table for
-- the duration of the session, so the query texts below (copied verbatim from
-- src/services/analytics/gamestats.service.ts) execute against the fixtures and
-- CANNOT read or write the real `GameSession` / `Friend` / `TrackedUser` rows.
--
--   * No INSERT/UPDATE/DELETE ever targets a non-temporary table.
--   * Temporary tables are dropped automatically at session end.
--   * Nothing is persisted.
--
-- Verify the shadowing yourself (run the whole script, then):
--     SELECT COUNT(*) FROM GameSession;   -- inside this same session: 4 (fixtures)
-- and open a SECOND mysql session at the same time:
--     SELECT COUNT(*) FROM GameSession;   -- unaffected real row count
--
-- Run:
--   mysql --table -h HOST -u USER -p DB < scripts/gamestats-sql-selftest.sql
--
-- The script prints PASS/FAIL rows and a final summary, and exits non-zero on
-- failure via the SIGNAL at the end.

SET SESSION sql_mode = CONCAT(@@sql_mode, ',ONLY_FULL_GROUP_BY');

-- ── Fixtures (TEMPORARY tables shadowing the real ones) ──────────────────────

DROP TEMPORARY TABLE IF EXISTS GameSession;
DROP TEMPORARY TABLE IF EXISTS Friend;
DROP TEMPORARY TABLE IF EXISTS TrackedUser;

CREATE TEMPORARY TABLE Friend (
  id INT PRIMARY KEY,
  robloxAccountId INT,
  friendUserId BIGINT,
  username VARCHAR(191),
  displayName VARCHAR(191),
  lastSeenAt DATETIME(3)
);

CREATE TEMPORARY TABLE TrackedUser (
  id INT PRIMARY KEY,
  robloxAccountId INT,
  robloxUserId BIGINT,
  username VARCHAR(191),
  displayName VARCHAR(191),
  lastSeenAt DATETIME(3)
);

-- Mirrors the real GameSession columns used by the gamestats queries.
CREATE TEMPORARY TABLE GameSession (
  id INT PRIMARY KEY,
  robloxAccountId INT,
  subjectId BIGINT,
  subjectType VARCHAR(16),
  placeId BIGINT,
  universeId BIGINT NULL,
  serverId VARCHAR(64) NULL,
  gameName VARCHAR(191) NULL,
  startTime DATETIME(3),
  endTime DATETIME(3) NULL,
  duration INT NULL
);

-- One account, two scope subjects. SUB_A's last poll is NOW-10min; SUB_B has none.
SET @acct := 990001;
SET @uni  := 990000000001;
SET @uni2 := 990000000002;
SET @subA := 990000000000001;
SET @subB := 990000000000002;
SET @now  := '2026-10-12 06:00:00.000';  -- 13:00 WIB on 2026-10-12

INSERT INTO Friend (id, robloxAccountId, friendUserId, username, displayName, lastSeenAt) VALUES
  (1, @acct, @subA, 'alice', 'Alice', TIMESTAMPADD(MINUTE, -10, @now)),
  (2, @acct, @subB, 'bob',   'Bob',   NULL);

-- 1. SUB_A closed session fully inside "today" (WIB 09:00–11:00 = 02:00–04:00Z) → 7200s
-- 2. SUB_B session crossing local midnight (WIB 23:30 → 00:30) → 1800s in today
-- 3. SUB_A OPEN session (starts 05:30Z) → capped at lastSeenAt (05:50Z) = 1200s
-- 4. SUB_A other universe → excluded from @uni
-- 5. SUB_A NULL universe (legacy) → excluded + counted by the legacy query
INSERT INTO GameSession (id, robloxAccountId, subjectId, subjectType, placeId, universeId, gameName, startTime, endTime, duration) VALUES
  (1, @acct, @subA, 'FRIEND', 990000000001, @uni,  'Self Test Game', '2026-10-12 02:00:00.000', '2026-10-12 04:00:00.000', 7200),
  (2, @acct, @subB, 'FRIEND', 990000000001, @uni,  'Self Test Game', '2026-10-11 16:30:00.000', '2026-10-11 17:30:00.000', 3600),
  (3, @acct, @subA, 'FRIEND', 990000000001, @uni,  'Self Test Game', '2026-10-12 05:30:00.000', NULL, NULL),
  (4, @acct, @subA, 'FRIEND', 990000000001, @uni2, 'Other Game',     '2026-10-12 03:00:00.000', '2026-10-12 03:30:00.000', 1800),
  (5, @acct, @subA, 'FRIEND', 990000000001, NULL,  'Legacy Game',    '2026-10-12 01:00:00.000', '2026-10-12 02:00:00.000', 3600);

-- ── Window parameters (mirroring computeStatsWindows with rolling last7/30) ──
-- today.from = local midnight WIB on 2026-10-12 = 2026-10-11 17:00:00Z
SET @todayFrom := '2026-10-11 17:00:00.000';
SET @todayTo   := @now;
SET @d7From    := TIMESTAMPADD(DAY, -7,  @now);   -- rolling
SET @d30From   := TIMESTAMPADD(DAY, -30, @now);   -- rolling
SET @allFrom   := '1970-01-01 00:00:00.000';

-- ════════════════════════════════════════════════════════════════════════════
-- QUERY 1 — getWindowTotals (verbatim shape from gamestats.service.ts)
-- ════════════════════════════════════════════════════════════════════════════
DROP TEMPORARY TABLE IF EXISTS r1;
CREATE TEMPORARY TABLE r1 AS
SELECT
  COALESCE(SUM(GREATEST(0, TIMESTAMPDIFF(SECOND, GREATEST(gs.startTime, @allFrom),
    LEAST(COALESCE(gs.endTime, GREATEST(gs.startTime, LEAST(@now, COALESCE(GREATEST(COALESCE(sub.lastPolledAt, '1970-01-01 00:00:00.000'), COALESCE(sub.lastClosedEnd, '1970-01-01 00:00:00.000')), '1970-01-01 00:00:00.000')))), @now)))), 0) AS allSeconds,
  COALESCE(SUM(GREATEST(0, TIMESTAMPDIFF(SECOND, GREATEST(gs.startTime, @todayFrom),
    LEAST(COALESCE(gs.endTime, GREATEST(gs.startTime, LEAST(@now, COALESCE(GREATEST(COALESCE(sub.lastPolledAt, '1970-01-01 00:00:00.000'), COALESCE(sub.lastClosedEnd, '1970-01-01 00:00:00.000')), '1970-01-01 00:00:00.000')))), @todayTo)))), 0) AS todaySeconds,
  COALESCE(SUM(GREATEST(0, TIMESTAMPDIFF(SECOND, GREATEST(gs.startTime, @d7From),
    LEAST(COALESCE(gs.endTime, GREATEST(gs.startTime, LEAST(@now, COALESCE(GREATEST(COALESCE(sub.lastPolledAt, '1970-01-01 00:00:00.000'), COALESCE(sub.lastClosedEnd, '1970-01-01 00:00:00.000')), '1970-01-01 00:00:00.000')))), @now)))), 0) AS last7Seconds,
  COALESCE(SUM(GREATEST(0, TIMESTAMPDIFF(SECOND, GREATEST(gs.startTime, @d30From),
    LEAST(COALESCE(gs.endTime, GREATEST(gs.startTime, LEAST(@now, COALESCE(GREATEST(COALESCE(sub.lastPolledAt, '1970-01-01 00:00:00.000'), COALESCE(sub.lastClosedEnd, '1970-01-01 00:00:00.000')), '1970-01-01 00:00:00.000')))), @now)))), 0) AS last30Seconds,
  COUNT(DISTINCT gs.subjectId) AS playerCount,
  MIN(gs.startTime) AS firstSeen
FROM GameSession gs
LEFT JOIN (
  SELECT s.subjectId AS subjectId, MAX(s.lastPolledAt) AS lastPolledAt, MAX(s.lastClosedEnd) AS lastClosedEnd
  FROM (
    SELECT friendUserId AS subjectId, MAX(lastSeenAt) AS lastPolledAt, NULL AS lastClosedEnd
      FROM Friend WHERE robloxAccountId = @acct GROUP BY friendUserId
    UNION ALL
    SELECT robloxUserId AS subjectId, MAX(lastSeenAt) AS lastPolledAt, NULL AS lastClosedEnd
      FROM TrackedUser WHERE robloxAccountId = @acct GROUP BY robloxUserId
    UNION ALL
    SELECT subjectId AS subjectId, NULL AS lastPolledAt, MAX(endTime) AS lastClosedEnd
      FROM GameSession WHERE robloxAccountId = @acct AND endTime IS NOT NULL GROUP BY subjectId
  ) s
  GROUP BY s.subjectId
) sub ON sub.subjectId = gs.subjectId
WHERE gs.universeId = @uni AND gs.robloxAccountId = @acct AND gs.subjectId IN (@subA, @subB);

SELECT
  IF(allSeconds = 12000, 'PASS', 'FAIL') AS s1,
  IF(todaySeconds = 10200, 'PASS', 'FAIL') AS s2,
  IF(playerCount = 2, 'PASS', 'FAIL') AS s3,
  allSeconds, todaySeconds, last7Seconds, last30Seconds, playerCount
FROM r1;
-- Expected: all=12000 (7200 + 3600 + 1200), today=10200 (7200 + 1800 + 1200), players=2

-- ════════════════════════════════════════════════════════════════════════════
-- QUERY 2 — getPlayerPage (GROUP BY subjectId, deterministic tie-breaker)
-- ════════════════════════════════════════════════════════════════════════════
DROP TEMPORARY TABLE IF EXISTS r2;
CREATE TEMPORARY TABLE r2 AS
SELECT
  gs.subjectId AS subjectId,
  COALESCE(SUM(GREATEST(0, TIMESTAMPDIFF(SECOND, gs.startTime,
    COALESCE(gs.endTime, GREATEST(gs.startTime, LEAST(@now, COALESCE(GREATEST(COALESCE(sub.lastPolledAt, '1970-01-01 00:00:00.000'), COALESCE(sub.lastClosedEnd, '1970-01-01 00:00:00.000')), '1970-01-01 00:00:00.000'))))))), 0) AS totalSeconds,
  MAX(COALESCE(gs.endTime, GREATEST(gs.startTime, LEAST(@now, COALESCE(GREATEST(COALESCE(sub.lastPolledAt, '1970-01-01 00:00:00.000'), COALESCE(sub.lastClosedEnd, '1970-01-01 00:00:00.000')), '1970-01-01 00:00:00.000'))))) AS lastSeenAt,
  MAX(gs.endTime IS NULL) AS stillPlaying
FROM GameSession gs
LEFT JOIN (
  SELECT s.subjectId AS subjectId, MAX(s.lastPolledAt) AS lastPolledAt, MAX(s.lastClosedEnd) AS lastClosedEnd
  FROM (
    SELECT friendUserId AS subjectId, MAX(lastSeenAt) AS lastPolledAt, NULL AS lastClosedEnd
      FROM Friend WHERE robloxAccountId = @acct GROUP BY friendUserId
    UNION ALL
    SELECT robloxUserId AS subjectId, MAX(lastSeenAt) AS lastPolledAt, NULL AS lastClosedEnd
      FROM TrackedUser WHERE robloxAccountId = @acct GROUP BY robloxUserId
    UNION ALL
    SELECT subjectId AS subjectId, NULL AS lastPolledAt, MAX(endTime) AS lastClosedEnd
      FROM GameSession WHERE robloxAccountId = @acct AND endTime IS NOT NULL GROUP BY subjectId
  ) s
  GROUP BY s.subjectId
) sub ON sub.subjectId = gs.subjectId
WHERE gs.universeId = @uni AND gs.robloxAccountId = @acct AND gs.subjectId IN (@subA, @subB)
GROUP BY gs.subjectId
ORDER BY totalSeconds DESC, gs.subjectId ASC;

SELECT IF(COUNT(*) = 2, 'PASS', 'FAIL') AS s4, 'player rows = 2' AS what FROM r2;
SELECT IF((SELECT subjectId FROM r2 ORDER BY totalSeconds DESC, subjectId ASC LIMIT 1) = @subA, 'PASS', 'FAIL') AS s5, 'most: SUB_A first' AS what;
SELECT IF((SELECT totalSeconds FROM r2 WHERE subjectId = @subA) = 8400, 'PASS', 'FAIL') AS s6, 'SUB_A total = 8400' AS what;

-- ════════════════════════════════════════════════════════════════════════════
-- QUERY 3 — countLegacyRows (NULL-universe at the requested place)
-- ════════════════════════════════════════════════════════════════════════════
SELECT IF(COUNT(*) = 1, 'PASS', 'FAIL') AS s7, 'legacy excluded = 1' AS what
FROM GameSession gs
WHERE gs.robloxAccountId = @acct AND gs.universeId IS NULL
  AND gs.placeId IN (990000000001) AND gs.subjectId IN (@subA, @subB);

-- ════════════════════════════════════════════════════════════════════════════
-- QUERY 4 — getUserSessions (SUB_A in @uni: closed + open = 2 rows)
-- ════════════════════════════════════════════════════════════════════════════
SELECT IF(COUNT(*) = 2, 'PASS', 'FAIL') AS s8, 'SUB_A sessions = 2' AS what
FROM GameSession gs
WHERE gs.universeId = @uni AND gs.robloxAccountId = @acct AND gs.subjectId = @subA;

-- ════════════════════════════════════════════════════════════════════════════
-- QUERY 5 — open-session cap: the open row must be 1200s, not 1800s (to @now)
-- ════════════════════════════════════════════════════════════════════════════
SELECT IF(
  (SELECT TIMESTAMPDIFF(SECOND, gs.startTime,
     GREATEST(gs.startTime, LEAST(@now, COALESCE(GREATEST(COALESCE(sub.lastPolledAt, '1970-01-01 00:00:00.000'), COALESCE(sub.lastClosedEnd, '1970-01-01 00:00:00.000')), '1970-01-01 00:00:00.000'))))
   FROM GameSession gs
   LEFT JOIN (
     SELECT s.subjectId AS subjectId, MAX(s.lastPolledAt) AS lastPolledAt, MAX(s.lastClosedEnd) AS lastClosedEnd
     FROM (
       SELECT friendUserId AS subjectId, MAX(lastSeenAt) AS lastPolledAt, NULL AS lastClosedEnd
         FROM Friend WHERE robloxAccountId = @acct GROUP BY friendUserId
     ) s GROUP BY s.subjectId
   ) sub ON sub.subjectId = gs.subjectId
   WHERE gs.id = 3) = 1200,
  'PASS', 'FAIL'
) AS s9, 'open session capped to 1200s' AS what;

-- ════════════════════════════════════════════════════════════════════════════
-- Cleanup + summary
-- ════════════════════════════════════════════════════════════════════════════
DROP TEMPORARY TABLE IF EXISTS r1;
DROP TEMPORARY TABLE IF EXISTS r2;
DROP TEMPORARY TABLE IF EXISTS GameSession;
DROP TEMPORARY TABLE IF EXISTS Friend;
DROP TEMPORARY TABLE IF EXISTS TrackedUser;

SELECT 'INSPECT the PASS/FAIL rows above - any FAIL means a regression.' AS summary;
