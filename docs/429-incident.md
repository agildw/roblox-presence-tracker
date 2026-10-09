# Incident: recurring HTTP 429 on the presence endpoint

**Status:** resolved — root cause was an **expired stored `.ROBLOSECURITY` cookie**.

## Symptoms

- `presence.roblox.com` returned `429` on ordinary polls (`stopped at batch 3/4`, then `1/4`).
- `[HTTP] Attempt 1 failed (status=429)` storms and `previous cycle still running` overlap (older code).
- `Retry-After` almost always **absent**; `x-ratelimit-remaining` looked healthy (e.g. `46`) on a `60;w=60` budget.
- Probing from the server showed anonymous trials throttling while authenticated trials were clean.

## Root cause

Roblox does **not** reject an expired `.ROBLOSECURITY` cookie on
`presence.roblox.com` with a 401. It answers **200** and serves the request as
**anonymous**, under the much stricter unauthenticated limiter. So a dead cookie
looks exactly like "Roblox tightened its rate limits":

- presence keeps returning 200 with plausible data, so nothing looks broken;
- the request count is far below the advertised budget, yet 429s arrive;
- `Retry-After` is usually absent (it is an admission-control penalty, not a
  quota-exhaustion response);
- the bot's *own* pacing is irrelevant — it is being throttled for being anonymous.

**Decisive evidence.** Same 5 user ids, same endpoint, same moment:

| Request | Status | `x-ratelimit-limit` | Body |
| --- | --- | --- | --- |
| no cookie | `200` | `60, 60;w=60` | 7 records, byte-identical to the authenticated shape |
| **invalid cookie** | `200` | `60, 60;w=60` | 7 records, byte-identical |
| (valid cookie, real account) | `200` | `60, 60;w=60, 100;w=60` | same field set |

`GET users.roblox.com/v1/users/authenticated` **does** report the truth:

| Request | Status | `x-ratelimit-limit` | Body |
| --- | --- | --- | --- |
| no cookie | `401` | `100, 100;w=60` | `9002 Authentication token is missing` |
| **invalid cookie** | `401` | `300, 300;w=60` | `9002 subcode 3 User is not authenticated` |

Two consequences that matter:

1. **The `100;w=60` window tracks authentication.** Present only on a logged-in
   session; absent for no-cookie *and* for invalid-cookie. Useful as a *hint* at
   most — never the primary signal, because the bot is normally always
   authenticated and the window appears in both cases when it is not.
2. **The bot cannot detect this from presence data.** The payload is identical,
   including `lastLocation`/`placeId`/`gameId`. (Note: `lastOnline` is absent from
   `presence/users` for **every** origin, so `/history`'s "Last online" is not
   populated from this endpoint regardless of auth — a pre-existing gap.)

## How to diagnose next time — check cookie validity FIRST

```bash
# 1. Is the stored cookie still valid? (401 ⇒ yes, this is your incident)
#    Reconnect with /setcookie and confirm 429s stop.
# 2. Bot forensics (off by default):
ROBLOX_FORENSIC_LOG=1 pm2 restart 0 --update-env --time
pm2 logs 0 --lines 5000 --nostream --out | grep '\[RBX\]'
#    Look for: status=429, and limit=60, 60;w=60 WITHOUT 100;w=60 => unauthenticated.
# 3. Do not tune intervals until step 1 is clean.
```

## Fix

`src/services/account/auth-health.service.ts` validates the stored cookie against
`/v1/users/authenticated` through the same limiter:

- at startup, and every `AUTH_CHECK_INTERVAL_MS` (default 15 min);
- immediately when a presence cycle is throttled;
- on a 401/403 the account is marked invalid, **presence cycles skip it entirely**
  (anonymous results are not processed), the error is logged, and **one** Telegram
  alert goes to the account owner and every `ADMIN_USER_IDS` entry — at most once
  per `AUTH_ALERT_COOLDOWN_HOURS` (default 6 h);
- a valid `/setcookie` clears the flag and polling resumes automatically.

Only an explicit **401/403** marks the cookie invalid. A 429, cooldown, or network
error is reported as `unknown` and leaves auth state untouched — otherwise a
transient throttle would masquerade as a dead cookie (and vice versa), which is
how this incident was misread.

## Env knobs

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTH_CHECK_INTERVAL_MS` | `900000` | Cookie re-validation interval (15 min). |
| `AUTH_ALERT_COOLDOWN_HOURS` | `6` | Minimum gap between invalid-cookie alerts per account. |
| `ROBLOX_FORENSIC_LOG` | `false` | One `[RBX]` line per Roblox request (investigations only). |
| `ROBLOX_MIN_REQUEST_GAP_MS` | `0` | Optional extra spacing between request starts (off). |
| `ROBLOX_COOLDOWN_MS` | `45000` | Cooldown opened by a 429 when `Retry-After` is absent. |
| `ROBLOX_ADAPTIVE_MAX_MULTIPLIER` | `4` | Max poll slow-down while penalised. |

## Verification commands

```bash
npx tsc --noEmit -p tsconfig.json
node --env-file=scripts/presence-invariant.env ./node_modules/tsx/dist/cli.mjs \
  --test src/services/presence/presence.service.test.ts \
         src/services/account/auth-health.service.test.ts
DOTENV_CONFIG_PATH=scripts/ratelimit-smoke.env npx tsx scripts/ratelimit-smoke.ts

# After deploying, expected steady state:
pm2 logs 0 --lines 2000 --nostream --out | grep 'cycle completed'   # N/N batches, no "(throttled)"
grep -c 'AuthHealth.*INVALID' /root/.pm2/logs/roblox-tracker-error.log   # expect 0
```

## Lesson

Rate-limit symptoms are not automatically a rate-limit problem. Before tuning
pacing, cooldowns, or intervals, confirm the credential is actually being
honoured — an endpoint that answers `200` can still be serving you anonymously.