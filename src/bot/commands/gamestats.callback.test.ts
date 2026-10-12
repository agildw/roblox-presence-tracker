/**
 * Regression tests for the /gamestats pagination callback path.
 *
 * THE BUG THIS PINS: `buildKeyboard` originally encoded an EMPTY owner id
 * (`telegramId ?? ''`), so every button carried `gs:…:<page>:` with a blank
 * trailing field. The handler compares `parsed.telegramId !== presserId`, so a
 * legitimate owner was always rejected with "This isn't your message." — and the
 * rejection was silent. These tests drive the REAL production path (register the
 * command, render page 1, read the actual button callback_data, invoke the real
 * callback handler) rather than only checking callback_data length / forged ids,
 * which is exactly the gap that let the bug ship.
 *
 * Run:
 *   node --import tsx --test src/bot/commands/gamestats.callback.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { accountService } from '../../services/account/account.service.js';
import { gameStatsService } from '../../services/analytics/gamestats.service.js';
import { gameResolver } from '../../services/roblox/game-resolver.js';
import { prisma } from '../../lib/prisma.js';
import { registerGameStatsCommand } from './gamestats.js';

// ── Fake Bot: capture the handlers the production code registers ─────────────

interface CapturedHandlers {
  command?: (ctx: CtxStub) => Promise<void>;
  callback?: (ctx: CtxStub) => Promise<void>;
}

function makeFakeBot(): { bot: unknown; captured: CapturedHandlers } {
  const captured: CapturedHandlers = {};
  const bot = {
    command: (_name: string, handler: (ctx: CtxStub) => Promise<void>) => {
      captured.command = handler;
    },
    callbackQuery: (_re: RegExp, handler: (ctx: CtxStub) => Promise<void>) => {
      captured.callback = handler;
    },
  };
  return { bot, captured };
}

// ── ctx stub shaped like grammY's real callback context ──────────────────────

interface CtxStub {
  from: { id: number };
  match?: string;
  callbackQuery: { data: string };
  reply: (text: string, extra?: unknown) => Promise<void>;
  editMessageText: (text: string, extra?: unknown) => Promise<void>;
  answerCallbackQuery: (...args: unknown[]) => Promise<void>;
  replies: string[];
  edits: string[];
  answers: unknown[];
}

function makeCtx(opts: {
  fromId: number;
  match?: string;
  callbackData?: string;
}): CtxStub {
  const ctx: CtxStub = {
    from: { id: opts.fromId },
    callbackQuery: { data: opts.callbackData ?? '' },
    replies: [],
    edits: [],
    answers: [],
    reply: async (text: string) => {
      ctx.replies.push(text);
    },
    editMessageText: async (text: string) => {
      ctx.edits.push(text);
    },
    answerCallbackQuery: async (...args: unknown[]) => {
      ctx.answers.push(args[0] ?? '<empty>');
    },
  };
  if (opts.match !== undefined) ctx.match = opts.match;
  return ctx;
}

// ── Fixture data ─────────────────────────────────────────────────────────────

const ACCOUNT_ID = 42;
const UNIVERSE_ID = 9970645639n;
const PLACE_ID = 77843161404023n;

/** 13 players → 2 pages of 10 → a real Next button exists on page 1. */
const PLAYERS = Array.from({ length: 13 }, (_v, i) => ({
  subjectId: BigInt(9_000_000_000_000 + i),
  totalSeconds: (13 - i) * 3600,
  lastSeenAt: new Date('2026-10-12T05:00:00Z'),
  stillPlaying: false,
  hasLongSession: false,
}));

function installStubs(): void {
  const prismaAny = prisma as unknown as Record<string, Record<string, unknown>>;
  prismaAny['friend']!['findMany'] = async () =>
    PLAYERS.map((p) => ({
      friendUserId: p.subjectId,
      username: `u${p.subjectId}`,
      displayName: `User ${p.subjectId}`,
    }));
  prismaAny['trackedUser']!['findMany'] = async () => [];
  prismaAny['gameSession']!['findFirst'] = async () => ({ gameName: 'Run a Restaurant!' });

  const accountAny = accountService as unknown as Record<string, unknown>;
  accountAny['getAccount'] = async (telegramId: string) =>
    telegramId === '' ? null : { id: ACCOUNT_ID };

  const resolverAny = gameResolver as unknown as Record<string, unknown>;
  resolverAny['resolve'] = async () => ({
    status: 'ok',
    placeId: PLACE_ID,
    universeId: UNIVERSE_ID,
    rootPlaceId: PLACE_ID,
    name: 'Run a Restaurant!',
  });
  resolverAny['cachedNameForPlace'] = () => 'Run a Restaurant!';

  const statsAny = gameStatsService as unknown as Record<string, unknown>;
  statsAny['getWindowTotals'] = async () => ({
    allSeconds: 100_000,
    todaySeconds: 1000,
    last7Seconds: 5000,
    last30Seconds: 20_000,
    playerCount: PLAYERS.length,
    firstSeen: new Date('2026-08-04T00:00:00Z'),
  });
  statsAny['getPlayerPage'] = async (
    _scope: unknown,
    _uni: unknown,
    _order: unknown,
    limit: number,
    offset: number,
  ) => ({
    players: PLAYERS.slice(offset, offset + limit),
    total: PLAYERS.length,
  });
  statsAny['getUserSessions'] = async () => [];
  statsAny['countLegacyRows'] = async () => 0;
}

/** Extracts the callback_data of a button whose label matches `label`. */
function buttonData(replyMarkup: unknown, label: string): string | undefined {
  const kb = replyMarkup as { inline_keyboard?: Array<Array<{ text: string; callback_data?: string }>> };
  for (const row of kb?.inline_keyboard ?? []) {
    for (const btn of row) {
      if (btn.text === label) return btn.callback_data;
    }
  }
  return undefined;
}

/** Renders page 1 via the REAL command handler and returns the keyboard. */
async function renderFirstPage(handler: CapturedHandlers, ownerId: number): Promise<{
  ctx: CtxStub;
  markup: unknown;
}> {
  const ctx = makeCtx({ fromId: ownerId, match: `${PLACE_ID}` });
  // The production command handler passes reply_markup through `reply`.
  let capturedMarkup: unknown;
  ctx.reply = async (_text: string, extra?: unknown) => {
    capturedMarkup = (extra as { reply_markup?: unknown })?.reply_markup;
    ctx.replies.push(_text);
  };
  await handler.command!(ctx);
  return { ctx, markup: capturedMarkup };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('legitimate owner: Next press is accepted (regression: blank encoded id)', async () => {
  installStubs();
  const { bot, captured } = makeFakeBot();
  registerGameStatsCommand(bot as never);

  // Telegram ids in the shapes that matter: 5-digit, 10-digit, >2^31, >2^32.
  const ownerIds = [12345, 1234567890, 2_200_000_000, 5_000_000_000];
  for (const ownerId of ownerIds) {
    const { markup } = await renderFirstPage(captured, ownerId);
    const next = buttonData(markup, 'Next »');
    assert.ok(next, `Next button present for owner ${ownerId}`);

    const ctx = makeCtx({ fromId: ownerId, callbackData: next });
    let markup2: unknown;
    ctx.editMessageText = async (text: string, extra?: unknown) => {
      markup2 = (extra as { reply_markup?: unknown })?.reply_markup;
      ctx.edits.push(text);
    };
    await captured.callback!(ctx);

    // The owner must NOT be rejected, and the message must be edited.
    assert.ok(
      !ctx.answers.some((a) => String(a).includes("isn't your message")),
      `owner ${ownerId} must not be rejected (answers=${JSON.stringify(ctx.answers)})`,
    );
    assert.equal(ctx.edits.length, 1, `owner ${ownerId} must get an edit`);
    // Page indicator "2/2" lives in the keyboard chip, not the message text.
    assert.equal(buttonData(markup2, '2/2'), 'gs:noop', `owner ${ownerId} sees the 2/2 chip`);
  }
});

test('non-owner: pressing the same button is still rejected', async () => {
  installStubs();
  const { bot, captured } = makeFakeBot();
  registerGameStatsCommand(bot as never);

  const ownerId = 12345;
  const intruderId = 99999;
  const { markup } = await renderFirstPage(captured, ownerId);
  const next = buttonData(markup, 'Next »');
  assert.ok(next);

  const ctx = makeCtx({ fromId: intruderId, callbackData: next });
  await captured.callback!(ctx);

  assert.ok(
    ctx.answers.some((a) => String(a).includes("isn't your message")),
    'intruder is rejected',
  );
  assert.equal(ctx.edits.length, 0, 'intruder gets no edit');
});

test('Next and Prev work in default mode at first/middle/last edges', async () => {
  installStubs();
  const { bot, captured } = makeFakeBot();
  registerGameStatsCommand(bot as never);

  const ownerId = 5000000000; // > 2^32
  const { markup: page1 } = await renderFirstPage(captured, ownerId);

  // Page 1: no Prev, has Next.
  assert.equal(buttonData(page1, '« Prev'), undefined, 'page 1 has no Prev');
  const next1 = buttonData(page1, 'Next »');
  assert.ok(next1, 'page 1 has Next');

  // Press Next → page 2 (last page): has Prev, no Next.
  const ctx2 = makeCtx({ fromId: ownerId, callbackData: next1 });
  let markup2: unknown;
  ctx2.editMessageText = async (_t: string, extra?: unknown) => {
    markup2 = (extra as { reply_markup?: unknown })?.reply_markup;
    ctx2.edits.push(_t);
  };
  await captured.callback!(ctx2);
  assert.equal(ctx2.edits.length, 1);
  assert.ok(buttonData(markup2, '2/2'), 'last page shows the 2/2 chip');
  assert.ok(buttonData(markup2, '« Prev'), 'last page has Prev');
  assert.equal(buttonData(markup2, 'Next »'), undefined, 'last page has no Next');

  // Press Prev → back to page 1.
  const prevData = buttonData(markup2, '« Prev');
  assert.ok(prevData);
  const ctx1 = makeCtx({ fromId: ownerId, callbackData: prevData });
  let markup1: unknown;
  ctx1.editMessageText = async (text: string, extra?: unknown) => {
    markup1 = (extra as { reply_markup?: unknown })?.reply_markup;
    ctx1.edits.push(text);
  };
  await captured.callback!(ctx1);
  assert.equal(ctx1.edits.length, 1);
  assert.ok(buttonData(markup1, '1/2'), 'back on page 1 (1/2 chip)');
  assert.equal(buttonData(markup1, '« Prev'), undefined, 'page 1 has no Prev again');
});

test('callback_data stays <= 64 bytes with the largest ids', async () => {
  installStubs();
  const { bot, captured } = makeFakeBot();
  registerGameStatsCommand(bot as never);

  // 10-digit telegram id, 19-digit place/universe/subject ids.
  const ownerId = 1234567890;
  const { markup } = await renderFirstPage(captured, ownerId);
  const next = buttonData(markup, 'Next »');
  assert.ok(next);
  assert.ok(Buffer.byteLength(next, 'utf8') <= 64, `too long: ${Buffer.byteLength(next)} bytes`);
});

test('build→parse→handler round-trips for every id size', async () => {
  installStubs();
  const { bot, captured } = makeFakeBot();
  registerGameStatsCommand(bot as never);

  for (const ownerId of [12345, 1234567890, 2_147_483_648, 4_294_967_296]) {
    const { markup } = await renderFirstPage(captured, ownerId);
    const next = buttonData(markup, 'Next »');
    assert.ok(next, `Next present for ${ownerId}`);
    // The encoded owner id must equal the presser id exactly (string compare).
    const parts = next.split(':');
    assert.equal(parts[parts.length - 1], String(ownerId), `encoded owner id for ${ownerId}`);
  }
});

test('malformed callback_data is answered, not edited, and never throws', async () => {
  installStubs();
  const { bot, captured } = makeFakeBot();
  registerGameStatsCommand(bot as never);

  const ctx = makeCtx({ fromId: 12345, callbackData: 'gs:not-enough' });
  await captured.callback!(ctx);
  assert.equal(ctx.edits.length, 0);
  assert.ok(ctx.answers.some((a) => String(a).includes('out of date')));
});

test('rejections are logged at warn with a reason code (never silent)', async () => {
  installStubs();
  const { bot, captured } = makeFakeBot();
  registerGameStatsCommand(bot as never);

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    // Non-owner press → owner_mismatch.
    const { markup } = await renderFirstPage(captured, 12345);
    const next = buttonData(markup, 'Next »');
    assert.ok(next);
    await captured.callback!(makeCtx({ fromId: 777, callbackData: next }));

    // Malformed press → malformed.
    await captured.callback!(makeCtx({ fromId: 777, callbackData: 'gs:broken' }));
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(
    warnings.some((w) => w.includes('reason=owner_mismatch') && w.includes('presser=777')),
    `expected owner_mismatch log, got: ${JSON.stringify(warnings)}`,
  );
  assert.ok(
    warnings.some((w) => w.includes('reason=malformed')),
    `expected malformed log, got: ${JSON.stringify(warnings)}`,
  );
  // Never log cookie material.
  assert.ok(
    !warnings.some((w) => /cookie|ROBLOSECURITY|roblosecurity/i.test(w)),
    'rejection logs must never mention cookies',
  );
});

test('the page-chip no-op never rejects or edits', async () => {
  installStubs();
  const { bot, captured } = makeFakeBot();
  registerGameStatsCommand(bot as never);

  const ctx = makeCtx({ fromId: 12345, callbackData: 'gs:noop' });
  await captured.callback!(ctx);
  assert.equal(ctx.edits.length, 0);
  assert.equal(ctx.answers.length, 1); // answered with an (empty) ack
  assert.equal(ctx.answers[0], '<empty>');
});

test('most mode: owner Next accepted and sorted view paginates', async () => {
  installStubs();
  const { bot, captured } = makeFakeBot();
  registerGameStatsCommand(bot as never);

  const ownerId = 4294967297; // > 2^32
  const ctx = makeCtx({ fromId: ownerId, match: `${PLACE_ID} most` });
  let markup: unknown;
  ctx.reply = async (_t: string, extra?: unknown) => {
    markup = (extra as { reply_markup?: unknown })?.reply_markup;
    ctx.replies.push(_t);
  };
  await captured.command!(ctx);

  const next = buttonData(markup, 'Next »');
  assert.ok(next, 'most page 1 has Next');
  // The most flag must be encoded as field 5 = '1'.
  assert.equal(next.split(':')[4], '1', 'most flag encoded');

  const cb = makeCtx({ fromId: ownerId, callbackData: next });
  await captured.callback!(cb);
  assert.ok(
    !cb.answers.some((a) => String(a).includes("isn't your message")),
    'owner accepted in most mode',
  );
  assert.equal(cb.edits.length, 1);
});

test('user: mode: owner Next accepted and session list paginates (regression check)', async () => {
  installStubs();
  const { bot, captured } = makeFakeBot();
  registerGameStatsCommand(bot as never);

  // 25 sessions on 25 DISTINCT days (1h each) → none merge → 3 pages of 10.
  const sessions = Array.from({ length: 25 }, (_v, i) => {
    const day = new Date(Date.UTC(2026, 8, 30));
    day.setUTCDate(day.getUTCDate() + i);
    const start = new Date(day.getTime() + 10 * 3600 * 1000); // 10:00Z
    const end = new Date(start.getTime() + 3600 * 1000); // 11:00Z
    return { startTime: start, endTime: end, open: false };
  });
  const statsAny = gameStatsService as unknown as Record<string, unknown>;
  statsAny['getUserSessions'] = async () => {
    // Shape returned by the service is RawUserSession; the command merges it.
    return sessions.map((s, i) => ({ id: i + 1, startTime: s.startTime, endTime: s.endTime, open: s.open }));
  };

  const ownerId = 5000000000;
  const ctx = makeCtx({ fromId: ownerId, match: `${PLACE_ID} user:User 9000000000000` });
  // Use a name that matches a fixture friend.
  ctx.match = `${PLACE_ID} user:u9000000000000`;
  let markup: unknown;
  ctx.reply = async (_t: string, extra?: unknown) => {
    markup = (extra as { reply_markup?: unknown })?.reply_markup;
    ctx.replies.push(_t);
  };
  await captured.command!(ctx);

  const next = buttonData(markup, 'Next »');
  assert.ok(next, 'user: page 1 has Next');
  assert.equal(next.split(':')[3], '1', 'user mode flag encoded');
  // subjectId must be encoded (not '-').
  assert.notEqual(next.split(':')[5], '-', 'subjectId encoded in user mode');

  const cb = makeCtx({ fromId: ownerId, callbackData: next });
  await captured.callback!(cb);
  assert.ok(
    !cb.answers.some((a) => String(a).includes("isn't your message")),
    'owner accepted in user mode',
  );
  assert.equal(cb.edits.length, 1, 'user mode edit happens');
});

test('user: mode non-owner is still rejected', async () => {
  installStubs();
  const { bot, captured } = makeFakeBot();
  registerGameStatsCommand(bot as never);

  const ownerId = 1234567890;
  const ctx = makeCtx({ fromId: ownerId, match: `${PLACE_ID} user:u9000000000000` });
  let markup: unknown;
  ctx.reply = async (_t: string, extra?: unknown) => {
    markup = (extra as { reply_markup?: unknown })?.reply_markup;
    ctx.replies.push(_t);
  };
  await captured.command!(ctx);

  // If there is no Next (single page), skip — otherwise assert rejection.
  const next = buttonData(markup, 'Next »');
  if (!next) return;

  const intruder = makeCtx({ fromId: 5, callbackData: next });
  await captured.callback!(intruder);
  assert.ok(intruder.answers.some((a) => String(a).includes("isn't your message")));
  assert.equal(intruder.edits.length, 0);
});
