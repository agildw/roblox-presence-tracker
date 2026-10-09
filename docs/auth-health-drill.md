# Auth-health drill (~10 minutes, reversible)

Reproduces the "expired cookie served as anonymous" incident and proves the guard
works: detection, one alert, cycles skipped, no re-alert on restart, and recovery
via both `/setcookie` and a direct DB restore.

**Scope:** one connected account. **Risk:** presence notifications for that account
pause for the duration (that is the behaviour under test). Nothing is deleted —
the original `roblosecurity` value is backed up and restored.

> Run this on the server. Have the real cookie to hand only for the final
> `/setcookie` step (step 7); never paste it into a shell that logs history.

---

## 0. Prerequisites

```bash
cd /home/agil/app/roblox-presence-tracker
git checkout fix/presence-pacing-phase1 && npm ci && npm run build
npx prisma migrate deploy        # adds authFailureCount + authLastAlertAt
```

Migrations applied? `npx prisma migrate status` must report no pending migrations.
The new columns default to `0` / `NULL`, so no data backfill is needed.

Note the account id and your Telegram id — needed below:

```sql
SELECT a.id, a.username, u.telegramId, a.authFailureCount, a.authLastAlertAt
FROM RobloxAccount a JOIN TelegramUser u ON u.id = a.userId;
```

## 1. Back up the cookie row (do this first; it is the rollback)

```sql
CREATE TABLE RobloxAccount_cookie_backup AS
  SELECT id, roblosecurity, authFailureCount, authLastAlertAt, NOW() AS backedUpAt
  FROM RobloxAccount;

SELECT id, LENGTH(roblosecurity) AS enc_len, backedUpAt FROM RobloxAccount_cookie_backup;
```

Record `enc_len` — after restoring it must match. (The backup table holds only the
**encrypted** value; that is still a credential, so drop it at the end, step 9.)

## 2. Lower the check interval for the drill

`AUTH_CHECK_INTERVAL_MS` must be short so you do not wait 15 minutes.
`/setcookie` is not needed for this; just restart with the env var.

```bash
pm2 stop 0
AUTH_CHECK_INTERVAL_MS=30000 pm2 start 0 --update-env --time
pm2 logs 0 --lines 20 --nostream | grep 'auth check every'
# expect: (min request gap 0ms, auth check every 0.5m)
```

## 3. Install an invalid cookie

**There is no encryption-free way to do this by hand.** `roblosecurity` stores
`iv:authTag:ciphertext` (AES-256-GCM, hex), so you cannot `UPDATE` it with a
plaintext dummy value — `decrypt()` would throw and the account would be reported
as "No stored cookie", which is a *different* path. Produce a correctly encrypted
dummy value with the app's own crypto:

```bash
ENCRYPTION_KEY="$(printenv ENCRYPTION_KEY)" node --input-type=module -e '
import { encrypt } from "./dist/lib/crypto.js";
console.log(encrypt("00000000-0000-0000-0000-000000000000"));
'
```

Copy that output into the statement below (never paste the *real* cookie here):

```sql
UPDATE RobloxAccount SET roblosecurity = '<paste encrypted dummy here>', authFailureCount = 0, authLastAlertAt = NULL
WHERE id = <ACCOUNT_ID>;
```

> `/setcookie` **rejects** an invalid cookie — it calls `validateCookie` and
> replies "Invalid cookie" without storing (`setcookie.ts`, `connectAccount` →
> `validateCookie`). So a dead cookie can only be installed by writing the DB
> directly, as above.

## 4. Expected logs within ~30 s (one check interval)

```
[AuthHealth] Account <ID> (<name>) cookie is INVALID — presence polling paused. Roblox rejected the cookie (HTTP 401: User is not authenticated). Reconnect with /setcookie.
[AuthHealth] Alerted 1 recipient(s) about account <ID>; next alert allowed in 6h.
[Worker] cycle completed: 0/0 batches applied, took 0.0s, <N> account(s) skipped (cookie invalid) [queue=0 inFlight=0 gap=0.0s cooldown=0s penalty=0 interval=x1.0]
```

And **no** `[PresenceService]` transition lines (no `came online` / `went offline`)
for that account — the cycle never fetches its users, so nothing can be
misreported. Verify:

```bash
pm2 logs 0 --lines 200 --nostream --out | grep -c 'account(s) skipped (cookie invalid)'   # >= 1
pm2 logs 0 --lines 200 --nostream --out | grep -c 'cycle completed: 0/0'                  # >= 1
```

## 5. Telegram message (sent once to the owner **and** to each `ADMIN_USER_IDS` entry)

If the owner's Telegram id is itself in `ADMIN_USER_IDS`, they receive **one**
message, not two — recipients are de-duplicated via a `Set`
(`auth-health.service.ts`: `new Set([telegramId, ...env.ADMIN_USER_IDS])`).

Exact text (HTML):

```
🔐 <b>Roblox account disconnected</b>

The stored <code>.ROBLOSECURITY</code> cookie for <b><name></b> is no longer valid.

Roblox rejected the cookie (HTTP 401: User is not authenticated).

Presence tracking is paused until a valid cookie is saved — Roblox serves anonymous requests far more restrictively, so continuing would only produce rate-limit errors.

Fix: log out and back in to Roblox, then send <code>/setcookie &lt;fresh cookie&gt;</code>.
```

**Confirm no re-alert inside the cooldown:** wait two check intervals and check the
count did not increase.

```bash
pm2 logs 0 --lines 500 --nostream --out | grep -c 'Alerted .* recipient(s) about account <ID>'   # exactly 1
```

## 6. Restart while invalid — must NOT re-alert

```bash
BEFORE=$(pm2 logs 0 --lines 2000 --nostream --out | grep -c 'Alerted .* recipient(s)')
pm2 restart 0 --update-env --time
sleep 45     # > one 30 s check interval
AFTER=$(pm2 logs 0 --lines 2000 --nostream --out | grep -c 'Alerted .* recipient(s)')
echo "before=$BEFORE after=$AFTER"     # expect equal
```

Because `authLastAlertAt` is persisted on `RobloxAccount`, the cooldown survives a
restart/crash loop. If `after > before`, persistence is not working — report it.

## 7a. Recover via `/setcookie` (preferred, and the path a real user takes)

Log out and back in on Roblox to get a fresh cookie, then in Telegram:

```
/setcookie <fresh cookie>
```

Expected: the normal "✅ Account connected!" reply, plus in the logs

```
[AuthHealth] Account <ID>: cookie replaced; resuming presence polling.
[Worker] cycle completed: 4/4 batches applied, took ~6.0s
```

i.e. `account(s) skipped` disappears and batch counts return to normal.

## 7b. Recover via direct DB restore (rollback)

```sql
UPDATE RobloxAccount a
JOIN RobloxAccount_cookie_backup b ON b.id = a.id
SET a.roblosecurity = b.roblosecurity, a.authFailureCount = 0, a.authLastAlertAt = NULL;

SELECT a.id, LENGTH(a.roblosecurity) = LENGTH(b.roblosecurity) AS len_ok
FROM RobloxAccount a JOIN RobloxAccount_cookie_backup b ON b.id = a.id;
```

`len_ok = 1` for every row. Then within one check interval:

```
[AuthHealth] Account <ID>: cookie is valid again; resuming presence polling.
[Worker] cycle completed: N/N batches applied
```

This is the **self-healing** path: no `/setcookie`, no restart — a valid check
clears `invalid` and resets `authFailureCount`.

## 8. Confirm recovery

```bash
pm2 logs 0 --lines 300 --nostream --out | tail -20 | grep 'cycle completed'
# expect: N/N batches applied, and no "(throttled)"
```

## 9. Clean up

```bash
pm2 restart 0 --update-env        # drop the 30s check interval override
```

```sql
DROP TABLE RobloxAccount_cookie_backup;
```

Confirm the drill left no alerts behind and the columns are reset:

```sql
SELECT id, authFailureCount, authLastAlertAt FROM RobloxAccount;
```

---

## Rollback at any point

```sql
UPDATE RobloxAccount a
JOIN RobloxAccount_cookie_backup b ON b.id = a.id
SET a.roblosecurity = b.roblosecurity;
```

Then `pm2 restart 0`. The worst case is presence notifications paused for that
account until step 7 — no data is deleted, and sessions are unaffected because
skipped users are simply not evaluated.

## Automated alternative

`scripts/auth-health-live.ts` runs the same detection logic against the real API
with a stubbed DB/Telegram, so it needs no production changes:

```bash
set -a; . /root/.rbx-test-cookie; set +a     # exports ROBLOX_TEST_COOKIE
DRILL_PHASES=A,B,C node --env-file=scripts/auth-live.env \
  ./node_modules/tsx/dist/cli.mjs scripts/auth-health-live.ts
```

It proves dummy→INVALID (one alert), real→VALID (no alert), the 200 parse, and
optionally `DRILL_PHASES=D` for a normal-volume presence run. It never prints the
cookie.