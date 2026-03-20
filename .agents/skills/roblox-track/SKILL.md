Here’s a clean, production-ready **`SKILL.md`** for your project 👇
(optimized for **TypeScript + grammy + Prisma + Roblox APIs**)

---

````markdown
---
name: roblox-presence-telegram-bot
description: Handles building and maintaining a Telegram bot that tracks Roblox user presence, friends, and game sessions using TypeScript, grammy, and Prisma. Use when implementing bot commands, syncing friends, tracking presence, or managing notifications.
---

# Roblox Presence Telegram Bot Skill

This skill provides guidance for implementing a Telegram bot that tracks Roblox user activity, including presence, friends, notifications, and gameplay history.

The stack used:
- **TypeScript**
- **grammy (Telegram bot framework)**
- **Prisma (MySQL ORM)**
- Roblox APIs:
  - `/users/authenticated`
  - `/friends`
  - `/presence/users`
  - `/users` (batch)

---

## When to use this skill

- Use this when building or modifying Telegram bot features
- Use this when implementing Roblox API integrations
- Use this when handling presence tracking, syncing, or notifications
- Use this when working with Prisma models and database logic
- Use this when implementing polling workers or background jobs

---

## How to use it

### 1. Project Structure Conventions

Follow this structure:

```text
src/
  bot/
    commands/
    handlers/
  services/
    roblox/
    sync/
    presence/
  workers/
  lib/
  prisma/
````

---

### 2. Telegram Bot (grammy)

* Use `grammy` for all bot interactions
* Commands must be modular (one file per command)

Example:

```ts
bot.command("sync", async (ctx) => {
  await ctx.reply("🔄 Syncing your friends...")
  await enqueueSync(ctx.from.id)
})
```

---

### 3. Roblox API Integration

#### Authentication

Always send cookie:

```ts
headers: {
  Cookie: `.ROBLOSECURITY=${cookie}`
}
```

---

#### Required APIs

* Get current user:

```http
GET /v1/users/authenticated
```

* Get friends:

```http
GET /v1/users/{userId}/friends
```

* Batch user info:

```http
POST /v1/users
```

* Presence:

```http
POST /v1/presence/users
```

---

### 4. Database (Prisma)

#### Core Models

* `TelegramUser`
* `RobloxAccount`
* `Friend`
* `TrackedUser`
* `GameSession`

---

#### Rules

* One Telegram user → one Roblox account
* `Friend` = only data from Roblox API
* `TrackedUser` = manually tracked users
* Do NOT mix both

---

### 5. Friend Sync Logic

#### Steps:

1. Fetch current DB friends
2. Fetch API friends
3. Compute diff:

   * added
   * removed
4. Apply:

   * upsert new
   * delete removed

---

#### Important:

* Never overwrite blindly
* Always diff before update
* Only notify if changes exist

---

### 6. Presence Tracking

#### Polling

* Interval: **10–20 seconds**
* Batch max: **100 users/request**

---

#### Data Source

Combine:

```ts
friends + trackedUsers
```

Deduplicate IDs before request.

---

#### Compare State

Track:

```ts
lastPresence
lastGameId
```

---

#### Trigger Events

* Offline → Online
* Online → Offline
* Game change

---

### 7. Game Session Tracking

#### DO:

Track lifecycle events:

* start game
* stop game
* change game

---

#### DO NOT:

* Store every polling result ❌

---

#### Logic:

```ts
if (oldPresence !== 2 && newPresence === 2) {
  // start session
}

if (oldGameId !== newGameId) {
  // end old + start new
}

if (oldPresence === 2 && newPresence !== 2) {
  // end session
}
```

---

### 8. Notification System

#### Rules:

* Default: OFF
* Per-user control
* Debounce (5–10 seconds)

---

#### Types:

* Online
* Offline
* Game start/change

---

#### Never:

* Spam repeated notifications
* Notify unchanged state

---

### 9. Sync System

#### Automatic Sync

Trigger on:

* `/setcookie`

---

#### Scheduled Sync

* Interval: 10–30 minutes
* Notify only if:

  * friend added
  * friend removed

---

#### Manual Sync

```text
/sync
```

* Always return result (even no changes)

---

### 10. Background Workers

Use workers for:

* friend sync
* presence polling
* session tracking

---

#### Best Practice:

* Do NOT block bot handlers
* Use queue system (e.g. BullMQ)

---

### 11. Performance Rules

* Batch all API requests
* Cache usernames in DB
* Avoid repeated API calls
* Use indexed fields in Prisma
* Use `select` instead of full fetch

---

### 12. Security

* Encrypt `.ROBLOSECURITY` before storing
* Never expose cookies
* Validate user ownership before actions

---

### 13. Error Handling

* Retry failed API calls
* Handle rate limits
* Gracefully skip failed users
* Log all failures

---

### 14. Coding Style

* Use async/await
* Keep services separated
* Avoid logic inside command handlers
* Use typed responses (TypeScript interfaces)

---

## Summary

This skill ensures the agent:

* Builds a scalable Telegram bot using grammy
* Integrates Roblox APIs correctly
* Tracks presence efficiently
* Stores only meaningful data (session-based)
* Avoids API abuse and DB overload
* Provides clean UX with minimal spam

The system should always prioritize:

* efficiency
* correctness
* scalability
* clean separation of concerns

```
