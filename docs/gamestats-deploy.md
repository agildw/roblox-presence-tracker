# `/gamestats` — deploy & rollback checklist

Branch: `feat/gamestats-command` · read-only feature · additive migration only

---

## Pre-merge: secret & stray-file scan

Run before pushing/merging. It scans the full `git diff main` for connection
strings, passwords, cookie fragments, and files that should not be committed:

```bash
# 1. Secret-like strings added by this branch, EXCLUDING known placeholders.
#    Real credentials (actual host/user/pass) will still surface.
git diff main -- . \
  | grep -nE '^\+' \
  | grep -E 'mysql://|postgres://|\.ROBLOSECURITY' \
  | grep -vE 'user:pass@|mysql://user:pass@host|roblox_tracker\?timezone=Z' \
  && echo 'REVIEW the matches above' || echo 'no secret-like strings'

# 2. Long opaque blobs (cookie/key fragments) — 40+ base64/hex chars.
git diff main -- . \
  | grep -nE '^\+' \
  | grep -E '[A-Za-z0-9+/_-]{40,}={0,2}' \
  | grep -vE 'GameSession_robloxAccountId_universeId_startTime_idx|20261012064046' \
  && echo 'REVIEW the matches above' || echo 'no long blobs'

# 3. Files changed vs main, and anything untracked.
git diff --stat main
git status --porcelain
```

- [ ] No real `mysql://user:pass@…` URL — only the `mysql://user:pass@host:3306/db`
      **placeholder** in docs/scripts.
- [ ] No `.ROBLOSECURITY` values or long base64/hex cookie-looking blobs.
- [ ] `git status --porcelain` shows only intended files (`fix.js`, `old-data.json`, and local
      `.env` must remain untracked and unstaged).
- [ ] No `.env`, `*.env` (except `*.env.example`/committed sample envs), DB dumps, or `dist/`.

---

## 0. Pre-flight

- [ ] Run the migration-status check and **read the output before anything else**:

```bash
DATABASE_URL='mysql://user:pass@host:3306/db?timezone=Z' npx prisma migrate status
```

  **Rule: stop if it reports drift, and NEVER run `prisma migrate reset` on this
  database.** `migrate reset` drops and recreates the schema — it would destroy
  every `GameSession`, `Friend`, and `TrackedUser` row, all of which are
  unrecoverable (there is no backfill). `migrate status` reporting "have not yet
  been applied" for the *older* migrations means the database was hand-patched;
  that is drift, and the rule is to reconcile it deliberately (see below), not to
  reset.

  - If it reports the DB is **up to date**: proceed.
  - If it reports **only this feature's migration** as pending: proceed to §2.
  - If it reports **older migrations pending** (e.g.
    `add_is_disabled_to_telegram_user`, `add_auth_health_to_roblox_account`): the
    schema drifted — those columns exist but the migrations were never recorded.
    Do **not** `migrate deploy` blindly (it will fail with `Duplicate column
    name`). Either mark them applied (`prisma migrate resolve --applied <name>`
    once you have confirmed the columns match), or apply the intent by hand, then
    apply this feature's index itself (fallback in §2b).
- [ ] `DATABASE_URL` includes `?timezone=Z` (the window math assumes UTC storage).
- [ ] Confirm the target engine: production is **MySQL 8.0.46**; the dev/RnD box is
      **MariaDB 10.4.25**. `/gamestats` is verified on both (see §5a). MySQL 8 enables
      `ONLY_FULL_GROUP_BY` by default; every gamestats query is compliant with it.

## 1. Backup

- [ ] `mysqldump` the `GameSession`, `Friend`, `TrackedUser` tables (and ideally the whole DB).
      The migration is additive (`CREATE INDEX`) and the feature is read-only, but the index
      build on a large table should still be preceded by a backup.

## 2. Migration

```bash
DATABASE_URL='mysql://user:pass@host:3306/db?timezone=Z' npx prisma migrate deploy
```

Only one statement runs:

```sql
CREATE INDEX `GameSession_robloxAccountId_universeId_startTime_idx`
  ON `GameSession`(`robloxAccountId`, `universeId`, `startTime`);
```

- [ ] Verify it exists: `SHOW INDEX FROM GameSession;`

### 2b. Fallback — apply the index by hand (only if §2 cannot run)

If the drift in §0 blocks `migrate deploy`, apply the index directly and then
record the migration as applied so Prisma stops reporting it as pending:

```sql
CREATE INDEX `GameSession_robloxAccountId_universeId_startTime_idx`
  ON `GameSession`(`robloxAccountId`, `universeId`, `startTime`);
```

```bash
# Record it as applied WITHOUT re-running the SQL:
DATABASE_URL='mysql://user:pass@host:3306/db?timezone=Z' \
  npx prisma migrate resolve --applied 20261012064046_add_gamesession_universe_index
```

- [ ] Re-run `npx prisma migrate status`; it must no longer list this migration as pending.
- [ ] If the index already exists, `CREATE INDEX` errors with `Duplicate key name` — that is
      harmless; skip straight to `migrate resolve`.

## 3. EXPLAIN checks (run on the real, populated DB)

```sql
-- Summary query shape
EXPLAIN SELECT COUNT(DISTINCT gs.subjectId)
  FROM GameSession gs
  WHERE gs.universeId = <universeId> AND gs.robloxAccountId = <accountId>
    AND gs.subjectId IN (<subjectIds>);

-- Player page shape (effective end = closed end, or the open-session cap)
EXPLAIN SELECT gs.subjectId,
       SUM(TIMESTAMPDIFF(SECOND, gs.startTime,
         COALESCE(gs.endTime, GREATEST(gs.startTime,
           LEAST(NOW(3), COALESCE(GREATEST(COALESCE(sub.lastPolledAt,'1970-01-01'), COALESCE(sub.lastClosedEnd,'1970-01-01')), '1970-01-01')))))) AS totalSeconds
  FROM GameSession gs
  LEFT JOIN (
    SELECT s.subjectId AS subjectId, MAX(s.lastPolledAt) AS lastPolledAt, MAX(s.lastClosedEnd) AS lastClosedEnd
    FROM (
      SELECT friendUserId AS subjectId, MAX(lastSeenAt) AS lastPolledAt, NULL AS lastClosedEnd FROM Friend WHERE robloxAccountId = <accountId> GROUP BY friendUserId
      UNION ALL
      SELECT robloxUserId AS subjectId, MAX(lastSeenAt) AS lastPolledAt, NULL AS lastClosedEnd FROM TrackedUser WHERE robloxAccountId = <accountId> GROUP BY robloxUserId
      UNION ALL
      SELECT subjectId AS subjectId, NULL AS lastPolledAt, MAX(endTime) AS lastClosedEnd FROM GameSession WHERE robloxAccountId = <accountId> AND endTime IS NOT NULL GROUP BY subjectId
    ) s GROUP BY s.subjectId
  ) sub ON sub.subjectId = gs.subjectId
  WHERE gs.universeId = <universeId> AND gs.robloxAccountId = <accountId>
    AND gs.subjectId IN (<subjectIds>)
  GROUP BY gs.subjectId ORDER BY totalSeconds DESC, gs.subjectId ASC LIMIT 10 OFFSET 0;
```

- [ ] Optional: run `SET SESSION sql_mode = CONCAT(@@sql_mode, ',ONLY_FULL_GROUP_BY');`
      first, to reproduce production MySQL 8's default — every gamestats query is compliant.

- [ ] On a populated DB the plan should show
      `key: GameSession_robloxAccountId_universeId_startTime_idx` (verified on the RnD DB at
      3 453 rows for the busiest universe). If it picks another index, the statistics may be
      stale — `ANALYZE TABLE GameSession;`.

## 4. SQL self-test (real DB, not mocks)

Two variants — pick per risk tolerance:

**4a. Zero-write variant (safe on production).** Uses TEMPORARY tables that shadow the base
tables, so no real table is read or written:

```bash
mysql --table -h HOST -u USER -p DB < scripts/gamestats-sql-selftest.sql
```

- [ ] All `s1…s9` rows show `PASS`.
- [ ] Prove the shadowing: in that same session `SELECT COUNT(*) FROM GameSession;` returns the
      fixture count (5), while a **second** concurrent `mysql` session still sees the real
      count.
- [ ] The script sets `ONLY_FULL_GROUP_BY` for the session, matching production MySQL 8.

**4b. In-process TS variant (writes a scoped, self-cleaned fixture).**

```bash
DATABASE_URL='mysql://user:pass@host:3306/db?timezone=Z' \
  npx tsx scripts/gamestats-sql-selftest.ts
```

- [ ] Expect `ALL PASS` (11 assertions) and exit code 0.
- [ ] **Write contract:** unlike 4a, this one *does* insert and delete real rows — but only for
      the sentinel fixture (`robloxAccountId = 990001`, `telegramId = 'gamestats-selftest'`),
      and `cleanup()` runs at start and on both success and error paths. Verified to leave zero
      residue. Prefer 4a against production.

## 5. Build & type checks

- [ ] `npx tsc --noEmit`
- [ ] `node --import tsx --test src/bot/commands/gamestats.test.ts` → 24 passing.
      (Note: the pre-existing `presence.service.test.ts` / `auth-health.service.test.ts`
      pass but keep the process alive due to an open rate-limiter timer — a pre-existing
      issue, unrelated to this feature.)

## 6. Telegram smoke tests

Send these in a **private chat** with a connected account (and once in a group to confirm it
scopes to the sender):

| # | Command | Expect |
| --- | --- | --- |
| 1 | `/gamestats https://www.roblox.com/games/77843161404023/Run-a-Restaurant` | Name + "Tracked since …", four window totals, 10 recent players, Prev hidden on page 1, chip `1/N`, Next present |
| 2 | `/gamestats 77843161404023` | Same (bare id) |
| 3 | `/gamestats https://www.roblox.com/es/games/77843161404023` | Same (regional prefix) |
| 4 | `/gamestats 77843161404023 most` | Header "Top players", sorted by total time desc |
| 5 | `/gamestats 77843161404023 user:<friend>` | That user's windows + session list, newest first; pages through sessions |
| 6 | `/gamestats 77843161404023 most user:<friend>` | Session list longest-first |
| 7 | Press **Next** twice then **Prev** | Page chip updates, message edits in place, no "message is not modified" error surfacing |
| 8 | Press a button on an **old** message after a bot restart | Message rebuilds from DB ids (no Roblox call); a non-owner pressing gets "This isn't your message." |
| 9 | `/gamestats https://example.com/games/123` | Rejected: "not a Roblox game URL or place id" |
| 10 | `/gamestats 77843161404023 user:nobody` | "not found in your tracked friends or users" |
| 11 | `/gamestats 77843161404023 bogus` | "Unknown option" + usage |
| 12 | `/gamestats` (no args) | Usage message |
| 13 | `/gamestats <a game with a > 12h session>` | Footer: "Some sessions exceed 12h and may include monitoring gaps." |
| 14 | `/gamestats <a game with legacy rows in scope>` | Footer: "N older session(s) without an experience id excluded." |

## 7. Rollback

The feature is **read-only** and adds no columns; rollback is minimal:

- [ ] Revert the branch (or stop deploying it). Existing commands are unaffected.
- [ ] Optionally drop the index (purely additive; safe to remove):

```sql
DROP INDEX `GameSession_robloxAccountId_universeId_startTime_idx` ON `GameSession`;
```

- [ ] No data migration to reverse. No sessions are written by this feature.

## 8. What is NOT touched by this change

Presence worker/service, notification service, and the session write paths
(`startGameSession` / `endGameSession` / `changeGameSession`) are unchanged. No cookie is
logged by the new code (the resolver calls are cookie-less by construction).
