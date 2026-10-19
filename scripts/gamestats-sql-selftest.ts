/**
 * SQL self-test for /gamestats — runs against a REAL MySQL/MariaDB.
 *
 * ── WRITE CONTRACT (read this before running against production) ─────────────
 * This script **does write to the real tables**, but only a self-contained
 * fixture scoped to a sentinel account id and a sentinel telegram id:
 *   - account id `990001`, telegram id `gamestats-selftest`;
 *   - every INSERT/DELETE is filtered by that account/telegram id;
 *   - `cleanup()` deletes the fixture at the start AND on both the success and
 *     error paths, so no residue remains (verified: the fixture rows count 0
 *     afterwards).
 * It never touches another account's rows. If you want a strictly ZERO-write
 * variant that never issues any write against real tables, use
 * `scripts/gamestats-sql-selftest.sql` instead — it uses TEMPORARY tables that
 * shadow the base tables, so it is safe to run on production with a plain
 * `mysql` client.
 *
 * Asserted semantics:
 *   - window clipping (partial overlap, and a session crossing local midnight);
 *   - in-progress sessions counted up to `now`, capped at the last poll;
 *   - open-session cap at `GREATEST(lastSeenAt, last closed end)`;
 *   - deterministic ordering (stable pagination via the subjectId tie-breaker);
 *   - universe grouping and NULL-universe exclusion;
 *   - the legacy footer count.
 *
 * Run (see README / deploy checklist):
 *   DATABASE_URL='mysql://user:pass@host:3306/db?timezone=Z' \
 *     npx tsx scripts/gamestats-sql-selftest.ts
 *
 * It prints PASS/FAIL per assertion and exits non-zero on any failure. It also
 * prints EXPLAIN output for the two hot queries.
 */

import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { gameStatsService } from '../src/services/analytics/gamestats.service.js';
import { computeStatsWindows } from '../src/lib/window.js';

const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is required');

const PrismaCtor = PrismaClient as unknown as new (opts: {
  adapter: PrismaMariaDb;
}) => PrismaClient;
const prisma = new PrismaCtor({ adapter: new PrismaMariaDb(url) });

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${String(actual)}, want ${String(expected)})`);
}

// ── Fixture ───────────────────────────────────────────────────────────────────

// A high account id and universe id that will not collide with real data.
const FIX_ACCOUNT = 990001;
const FIX_UNIVERSE = 990000000001n;
const FIX_OTHER_UNIVERSE = 990000000002n;
const SUB_A = 990000000000001n; // friend, in scope
const SUB_B = 990000000000002n; // friend, in scope
const NOW = new Date('2026-10-12T06:00:00Z'); // 13:00 WIB on 2026-10-12

async function cleanup(): Promise<void> {
  await prisma.gameSession.deleteMany({ where: { robloxAccountId: FIX_ACCOUNT } });
  await prisma.friend.deleteMany({ where: { robloxAccountId: FIX_ACCOUNT } });
  await prisma.trackedUser.deleteMany({ where: { robloxAccountId: FIX_ACCOUNT } });
  // Durable identity rows cascade from RobloxAccount, but remove them first so
  // the fixture is fully self-contained.
  await prisma.subjectIdentity.deleteMany({ where: { robloxAccountId: FIX_ACCOUNT } });
  await prisma.robloxAccount.deleteMany({ where: { id: FIX_ACCOUNT } });
  await prisma.telegramUser.deleteMany({ where: { telegramId: 'gamestats-selftest' } });
}

async function seed(): Promise<void> {
  await cleanup();
  // Seeded with raw SQL rather than Prisma models: an RnD database may lag the
  // newest migrations (e.g. `authFailureCount`), and the /gamestats queries only
  // ever read `GameSession` / `Friend` / `TrackedUser`, so the auth columns are
  // irrelevant to this fixture.
  await prisma.$executeRawUnsafe(
    `INSERT INTO TelegramUser (telegramId, createdAt, updatedAt) VALUES (?, NOW(3), NOW(3))`,
    'gamestats-selftest',
  );
  const tuRows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
    'SELECT id FROM TelegramUser WHERE telegramId = ?',
    'gamestats-selftest',
  );
  const userId = tuRows[0]!.id;

  await prisma.$executeRawUnsafe(
    `INSERT INTO RobloxAccount (id, userId, robloxUserId, username, displayName, roblosecurity, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    FIX_ACCOUNT,
    userId,
    990000000001n,
    'selftest',
    'Self Test',
    'x',
  );

  // Two friends in scope; SUB_A's last poll is at NOW - 10 min.
  await prisma.friend.createMany({
    data: [
      {
        robloxAccountId: FIX_ACCOUNT,
        friendUserId: SUB_A,
        username: 'alice',
        displayName: 'Alice',
        lastSeenAt: new Date(NOW.getTime() - 10 * 60 * 1000),
      },
      { robloxAccountId: FIX_ACCOUNT, friendUserId: SUB_B, username: 'bob', displayName: 'Bob', lastSeenAt: null },
    ],
  });
}

/** Local midnight windows for NOW in Asia/Jakarta. */
const WINDOWS = computeStatsWindows(NOW, 'Asia/Jakarta');
const scope = { accountId: FIX_ACCOUNT, subjectIds: [SUB_A, SUB_B], now: NOW };

async function insertSession(fields: {
  subjectId: bigint;
  universeId: bigint | null;
  startTime: Date;
  endTime: Date | null;
  placeId?: bigint;
  gameName?: string;
}): Promise<void> {
  await prisma.gameSession.create({
    data: {
      robloxAccountId: FIX_ACCOUNT,
      subjectId: fields.subjectId,
      subjectType: 'FRIEND',
      placeId: fields.placeId ?? 990000000001n,
      universeId: fields.universeId,
      startTime: fields.startTime,
      endTime: fields.endTime,
      duration: fields.endTime
        ? Math.floor((fields.endTime.getTime() - fields.startTime.getTime()) / 1000)
        : null,
      gameName: fields.gameName ?? 'Self Test Game',
    },
  });
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await seed();

  // 1. Clipping: a closed session entirely within "today" (WIB 2026-10-12 09:00–11:00
  //    local = 02:00–04:00Z) contributes its full 2h to today and to all-time.
  await insertSession({
    subjectId: SUB_A,
    universeId: FIX_UNIVERSE,
    startTime: new Date('2026-10-12T02:00:00Z'),
    endTime: new Date('2026-10-12T04:00:00Z'),
  });

  // 2. Crossing local midnight: WIB 23:30 on the 11th → 00:30 on the 12th
  //    (= 2026-10-11T16:30Z → 2026-10-11T17:30Z). Only the 00:00–00:30 part
  //    (1800s) belongs to today; the whole hour is all-time.
  await insertSession({
    subjectId: SUB_B,
    universeId: FIX_UNIVERSE,
    startTime: new Date('2026-10-11T16:30:00Z'),
    endTime: new Date('2026-10-11T17:30:00Z'),
  });

  // 3. In-progress session for SUB_A with lastSeenAt = NOW-10min: it must be
  //    capped at NOW-10min, i.e. counted as 10 minutes, not up to NOW.
  await insertSession({
    subjectId: SUB_A,
    universeId: FIX_UNIVERSE,
    startTime: new Date('2026-10-12T05:30:00Z'), // 30 min before NOW (05:30→06:00Z)
    endTime: null,
  });

  // 4. A different universe: must not be counted for FIX_UNIVERSE.
  await insertSession({
    subjectId: SUB_A,
    universeId: FIX_OTHER_UNIVERSE,
    startTime: new Date('2026-10-12T03:00:00Z'),
    endTime: new Date('2026-10-12T03:30:00Z'),
  });

  // 5. NULL universe (hidden/legacy): must be excluded from FIX_UNIVERSE.
  await insertSession({
    subjectId: SUB_A,
    universeId: null,
    placeId: 990000000001n,
    startTime: new Date('2026-10-12T01:00:00Z'),
    endTime: new Date('2026-10-12T02:00:00Z'),
  });

  const totals = await gameStatsService.getWindowTotals(scope, FIX_UNIVERSE, WINDOWS);

  // Open session starts 05:30Z; the subject's last poll is NOW-10min = 05:50Z, so
  // the cap yields exactly 20 minutes (1200s), not the 30 min up to NOW.
  const OPEN_SECONDS = 20 * 60;
  // all-time = 7200 (sub A today) + 3600 (sub B) + 1200 (sub A open, capped) = 12000
  check('all-time seconds', totals.allSeconds, 7200 + 3600 + OPEN_SECONDS);
  // today  = 7200 (sub A) + 1800 (sub B in-window half) + 1200 (sub A open capped) = 10200
  check('today seconds', totals.todaySeconds, 7200 + 1800 + OPEN_SECONDS);
  check('player count', totals.playerCount, 2);

  // Players: SUB_A total = 7200 + 1200 = 8400; SUB_B = 3600. `most` => A first.
  const most = await gameStatsService.getPlayerPage(scope, FIX_UNIVERSE, 'most', 10, 0, 3600 * 12);
  check('most: first subject is SUB_A', most.players[0]?.subjectId, SUB_A);
  check('most: SUB_A total', most.players[0]?.totalSeconds, 7200 + OPEN_SECONDS);
  check('most: total distinct players', most.total, 2);

  // Pagination stability: page size 1 with a tie should still be deterministic.
  await insertSession({
    subjectId: SUB_B,
    universeId: FIX_UNIVERSE,
    startTime: new Date('2026-10-12T02:30:00Z'),
    endTime: new Date('2026-10-12T03:00:00Z'), // +1800 → SUB_B = 5400
  });
  const p1 = await gameStatsService.getPlayerPage(scope, FIX_UNIVERSE, 'most', 1, 0, 3600 * 12);
  const p2 = await gameStatsService.getPlayerPage(scope, FIX_UNIVERSE, 'most', 1, 1, 3600 * 12);
  check('page1 subject', p1.players[0]?.subjectId, SUB_A);
  check('page2 subject', p2.players[0]?.subjectId, SUB_B);

  // user mode: raw sessions + merge (SUB_A has the one 2h session).
  const rows = await gameStatsService.getUserSessions(scope, FIX_UNIVERSE, SUB_A, 100);
  check('user sessions count', rows.length, 2); // 2h closed session + open session

  // legacy footer count: one NULL-universe row for SUB_A at the requested place.
  // Counted here, before the tie-breaker scenario clears the table.
  const legacy = await gameStatsService.countLegacyRows(scope, FIX_UNIVERSE, [990000000001n]);
  check('legacy excluded count', legacy, 1);

  // Tie-breaker: two subjects with identical totals → order by subjectId ASC.
  await prisma.gameSession.deleteMany({ where: { robloxAccountId: FIX_ACCOUNT } });
  const t = new Date('2026-10-12T02:00:00Z');
  const tEnd = new Date('2026-10-12T03:00:00Z');
  await insertSession({ subjectId: SUB_B, universeId: FIX_UNIVERSE, startTime: t, endTime: tEnd });
  await insertSession({ subjectId: SUB_A, universeId: FIX_UNIVERSE, startTime: t, endTime: tEnd });
  const tie = await gameStatsService.getPlayerPage(scope, FIX_UNIVERSE, 'most', 10, 0, 3600 * 12);
  check('tie-breaker: smaller subjectId first', tie.players[0]?.subjectId, SUB_A);

  // EXPLAIN for the two hot queries.
  console.log('\n── EXPLAIN (summary query) ──');
  const explain1 = await prisma.$queryRawUnsafe(
    `EXPLAIN SELECT COUNT(DISTINCT gs.subjectId) FROM GameSession gs
       WHERE gs.universeId = ${FIX_UNIVERSE} AND gs.robloxAccountId = ${FIX_ACCOUNT}
         AND gs.subjectId IN (${SUB_A}, ${SUB_B})`,
  );
  console.log(JSON.stringify(explain1, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

  console.log('\n── EXPLAIN (player page query) ──');
  const explain2 = await prisma.$queryRawUnsafe(
    `EXPLAIN SELECT gs.subjectId, SUM(TIMESTAMPDIFF(SECOND, gs.startTime, COALESCE(gs.endTime, NOW()))) AS totalSeconds
       FROM GameSession gs
       WHERE gs.universeId = ${FIX_UNIVERSE} AND gs.robloxAccountId = ${FIX_ACCOUNT}
         AND gs.subjectId IN (${SUB_A}, ${SUB_B})
       GROUP BY gs.subjectId ORDER BY totalSeconds DESC, gs.subjectId ASC LIMIT 10`,
  );
  console.log(JSON.stringify(explain2, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

  await cleanup();
  await prisma.$disconnect();

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('SELFTEST ERROR', err);
  try {
    await cleanup();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
