# Roblox Tracker

Telegram bot that tracks Roblox presence, friends, and game sessions for a connected Roblox account.

Long-polls Telegram via [grammY](https://grammy.dev), polls the Roblox API in background workers, and persists normalized session history in MySQL through Prisma.

## Features

- **Account linking** — `/setcookie` validates a `.ROBLOSECURITY` cookie against `users.roblox.com`, encrypts it (AES-256-GCM), and stores it. The message containing the cookie is deleted immediately.
- **Friend sync** — diffs the live Roblox friend list against the DB (add / remove / unchanged) and refreshes cached usernames. Runs on demand (`/sync`) and on a 20-minute worker cycle.
- **Manual tracking** — `/track` / `/untrack` follow arbitrary Roblox users that are not friends. `Friend` and `TrackedUser` are deliberately kept separate.
- **Presence polling** — every 15 s, batches presence for friends + tracked users (100 IDs/request), detects offline → online, online → offline, and game start/change transitions.
- **Session history** — records lifecycle events only (start / change / end), never raw poll results. Both game sessions and presence sessions (offline/website/in-game/studio) carry computed durations.
- **Notifications** — per-subject toggles for `online`, `offline`, and `game` events, with a 10 s debounce against state flicker. Friends default to all-off (opt-in); tracked users default to `online` + `game` on, `offline` off. Includes a "Join Game" deep link when a place and server ID are known.
- **Analytics** — `/status` (who is active now), `/stats` (playtime + presence breakdown over 7 d / 30 d / all time), `/history` (per-day sessions with pagination, or `all`), `/badges` (recent badges with award dates). `/status` reads the open `GameSession` / `PresenceSession` rows, so a session only appears once its *closing* poll writes `endTime` for the previous one — new sessions are appended asynchronously and may lag the current poll cycle.
- **Admin view** — Telegram IDs in `ADMIN_USER_IDS` get the aggregate view across every connected account on `/status`, `/stats`, `/history`, and `/list`.

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js, ESM (`"type": "module"`) |
| Language | TypeScript 5.9, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| Bot | grammY (long polling) |
| Database | MySQL via Prisma 7 with the `@prisma/adapter-mariadb` driver adapter |
| HTTP | axios with retry/backoff wrapper |
| Dev runner | tsx |

## Requirements

- Node.js `^20.19 || ^22.12 || >=24.0` — the range Prisma 7 declares in its `engines` field (ESM throughout, `node:crypto`, `Intl` with the `Asia/Jakarta` time zone)
- A MySQL-compatible database
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- One or more Roblox accounts whose `.ROBLOSECURITY` cookie can be provided

## Setup

```bash
npm install
cp .env.example .env      # then fill in the values below
npx prisma migrate deploy # apply migrations
npx prisma generate       # emits the client into src/generated/prisma
npm run dev
```

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `BOT_TOKEN` | yes | Telegram bot token |
| `DATABASE_URL` | yes | MySQL connection string, e.g. `mysql://user:pass@localhost:3306/roblox_tracker?timezone=Z` |
| `ENCRYPTION_KEY` | recommended | Passphrase for cookie encryption. **Changing it makes every stored cookie undecryptable.** Falls back to a hard-coded development default — never run production without it. |
| `ADMIN_USER_IDS` | no | Comma-separated Telegram user IDs granted the cross-account admin view |
| `NODE_ENV` | no | `development` (default) or `production` |

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Run `src/index.ts` under tsx with watch mode |
| `npm run build` | Type-check and emit to `dist/` (`tsc`) |
| `npm start` | Run the compiled entry point (`dist/index.js`) |

## Commands

| Command | Usage | Description |
| --- | --- | --- |
| `/start` | `/start` | Welcome message and command overview |
| `/help` | `/help` | Command reference |
| `/setcookie` | `/setcookie <cookie>` | Connect a Roblox account and trigger the first friend sync |
| `/sync` | `/sync` | Manually diff and re-sync the friend list |
| `/status` | `/status` | Currently active sessions (in-game and on the website) |
| `/track` | `/track <username>` | Track a user who is not your friend |
| `/untrack` | `/untrack <username>` | Stop tracking a user |
| `/list` | `/list`, `/tracked` | List manually tracked users |
| `/notify` | `/notify <username> [online\|offline\|game\|all]` | Enable notification filters |
| `/unnotify` | `/unnotify <username> [online\|offline\|game\|all]` | Disable notification filters |
| `/stats` | `/stats [username] [7d\|30d\|all]` | Playtime and presence breakdown |
| `/history` | `/history [username] [DD-MM-YYYY\|all]` | Session history, paginated inline |
| `/badges` | `/badges [username]` | Recent badges with award dates; defaults to the connected account's own username. For a target that is a friend of some connected account, the friend's cookie is preferred (friend-only badge visibility). Paginated inline via an in-memory cursor cache |

`/start` and `/help` are the only commands that work without a connected account. `/setcookie` is what connects one. `/status`, `/stats`, `/history`, and `/list` bypass the account check for callers in `ADMIN_USER_IDS` and then aggregate across all connected accounts; `/track`, `/untrack`, `/notify`, `/unnotify`, `/sync`, and `/badges` always require a connected account, even for admins. `/list` also answers to `/tracked`.

## Architecture

```
Telegram ──long poll──▶ grammY bot (src/bot)
                          │ commands → services
                          ▼
                     services (src/services)
        roblox · account · sync · presence · session
        analytics · notification
                          │
                          ▼
              Prisma client → MySQL
                          ▲
                     workers (src/workers)
        presence.worker 15 s   sync.worker 20 min
```

### Layout

```
src/
  index.ts                 # boot: DB check, bot creation, workers, graceful shutdown
  migrate-old-data.ts      # one-off importer for legacy JSON data
  bot/
    index.ts               # bot construction, error handler, command registration
    commands/              # one file per command
  services/
    roblox/                # all Roblox API calls + response types
    account/               # Telegram user upsert, cookie validate/encrypt/store
    sync/                  # friend-list diffing
    presence/              # polling loop + change detection; manual tracking
    session/               # game/presence session lifecycle
    analytics/             # read-side queries for /status, /stats, /history
    notification/          # Telegram delivery, toggles, debounce
  workers/                 # interval schedulers for presence + sync
  lib/                     # env, prisma client, crypto, http retry wrapper, date formatting
  generated/prisma/        # Prisma-generated client (checked in)
prisma/
  schema.prisma            # models, enums, indexes
  migrations/              # SQL migrations
```

### Workers

Both workers are started by `src/index.ts` and stopped on `SIGINT`/`SIGTERM`. Each guards against overlapping cycles with a busy flag — a slow cycle skips the next tick instead of stacking.

- **`presence.worker`** — 15 s interval. `presenceService.pollAllPresence()` iterates connected accounts, decrypts the cookie, dedupes friend + tracked user IDs, batches presence requests, and dispatches state changes.
- **`sync.worker`** — 20 min interval. Runs a friend sync per account and messages the owner only when friends were actually added or removed.

### Roblox API usage

All calls go through `services/roblox/roblox.service.ts`, which injects the cookie per request, batches at 100 IDs, and returns typed results (never raw axios payloads). `lib/http.ts` adds exponential-backoff retry (3 attempts, 1 s base) on 429, 5xx, and network errors. Endpoints used:

- `GET users.roblox.com/v1/users/authenticated`
- `GET friends.roblox.com/v1/users/{userId}/friends`
- `POST users.roblox.com/v1/users`, `POST users.roblox.com/v1/usernames/users`
- `POST presence.roblox.com/v1/presence/users`
- `GET badges.roblox.com/v1/users/{userId}/badges`, `.../badges/awarded-dates`

## Data model

| Model | Role |
| --- | --- |
| `TelegramUser` | One Telegram account; `telegramId` unique |
| `RobloxAccount` | The linked Roblox identity — at most one per Telegram user. Holds the encrypted cookie |
| `Friend` | Friends pulled from the Roblox API, with presence cache and notification toggles |
| `TrackedUser` | Manually tracked users, with the same cache and toggle shape |
| `GameSession` | Game lifecycle records (`startTime`, `endTime`, `duration`, place/universe/server IDs) |
| `PresenceSession` | Presence lifecycle records (`0`=offline, `1`=website, `2`=in-game, `3`=studio) |

`GameSession.subjectType` and `PresenceSession.subjectType` are `SessionSubjectType` (`FRIEND` | `TRACKED`) and identify which table the subject came from. Deleting a `RobloxAccount` cascades to all of its friends, tracked users, and sessions.

Presence state is cached on the subject rows (`lastPresence`, `lastGameId`, `lastLocation`, `lastSeenAt`) so change detection needs no extra query, and `lastNotifiedAt` drives notification debounce.

## Security notes

- The `.ROBLOSECURITY` cookie is a full-account credential. It is encrypted with AES-256-GCM (`iv:authTag:ciphertext`, hex) before storage and decrypted only in memory at call time.
- The key is derived from `ENCRYPTION_KEY`, zero-padded/truncated to 32 bytes. This is a passphrase-derived key without a KDF — treat the env var as a secret and restrict DB access.
- `/setcookie` deletes the originating Telegram message best-effort (weaker in group chats) and tells the user to keep the cookie private; the cookie is equivalent to an account password.
- When logs from the bot or DB may leak, rotate the Roblox session (log out all sessions) rather than only changing the cookie in the message.

## Legacy data import

`src/migrate-old-data.ts` imports a legacy `old-data.json` (per-user game history) into `TrackedUser` and `GameSession` rows. It targets a hard-coded `robloxAccountId` and expects `old-data.json` in the project root. Run it manually with tsx; it is not part of the normal startup path.
