/**
 * Unit tests for /gamestats pure logic.
 *
 * Covers: URL/arg parsing, window clipping across midnight and DST, session
 * merging (server hops), sort modes, callback_data round-trip and byte length,
 * and the owner check in callback parsing.
 *
 * Run:
 *   node --import tsx --test src/bot/commands/gamestats.test.ts
 *
 * No database and no network are touched — only exported pure functions.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parsePlaceId,
  parseArgs,
  buildCallbackData,
  parseCallbackData,
  PAGE_SIZE,
} from './gamestats.js';
import { computeStatsWindows, localMidnight, overlapSeconds } from '../../lib/window.js';
import { mergeAdjacentSessions, orderMergedSessions } from '../../services/analytics/gamestats.service.js';

// ── URL / place-id parsing ────────────────────────────────────────────────────

test('parsePlaceId: canonical URL', () => {
  assert.equal(parsePlaceId('https://www.roblox.com/games/77843161404023/Run-a-Restaurant'), 77843161404023n);
});

test('parsePlaceId: regional prefix, query string, trailing slash', () => {
  assert.equal(parsePlaceId('https://www.roblox.com/es/games/77843161404023/Run-a-Restaurant'), 77843161404023n);
  assert.equal(parsePlaceId('https://www.roblox.com/games/77843161404023?foo=bar'), 77843161404023n);
  assert.equal(parsePlaceId('https://www.roblox.com/games/77843161404023/'), 77843161404023n);
});

test('parsePlaceId: scheme-less host and bare id', () => {
  assert.equal(parsePlaceId('roblox.com/games/9522'), 9522n);
  assert.equal(parsePlaceId('  77843161404023  '), 77843161404023n);
});

test('parsePlaceId: rejects non-game and non-Roblox inputs', () => {
  assert.equal(parsePlaceId('https://www.roblox.com/users/123/profile'), null);
  assert.equal(parsePlaceId('https://example.com/games/123'), null);
  assert.equal(parsePlaceId('https://evil-roblox.com/games/123'), null);
  assert.equal(parsePlaceId('not a url'), null);
  assert.equal(parsePlaceId(''), null);
});

// ── Argument parsing ──────────────────────────────────────────────────────────

test('parseArgs: bare game reference, no options', () => {
  const r = parseArgs('https://www.roblox.com/games/9522/Adopt-Me');
  assert.ok(r.ok);
  assert.equal(r.args.placeId, 9522n);
  assert.equal(r.args.most, false);
  assert.equal(r.args.userFilter, null);
});

test('parseArgs: most + user in any order, case-insensitive', () => {
  const r = parseArgs('9522 USER:Agil most');
  assert.ok(r.ok);
  assert.equal(r.args.most, true);
  assert.equal(r.args.userFilter, 'Agil');
});

test('parseArgs: user with leading @', () => {
  const r = parseArgs('9522 user:@agil');
  assert.ok(r.ok);
  assert.equal(r.args.userFilter, 'agil');
});

test('parseArgs: unknown option is rejected, not absorbed', () => {
  const r = parseArgs('9522 bogus');
  assert.equal(r.ok, false);
});

test('parseArgs: missing game reference', () => {
  assert.equal(parseArgs('').ok, false);
  assert.equal(parseArgs(undefined).ok, false);
});

test('parseArgs: empty user: rejected', () => {
  assert.equal(parseArgs('9522 user:').ok, false);
});

// ── Windows: local midnight + clipping ────────────────────────────────────────

test('localMidnight: Asia/Jakarta midnight is 17:00 UTC the previous day', () => {
  // 2026-10-12T06:00Z is 13:00 WIB on the 12th → local midnight is 2026-10-11T17:00Z.
  const now = new Date('2026-10-12T06:00:00Z');
  const midnight = localMidnight(now, 'Asia/Jakarta');
  assert.equal(midnight.toISOString(), '2026-10-11T17:00:00.000Z');
});

test('computeStatsWindows: today is calendar, last7/last30 are rolling from now', () => {
  const now = new Date('2026-10-12T06:00:00Z');
  const w = computeStatsWindows(now, 'Asia/Jakarta');

  // Today stays calendar-based: local midnight in WIB.
  assert.equal(w.today.from.toISOString(), '2026-10-11T17:00:00.000Z');

  // Rolling windows: exactly 7 / 30 days (to the ms) before `now`.
  const dayMs = 24 * 60 * 60 * 1000;
  assert.equal(w.last7.from.getTime(), now.getTime() - 7 * dayMs);
  assert.equal(w.last30.from.getTime(), now.getTime() - 30 * dayMs);
  assert.equal(w.last7.to.getTime(), now.getTime());
  assert.equal(w.last30.to.getTime(), now.getTime());
  assert.equal(w.all.from.getTime(), 0);
});

test('computeStatsWindows: rolling edges are time-of-day exact, not midnight', () => {
  // 06:00Z minus 7d is 06:00Z, NOT a local midnight — this is the point of the
  // rolling change, so pin it against a regression back to calendar days.
  const now = new Date('2026-10-12T06:00:00Z');
  const w = computeStatsWindows(now, 'Asia/Jakarta');
  assert.equal(w.last7.from.toISOString(), '2026-10-05T06:00:00.000Z');
  assert.equal(w.last30.from.toISOString(), '2026-09-12T06:00:00.000Z');
});

test('overlapSeconds: session crossing local midnight splits across the boundary', () => {
  // Session 23:30 → 00:30 local (WIB). Midnight is 17:00Z-equivalent.
  const start = new Date('2026-10-12T16:30:00Z'); // 23:30 WIB on the 12th
  const end = new Date('2026-10-12T17:30:00Z'); //   00:30 WIB on the 13th
  const midnight = new Date('2026-10-12T17:00:00Z'); // 00:00 WIB on the 13th

  const before = overlapSeconds(start, end, new Date('2026-10-12T00:00:00Z'), midnight);
  const after = overlapSeconds(start, end, midnight, new Date('2026-10-13T00:00:00Z'));

  assert.equal(before, 30 * 60);
  assert.equal(after, 30 * 60);
  assert.equal(before + after, 60 * 60);
});

test('overlapSeconds: zero when the session is outside the window', () => {
  const start = new Date('2026-10-01T00:00:00Z');
  const end = new Date('2026-10-01T01:00:00Z');
  const from = new Date('2026-10-05T00:00:00Z');
  const to = new Date('2026-10-05T12:00:00Z');
  assert.equal(overlapSeconds(start, end, from, to), 0);
});

test('computeStatsWindows: honours a DST zone (America/New_York)', () => {
  // 2026-03-08 is the US spring-forward day: local midnight is EST (-5) = 05:00Z.
  const now = new Date('2026-03-08T12:00:00Z');
  const w = computeStatsWindows(now, 'America/New_York');
  assert.equal(w.today.from.toISOString(), '2026-03-08T05:00:00.000Z');

  // The day after the transition is EDT (-4), so midnight shifts back an hour.
  const now2 = new Date('2026-03-09T12:00:00Z');
  const w2 = computeStatsWindows(now2, 'America/New_York');
  assert.equal(w2.today.from.toISOString(), '2026-03-09T04:00:00.000Z');
});

test('computeStatsWindows: UTC zone midnight is exact', () => {
  const now = new Date('2026-10-12T06:00:00Z');
  const w = computeStatsWindows(now, 'UTC');
  assert.equal(w.today.from.toISOString(), '2026-10-12T00:00:00.000Z');
});

// ── Merging (server hops) ─────────────────────────────────────────────────────

test('mergeAdjacentSessions: rows within the gap merge into one', () => {
  const rows = [
    { startTime: new Date('2026-10-12T10:00:00Z'), endTime: new Date('2026-10-12T10:30:00Z'), open: false },
    // server hop: 60s later, same session
    { startTime: new Date('2026-10-12T10:31:00Z'), endTime: new Date('2026-10-12T11:00:00Z'), open: false },
  ];
  const merged = mergeAdjacentSessions(rows, 120);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.seconds, 60 * 60);
  assert.equal(merged[0]!.parts, 2);
  assert.equal(merged[0]!.open, false);
});

test('mergeAdjacentSessions: rows beyond the gap stay separate', () => {
  const rows = [
    { startTime: new Date('2026-10-12T10:00:00Z'), endTime: new Date('2026-10-12T10:30:00Z'), open: false },
    { startTime: new Date('2026-10-12T10:35:00Z'), endTime: new Date('2026-10-12T11:00:00Z'), open: false },
  ];
  const merged = mergeAdjacentSessions(rows, 120);
  assert.equal(merged.length, 2);
});

test('mergeAdjacentSessions: open flag is sticky and out-of-order input is sorted', () => {
  const rows = [
    { startTime: new Date('2026-10-12T10:31:00Z'), endTime: new Date('2026-10-12T11:00:00Z'), open: true },
    { startTime: new Date('2026-10-12T10:00:00Z'), endTime: new Date('2026-10-12T10:30:00Z'), open: false },
  ];
  const merged = mergeAdjacentSessions(rows, 120);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.open, true);
  assert.equal(merged[0]!.startTime.toISOString(), '2026-10-12T10:00:00.000Z');
});

test('orderMergedSessions: most = longest first; recent = newest first', () => {
  const sessions = [
    { startTime: new Date('2026-10-10T10:00:00Z'), endTime: new Date('2026-10-10T12:00:00Z'), seconds: 7200, open: false, parts: 1 },
    { startTime: new Date('2026-10-12T10:00:00Z'), endTime: new Date('2026-10-12T10:10:00Z'), seconds: 600, open: false, parts: 1 },
  ];
  assert.equal(orderMergedSessions(sessions, 'most')[0]!.seconds, 7200);
  assert.equal(orderMergedSessions(sessions, 'recent')[0]!.startTime.toISOString(), '2026-10-12T10:00:00.000Z');
});

// ── callback_data ─────────────────────────────────────────────────────────────

test('callback_data: round-trips and stays within 64 bytes', () => {
  const data = buildCallbackData({
    universeId: 9970645639n,
    placeId: 77843161404023n,
    userMode: true,
    most: true,
    subjectId: 9451947370n,
    page: 999,
    telegramId: '123456789012',
  });
  assert.ok(Buffer.byteLength(data, 'utf8') <= 64, `too long: ${Buffer.byteLength(data)} bytes`);
  const parsed = parseCallbackData(data);
  assert.ok(parsed);
  assert.equal(parsed.universeId, 9970645639n);
  assert.equal(parsed.placeId, 77843161404023n);
  assert.equal(parsed.userMode, true);
  assert.equal(parsed.most, true);
  assert.equal(parsed.subjectId, 9451947370n);
  assert.equal(parsed.page, 999);
  assert.equal(parsed.telegramId, '123456789012');
});

test('callback_data: subject "-" decodes to null', () => {
  const data = buildCallbackData({
    universeId: 1n,
    placeId: 2n,
    userMode: false,
    most: false,
    subjectId: null,
    page: 0,
    telegramId: '42',
  });
  const parsed = parseCallbackData(data);
  assert.ok(parsed);
  assert.equal(parsed.subjectId, null);
});

test('callback_data: malformed input rejected', () => {
  assert.equal(parseCallbackData('gs:noop'), null);
  assert.equal(parseCallbackData('bdg:1:2:3'), null);
  assert.equal(parseCallbackData('gs:x:2:0:0:-:0:1'), null);
});

test('PAGE_SIZE is 10', () => {
  assert.equal(PAGE_SIZE, 10);
});
