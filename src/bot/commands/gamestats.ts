/**
 * /gamestats — per-game playtime statistics for the requesting user's scope.
 *
 * Usage:
 *   /gamestats <roblox game URL or place id> [most] [user:<username>]
 *
 * Scope is strictly the requester's own account: the RobloxAccount derived from
 * `ctx.from.id`, intersected with that account's current friends and tracked
 * users. Admin cross-account aggregation is deliberately NOT enabled here.
 *
 * The command is read-only: it never writes sessions, never changes presence,
 * and the callback path makes no Roblox API calls at all (a game's display name
 * comes from the resolver cache, then the latest stored `GameSession.gameName`,
 * then a synthetic `Game <universeId>`).
 */

import { Bot, InlineKeyboard, type Context } from 'grammy';
import { accountService } from '../../services/account/account.service.js';
import {
  gameStatsService,
  mergeAdjacentSessions,
  orderMergedSessions,
  type MergedSession,
  type ScopeContext,
} from '../../services/analytics/gamestats.service.js';
import { gameResolver } from '../../services/roblox/game-resolver.js';
import { computeStatsWindows } from '../../lib/window.js';
import { formatWIB, formatDuration } from '../../lib/date.js';
import { escapeHtml } from '../../lib/html.js';
import { env } from '../../lib/env.js';
import { prisma } from '../../lib/prisma.js';

// ── URL parsing ───────────────────────────────────────────────────────────────

/**
 * Extracts a Roblox place id from a game URL or a bare numeric id.
 *
 * Accepted forms (case-insensitive host, optional regional prefix, optional
 * query string / fragment, optional trailing slash):
 *   - https://www.roblox.com/games/77843161404023/Run-a-Restaurant
 *   - https://www.roblox.com/es/games/77843161404023
 *   - roblox.com/games/77843161404023?foo=bar
 *   - 77843161404023
 *
 * Returns null for anything that is not a Roblox game reference.
 */
export function parsePlaceId(input: string): bigint | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  // Bare numeric place id.
  if (/^\d+$/.test(trimmed)) return BigInt(trimmed);

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host !== 'roblox.com' && !host.endsWith('.roblox.com')) return null;

  // Path may carry a regional prefix: /es/games/<id>/... or /games/<id>/...
  const match = url.pathname.match(/(?:^|\/)games\/(\d+)(?:\/|$)/i);
  if (!match || !match[1]) return null;

  return BigInt(match[1]);
}

export interface ParsedArgs {
  placeId: bigint;
  most: boolean;
  userFilter: string | null;
}

export type ParseResult =
  | { ok: true; args: ParsedArgs }
  | { ok: false; error: string };

/**
 * Parses command arguments. The first token must be the game reference; the
 * remaining tokens are options (`most`, `user:<name>`), case-insensitive and in
 * any order. Unknown option tokens are rejected rather than absorbed into the
 * game reference.
 */
export function parseArgs(match: string | undefined): ParseResult {
  const tokens = (match ?? '').trim().split(/\s+/).filter((t) => t !== '');
  if (tokens.length === 0) {
    return { ok: false, error: 'Please provide a Roblox game URL or place id.' };
  }

  const first = tokens[0] as string;
  const placeId = parsePlaceId(first);
  if (placeId === null) {
    return { ok: false, error: `"${first}" is not a Roblox game URL or place id.` };
  }

  let most = false;
  let userFilter: string | null = null;

  for (const token of tokens.slice(1)) {
    const lowered = token.toLowerCase();
    if (lowered === 'most') {
      most = true;
    } else if (lowered.startsWith('user:')) {
      const name = token.slice(5).replace(/^@/, '').trim();
      if (name === '') {
        return { ok: false, error: 'user: needs a username, e.g. user:Agil' };
      }
      userFilter = name;
    } else {
      return { ok: false, error: `Unknown option "${token}".` };
    }
  }

  return { ok: true, args: { placeId, most, userFilter } };
}

// ── Scope ─────────────────────────────────────────────────────────────────────

interface ScopeSubject {
  subjectId: bigint;
  username: string | null;
  displayName: string | null;
  /** 'tracked' takes precedence when a user is both a friend and tracked. */
  kind: 'tracked' | 'friend';
}

/**
 * Builds the scope for one account: its current friends ∪ tracked users.
 * Never crosses into another Telegram user's account.
 */
async function loadScopeSubjects(accountId: number): Promise<Map<bigint, ScopeSubject>> {
  const [friends, tracked] = await Promise.all([
    prisma.friend.findMany({
      where: { robloxAccountId: accountId },
      select: { friendUserId: true, username: true, displayName: true },
    }),
    prisma.trackedUser.findMany({
      where: { robloxAccountId: accountId },
      select: { robloxUserId: true, username: true, displayName: true },
    }),
  ]);

  const map = new Map<bigint, ScopeSubject>();
  for (const f of friends) {
    map.set(f.friendUserId, {
      subjectId: f.friendUserId,
      username: f.username,
      displayName: f.displayName,
      kind: 'friend',
    });
  }
  // Tracked wins on conflict: presence polling already dedups this way.
  for (const t of tracked) {
    map.set(t.robloxUserId, {
      subjectId: t.robloxUserId,
      username: t.username,
      displayName: t.displayName,
      kind: 'tracked',
    });
  }
  return map;
}

/** Case-insensitive match on username or displayName, `@` stripped. Never calls Roblox. */
function findSubjectByName(
  subjects: Map<bigint, ScopeSubject>,
  name: string,
): ScopeSubject | null {
  const needle = name.replace(/^@/, '').toLowerCase();
  for (const subject of subjects.values()) {
    const fields = [subject.username, subject.displayName].filter(
      (v): v is string => typeof v === 'string',
    );
    if (fields.some((v) => v.toLowerCase() === needle)) return subject;
  }
  return null;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/** Formats a large seconds total as "N.N h" player-hours. */
function formatHours(seconds: number): string {
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** Human label for a subject, e.g. "Agil (@agil)". Escaped for HTML. */
function subjectLabel(subject: ScopeSubject | undefined, subjectId: bigint): string {
  if (!subject) return subjectId.toString();
  const display = subject.displayName ?? subject.username ?? subjectId.toString();
  const handle = subject.username ? ` (@${subject.username})` : '';
  return escapeHtml(`${display}${handle}`);
}

/** "3 h ago" / "2 d ago" relative to `now`. */
function relativeTime(when: Date, now: Date): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - when.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

export const PAGE_SIZE = 10;

// ── Message building ──────────────────────────────────────────────────────────

interface BuiltMessage {
  text: string;
  keyboard: InlineKeyboard | null;
}

interface RenderContext {
  accountId: number;
  universeId: bigint;
  gameName: string;
  placeId: bigint;
  most: boolean;
  /** Present only in `user:` mode. */
  userSubject: ScopeSubject | null;
  page: number;
  now: Date;
  /**
   * The Telegram id of the user this message belongs to. Embedded in every
   * button's callback_data so the handler can enforce owner-only presses. This
   * MUST be the presser/requester's `ctx.from.id` (the same source the handler
   * checks against) — never a DB id, a chat id, or the bot's own id.
   */
  ownerTelegramId: string;
}

/** Resolves the name to display: cache → stored session name → synthetic. */
async function resolveGameName(
  accountId: number,
  universeId: bigint,
  placeId: bigint,
  cachedName: string | null,
): Promise<string> {
  if (cachedName) return cachedName;
  const latest = await prisma.gameSession.findFirst({
    where: { robloxAccountId: accountId, universeId },
    orderBy: { startTime: 'desc' },
    select: { gameName: true },
  });
  if (latest?.gameName) return latest.gameName;
  return `Game ${universeId.toString()}`;
}

async function buildSummaryMode(scope: ScopeContext, subjects: Map<bigint, ScopeSubject>, ctx: RenderContext): Promise<BuiltMessage> {
  const windows = computeStatsWindows(ctx.now, env.TZ_NAME);
  const totals = await gameStatsService.getWindowTotals(scope, ctx.universeId, windows);

  if (totals.playerCount === 0) {
    return {
      text: `🎮 <b>${escapeHtml(ctx.gameName)}</b>\n\n📭 No sessions recorded for this game yet.`,
      keyboard: null,
    };
  }

  const page = await gameStatsService.getPlayerPage(
    scope,
    ctx.universeId,
    ctx.most ? 'most' : 'recent',
    PAGE_SIZE,
    ctx.page * PAGE_SIZE,
    env.GAMESTATS_MAX_SESSION_HOURS * 3600,
  );

  const totalPages = Math.max(1, Math.ceil(page.total / PAGE_SIZE));
  const sinceStr = totals.firstSeen ? formatWIB(totals.firstSeen) : 'unknown';

  const lines: string[] = [
    `🎮 <b>${escapeHtml(ctx.gameName)}</b>`,
    `<i>Tracked since ${sinceStr} — player-hours, not lifetime Roblox playtime</i>`,
    '',
    `⏱ <b>Total played — ${formatHours(totals.allSeconds)} player-hours</b>`,
    `• All time: ${formatHours(totals.allSeconds)}`,
    `• Today: ${formatHours(totals.todaySeconds)}`,
    `• Last 7 days: ${formatHours(totals.last7Seconds)}`,
    `• Last 30 days: ${formatHours(totals.last30Seconds)}`,
    '',
    ctx.most ? `👥 <b>Top players</b>` : `👥 <b>Recent players</b>`,
  ];

  const rankOffset = ctx.page * PAGE_SIZE;
  for (let i = 0; i < page.players.length; i++) {
    const p = page.players[i] as (typeof page.players)[number];
    const subject = subjects.get(p.subjectId);
    const kind = subject?.kind === 'tracked' ? 'tracked' : 'friend';
    const when = p.stillPlaying ? 'still playing' : relativeTime(p.lastSeenAt, ctx.now);
    lines.push(
      `${rankOffset + i + 1}. ${subjectLabel(subject, p.subjectId)} — ${formatHours(p.totalSeconds)} — ${when} <i>[${kind}]</i>`,
    );
  }

  const footer = await buildFooter(scope, ctx.universeId, ctx.placeId, page.players);
  if (footer) lines.push('', footer);

  return {
    text: lines.join('\n'),
    keyboard: buildKeyboard(ctx, totalPages),
  };
}

async function buildUserMode(scope: ScopeContext, subjects: Map<bigint, ScopeSubject>, ctx: RenderContext): Promise<BuiltMessage> {
  const userSubject = ctx.userSubject;
  if (!userSubject) {
    return { text: '❌ Internal error: user mode without a subject.', keyboard: null };
  }

  const windows = computeStatsWindows(ctx.now, env.TZ_NAME);
  const totals = await gameStatsService.getWindowTotals(scope, ctx.universeId, windows, userSubject.subjectId);

  const raw = await gameStatsService.getUserSessions(
    scope,
    ctx.universeId,
    userSubject.subjectId,
    env.GAMESTATS_USER_SESSION_FETCH_CAP,
  );
  const merged = orderMergedSessions(
    mergeAdjacentSessions(raw, env.GAMESTATS_MERGE_GAP_SECONDS),
    ctx.most ? 'most' : 'recent',
  );

  const label = subjectLabel(userSubject, userSubject.subjectId);
  const totalPages = Math.max(1, Math.ceil(merged.length / PAGE_SIZE));
  const slice = merged.slice(ctx.page * PAGE_SIZE, ctx.page * PAGE_SIZE + PAGE_SIZE);

  const sinceStr = totals.firstSeen ? formatWIB(totals.firstSeen) : 'unknown';
  const lines: string[] = [
    `🎮 <b>${escapeHtml(ctx.gameName)}</b> · ${label}`,
    `<i>Tracked since ${sinceStr}</i>`,
    '',
    `⏱ <b>${label}'s time in this game — ${formatHours(totals.allSeconds)} player-hours</b>`,
    `• All time: ${formatHours(totals.allSeconds)}`,
    `• Today: ${formatHours(totals.todaySeconds)}`,
    `• Last 7 days: ${formatHours(totals.last7Seconds)}`,
    `• Last 30 days: ${formatHours(totals.last30Seconds)}`,
    '',
    ctx.most ? `🕓 <b>Sessions (longest first)</b>` : `🕓 <b>Sessions (newest first)</b>`,
  ];

  if (merged.length === 0) {
    lines.push('<i>No sessions recorded.</i>');
  }
  for (const session of slice) {
    lines.push(renderSessionLine(session, ctx.now));
  }

  const footer = await buildFooter(scope, ctx.universeId, ctx.placeId, []);
  if (footer) lines.push('', footer);

  return {
    text: lines.join('\n'),
    keyboard: buildKeyboard(ctx, totalPages),
  };
}

function renderSessionLine(session: MergedSession, now: Date): string {
  const start = formatWIB(session.startTime);
  const end = session.open ? 'now' : formatWIB(session.endTime);
  const mergedNote = session.parts > 1 ? ` <i>(merged ×${session.parts})</i>` : '';
  return `• ${start} → ${end} — ${formatDuration(session.seconds)}${mergedNote}`;
}

/**
 * Builds the optional footer. It must make every exclusion/cap visible:
 *  - how many sessions were excluded for lacking an experience id;
 *  - whether any session exceeded the sanity threshold (flagged only).
 */
async function buildFooter(
  scope: ScopeContext,
  universeId: bigint,
  placeId: bigint,
  players: Array<{ hasLongSession: boolean }>,
): Promise<string | null> {
  const notes: string[] = [];

  const legacyCount = await gameStatsService.countLegacyRows(scope, universeId, [placeId]);
  if (legacyCount > 0) {
    notes.push(`${legacyCount} older session(s) without an experience id excluded.`);
  }

  if (players.some((p) => p.hasLongSession)) {
    notes.push(
      `Some sessions exceed ${env.GAMESTATS_MAX_SESSION_HOURS}h and may include monitoring gaps.`,
    );
  }

  return notes.length > 0 ? `<i>ℹ️ ${notes.join(' ')}</i>` : null;
}

/**
 * Builds the Prev/Next keyboard. Telegram cannot disable inline buttons, so the
 * unusable direction is omitted; the page chip is a no-op button.
 *
 * `callback_data` layout (all compact, ≤64 bytes):
 *   gs:<universeId>:<placeId>:<mode 0|1>:<sort 0|1>:<subjectId|->:<page>:<tgId>
 */
function buildKeyboard(ctx: RenderContext, totalPages: number): InlineKeyboard | null {
  const kb = new InlineKeyboard();
  const page = ctx.page;
  const hasPrev = page > 0;
  const hasNext = page + 1 < totalPages;

  const data = (target: number) =>
    buildCallbackData({
      universeId: ctx.universeId,
      placeId: ctx.placeId,
      userMode: ctx.userSubject !== null,
      most: ctx.most,
      subjectId: ctx.userSubject?.subjectId ?? null,
      page: target,
      telegramId: ctx.ownerTelegramId,
    });

  if (hasPrev) kb.text('« Prev', data(page - 1));
  kb.text(`${page + 1}/${totalPages}`, 'gs:noop');
  if (hasNext) kb.text('Next »', data(page + 1));

  // Single-page results have no navigation and no useful chip: omit entirely.
  if (totalPages <= 1) return null;
  return kb;
}

export interface CallbackParts {
  universeId: bigint;
  placeId: bigint;
  userMode: boolean;
  most: boolean;
  subjectId: bigint | null;
  page: number;
}

/**
 * Encodes callback data. The owner telegram id is appended so the callback
 * handler can reject a forged press. Kept well under Telegram's 64-byte cap by
 * using single-char flags and never embedding a username.
 */
export function buildCallbackData(input: {
  universeId: bigint;
  placeId: bigint;
  userMode: boolean;
  most: boolean;
  subjectId: bigint | null;
  page: number;
  telegramId?: string;
}): string {
  const parts = [
    'gs',
    input.universeId.toString(),
    input.placeId.toString(),
    input.userMode ? '1' : '0',
    input.most ? '1' : '0',
    input.subjectId === null ? '-' : input.subjectId.toString(),
    String(input.page),
    input.telegramId ?? '',
  ];
  return parts.join(':');
}

/** Parses callback data. Returns null on any malformed input. */
export function parseCallbackData(data: string): (CallbackParts & { telegramId: string }) | null {
  const parts = data.split(':');
  if (parts.length !== 8 || parts[0] !== 'gs') return null;
  const [, universeId, placeId, userMode, most, subjectId, page, telegramId] = parts;
  if (!/^\d+$/.test(universeId ?? '')) return null;
  if (!/^\d+$/.test(placeId ?? '')) return null;
  if (!/^\d+$/.test(page ?? '')) return null;
  if (userMode !== '0' && userMode !== '1') return null;
  if (most !== '0' && most !== '1') return null;
  if (subjectId !== '-' && !/^\d+$/.test(subjectId ?? '')) return null;
  return {
    universeId: BigInt(universeId as string),
    placeId: BigInt(placeId as string),
    userMode: userMode === '1',
    most: most === '1',
    subjectId: subjectId === '-' ? null : BigInt(subjectId as string),
    page: Number.parseInt(page as string, 10),
    telegramId: telegramId ?? '',
  };
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/**
 * Optional state carried from callback data, so a callback press rebuilds the
 * exact same view without re-resolving anything against Roblox.
 */
export interface RenderReuse {
  universeId: bigint;
  subjectId: bigint | null;
  /** Display name resolved at command time (cache fallback already applied). */
  gameName: string | null;
}

/** Shared entry: builds the message for a given account + parsed options. */
async function renderForAccount(
  accountId: number,
  ownerTelegramId: string,
  parsed: ParsedArgs,
  page: number,
  now: Date,
  reuse?: RenderReuse,
): Promise<BuiltMessage> {
  let universeId: bigint;
  let placeId: bigint;
  let cachedName: string | null;

  if (reuse) {
    // Callback path: everything comes from the message, never from Roblox.
    universeId = reuse.universeId;
    placeId = parsed.placeId;
    cachedName = reuse.gameName;
  } else {
    const resolved = await gameResolver.resolve(parsed.placeId);
    if (resolved.status === 'error') {
      return {
        text: '⚠️ Roblox is unreachable right now. Please try again shortly.',
        keyboard: null,
      };
    }
    if (resolved.status === 'not_found') {
      return {
        text: `❌ Couldn't resolve that Roblox game (place <code>${parsed.placeId.toString()}</code>).`,
        keyboard: null,
      };
    }
    universeId = resolved.universeId;
    placeId = resolved.placeId;
    cachedName = resolved.name;
  }

  const subjects = await loadScopeSubjects(accountId);

  let userSubject: ScopeSubject | null = null;
  if (reuse && reuse.subjectId !== null) {
    userSubject = subjects.get(reuse.subjectId) ?? {
      subjectId: reuse.subjectId,
      username: null,
      displayName: null,
      kind: 'friend',
    };
  } else if (parsed.userFilter !== null) {
    userSubject = findSubjectByName(subjects, parsed.userFilter);
    if (!userSubject) {
      return {
        text: `🔍 User "<b>${escapeHtml(parsed.userFilter)}</b>" not found in your tracked friends or users.`,
        keyboard: null,
      };
    }
  }

  const scope: ScopeContext = {
    accountId,
    subjectIds: [...subjects.keys()],
    now,
  };

  const gameName = await resolveGameName(accountId, universeId, placeId, cachedName);

  const renderCtx: RenderContext = {
    accountId,
    universeId,
    gameName,
    placeId,
    most: parsed.most,
    userSubject,
    page,
    now,
    ownerTelegramId,
  };

  if (userSubject) return buildUserMode(scope, subjects, renderCtx);
  return buildSummaryMode(scope, subjects, renderCtx);
}

/** Sends an HTML message, with or without a keyboard. */
async function replyHtml(ctx: Context, msg: BuiltMessage): Promise<void> {
  if (msg.keyboard) {
    await ctx.reply(msg.text, { parse_mode: 'HTML', reply_markup: msg.keyboard });
  } else {
    await ctx.reply(msg.text, { parse_mode: 'HTML' });
  }
}

/** Why a callback press was rejected. Never carries credential material. */
export type CallbackRejectionReason = 'owner_mismatch' | 'malformed' | 'stale_or_out_of_scope';

/**
 * Emits one warn-level line per rejected callback press, so a rejection is never
 * silent again. Logs only ids and a short reason — never anything cookie-related
 * (the callback path never touches the cookie at all).
 */
function logCallbackRejection(
  reason: CallbackRejectionReason,
  presserId: string,
  data: string,
  parsed?: { telegramId: string; page: number; userMode: boolean; most: boolean },
  extra?: string,
): void {
  const parts = [
    `reason=${reason}`,
    `presser=${presserId}`,
    `encoded=${parsed ? parsed.telegramId : '<unparsed>'}`,
    `page=${parsed ? parsed.page : '?'}`,
    `mode=${parsed ? (parsed.userMode ? 'user' : 'all') : '?'}`,
    `sort=${parsed ? (parsed.most ? 'most' : 'recent') : '?'}`,
  ];
  if (extra) parts.push(`detail=${extra}`);
  // Include the raw data length (not the data itself) to aid triage without
  // dumping user ids/place ids into logs verbatim beyond what is needed.
  parts.push(`dataLen=${data.length}`);
  console.warn(`[GameStats] callback rejected: ${parts.join(' ')}`);
}

/**
 * Resolves the RobloxAccount for the *pressing/sending* telegram id. Returns null
 * (and the caller replies) when the user has no connected account.
 */
async function requireAccountId(ctx: Context): Promise<number | null> {
  const telegramId = String(ctx.from?.id ?? '');
  if (telegramId === '') {
    await ctx.reply('⚠️ Could not identify your Telegram account.', { parse_mode: 'HTML' });
    return null;
  }
  const account = await accountService.getAccount(telegramId);
  if (!account) {
    await ctx.reply('⚠️ No account connected. Use <code>/setcookie &lt;cookie&gt;</code> first.', {
      parse_mode: 'HTML',
    });
    return null;
  }
  return account.id;
}

export function registerGameStatsCommand(bot: Bot): void {
  bot.command('gamestats', async (ctx) => {
    const ownerTelegramId = String(ctx.from?.id ?? '');
    const parsed = parseArgs(ctx.match);
    if (!parsed.ok) {
      await ctx.reply(
        `⚠️ ${escapeHtml(parsed.error)}\n\nUsage: <code>/gamestats &lt;game URL&gt; [most] [user:&lt;name&gt;]</code>`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    const accountId = await requireAccountId(ctx);
    if (accountId === null) return;

    const msg = await renderForAccount(accountId, ownerTelegramId, parsed.args, 0, new Date());
    await replyHtml(ctx, msg);
  });

  bot.callbackQuery(/^gs:.*$/, async (ctx) => {
    const presserId = String(ctx.from?.id ?? '');
    const data = ctx.callbackQuery.data ?? '';

    if (data === 'gs:noop') {
      await ctx.answerCallbackQuery();
      return;
    }

    const parsed = parseCallbackData(data);
    if (!parsed) {
      logCallbackRejection('malformed', presserId, data);
      await ctx.answerCallbackQuery('This button is out of date.');
      return;
    }

    // Owner check: the id encoded at render time must equal the presser's
    // Telegram id. Both sides are strings from ctx.from.id.
    if (parsed.telegramId !== presserId) {
      logCallbackRejection('owner_mismatch', presserId, data, parsed);
      await ctx.answerCallbackQuery("This isn't your message.");
      return;
    }

    // Scope account is derived from the presser, never from callback data.
    const account = await accountService.getAccount(presserId);
    if (!account) {
      logCallbackRejection('stale_or_out_of_scope', presserId, data, parsed, 'no account');
      await ctx.answerCallbackQuery('No account connected.');
      return;
    }

    // Rebuild with ids from the callback; the display name is re-derived from
    // the resolver cache or the stored session name — never a Roblox call.
    const args: ParsedArgs = {
      placeId: parsed.placeId,
      most: parsed.most,
      userFilter: null,
    };
    const reusedName = gameResolver.cachedNameForPlace(parsed.placeId);
    const rebuilt = await renderForAccount(
      account.id,
      presserId,
      args,
      parsed.page,
      new Date(),
      {
        universeId: parsed.universeId,
        subjectId: parsed.subjectId,
        gameName: reusedName,
      },
    );
    try {
      if (rebuilt.keyboard) {
        await ctx.editMessageText(rebuilt.text, { parse_mode: 'HTML', reply_markup: rebuilt.keyboard });
      } else {
        await ctx.editMessageText(rebuilt.text, { parse_mode: 'HTML' });
      }
    } catch (err) {
      const description = (err as { description?: string }).description ?? '';
      if (!description.includes('message is not modified')) {
        console.error('[GameStats] editMessageText failed:', description || (err as Error).message);
      }
    }
    await ctx.answerCallbackQuery();
  });
}
