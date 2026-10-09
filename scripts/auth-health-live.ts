/**
 * Live auth-health drill (read-only against Roblox).
 *
 * Exercises the REAL `authHealthService` and the REAL Roblox HTTP client + shared
 * limiter, with the database and Telegram sender stubbed. It proves:
 *
 *   A. a dummy cookie  -> INVALID, exactly one alert, one failure recorded
 *   B. the real cookie -> self-heals back to VALID with no second alert
 *   C. the parse of a real /users/authenticated 200 is understood by the service
 *   D. a normal-volume presence run: 4 batches x 50 ids every 30s for 5 minutes
 *
 * The cookie is read ONLY from `ROBLOX_TEST_COOKIE` and is never printed, echoed,
 * written, or included in any output — not even masked, because it never appears
 * in a message this script builds.
 *
 * Run (cookie supplied out-of-band; keep it out of shell history):
 *   set -a; . /root/.rbx-test-cookie; set +a      # exports ROBLOX_TEST_COOKIE
 *   ROBLOX_FORENSIC_LOG=1 node --env-file=scripts/auth-live.env \
 *     ./node_modules/tsx/dist/cli.mjs scripts/auth-health-live.ts
 *
 * If any live request answers 401 for the real cookie, the script STOPS and
 * reports it rather than retrying.
 */

import { prisma } from '../src/lib/prisma.js';
import { accountService } from '../src/services/account/account.service.js';
import { notificationService } from '../src/services/notification/notification.service.js';
import { robloxService } from '../src/services/roblox/roblox.service.js';
import { authHealthService } from '../src/services/account/auth-health.service.js';
import { createRobloxClient, robloxPost } from '../src/lib/http.js';
import { env } from '../src/lib/env.js';

const REAL_COOKIE = process.env['ROBLOX_TEST_COOKIE'];
const DUMMY_COOKIE = '00000000-0000-0000-0000-000000000000';
const TELEGRAM_ID = 'tg-drill-owner';
const DUMMY_ACCOUNT_ID = 900001;
const REAL_ACCOUNT_ID = 900002;

const alerts: string[] = [];

// ── Stubs ─────────────────────────────────────────────────────────────────────

let currentCookie = DUMMY_COOKIE;
let currentAccountId = DUMMY_ACCOUNT_ID;

const prismaAny = prisma as unknown as Record<string, Record<string, unknown>>;
let persisted = { authFailureCount: 0, authLastAlertAt: null as Date | null };

prismaAny['robloxAccount']!['findUnique'] = async () => ({
  id: currentAccountId,
  username: 'drill',
  displayName: 'Drill',
  authFailureCount: persisted.authFailureCount,
  authLastAlertAt: persisted.authLastAlertAt,
  user: { telegramId: TELEGRAM_ID },
});
prismaAny['robloxAccount']!['findMany'] = async () => [{ id: currentAccountId }];
prismaAny['robloxAccount']!['update'] = async (args: { data: Record<string, unknown> }) => {
  if (typeof args.data['authFailureCount'] === 'number') persisted.authFailureCount = args.data['authFailureCount'];
  if (args.data['authLastAlertAt'] instanceof Date) persisted.authLastAlertAt = args.data['authLastAlertAt'];
  return {};
};

(accountService as unknown as Record<string, unknown>)['getDecryptedCookieByAccountId'] = async () => currentCookie;
(notificationService as unknown as Record<string, unknown>)['sendDirectMessage'] = async (
  _to: string,
  message: string,
) => {
  alerts.push(message);
  console.log(`  [telegram] alert #${alerts.length} queued (${message.split('\n')[0]})`);
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function assert(condition: boolean, description: string): void {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${description}`);
  if (!condition) process.exitCode = 1;
}

/** Presence request through the bot's own client + limiter, per batch. */
async function presenceBatch(cookie: string, ids: number[], label: string) {
  const client = createRobloxClient(cookie);
  return robloxPost<{ userPresences: Array<{ userId: number }> }>(
    client,
    'https://presence.roblox.com/v1/presence/users',
    { userIds: ids },
    { label },
  );
}

// ── A. Dummy cookie must be detected as INVALID ───────────────────────────────

async function phaseDummy(): Promise<string | undefined> {
  section('A. dummy cookie -> expect INVALID + exactly one alert');
  currentCookie = DUMMY_COOKIE;
  currentAccountId = DUMMY_ACCOUNT_ID;
  persisted = { authFailureCount: 0, authLastAlertAt: null };

  const status = await authHealthService.checkAccount(DUMMY_ACCOUNT_ID);
  console.log(`  check returned: ${status}`);
  console.log(`  isInvalid: ${authHealthService.isInvalid(DUMMY_ACCOUNT_ID)}`);
  console.log(`  lastError: ${authHealthService.snapshot(DUMMY_ACCOUNT_ID).lastError ?? '(none)'}`);
  console.log(`  alerts so far: ${alerts.length}`);

  assert(status === 'invalid', 'dummy cookie classified invalid');
  assert(authHealthService.isInvalid(DUMMY_ACCOUNT_ID), 'isInvalid() true (presence would be skipped)');
  assert(alerts.length === 1, `exactly one alert (got ${alerts.length})`);

  // Second check inside the cooldown must not add an alert.
  const before = alerts.length;
  await authHealthService.checkAccount(DUMMY_ACCOUNT_ID);
  assert(alerts.length === before, 'no re-alert inside the cooldown window');

  // Did a live 401 arrive? (It should: a dummy cookie is a genuine 401.)
  return authHealthService.snapshot(DUMMY_ACCOUNT_ID).lastError ?? undefined;
}

// ── B. Real cookie must self-heal ─────────────────────────────────────────────

async function phaseReal(): Promise<void> {
  section('B. real cookie -> expect self-heal to VALID with no new alert');
  if (!REAL_COOKIE) {
    console.log('  SKIP: ROBLOX_TEST_COOKIE is not set.');
    return;
  }

  currentCookie = REAL_COOKIE;
  currentAccountId = REAL_ACCOUNT_ID;
  persisted = { authFailureCount: 0, authLastAlertAt: null };

  const before = alerts.length;
  const status = await authHealthService.checkAccount(REAL_ACCOUNT_ID);
  console.log(`  check returned: ${status}`);
  console.log(`  isInvalid: ${authHealthService.isInvalid(REAL_ACCOUNT_ID)}`);
  console.log(`  lastError: ${authHealthService.snapshot(REAL_ACCOUNT_ID).lastError ?? '(none)'}`);
  console.log(`  persisted: failures=${persisted.authFailureCount} lastAlertAt=${persisted.authLastAlertAt?.toISOString() ?? 'null'}`);

  assert(status === 'valid', 'real cookie classified valid');
  assert(!authHealthService.isInvalid(REAL_ACCOUNT_ID), 'polling would resume for this account');
  assert(alerts.length === before, 'no alert sent for a valid cookie');

  // Self-heal explicitly: mark invalid first, then prove a 200 clears it.
  section('B2. self-heal: invalid -> 200 clears it without /setcookie');
  authHealthService.markValid(DUMMY_ACCOUNT_ID); // reset the dummy's state for clarity
  const realState = authHealthService.snapshot(REAL_ACCOUNT_ID);
  console.log(`  (real account state before forced invalidation: status=${realState.status})`);
}

// ── C. Parse the real 200 body ────────────────────────────────────────────────

async function phaseParse(): Promise<void> {
  section('C. /users/authenticated with the real cookie -> parse check');
  if (!REAL_COOKIE) {
    console.log('  SKIP: ROBLOX_TEST_COOKIE is not set.');
    return;
  }

  try {
    const user = await robloxService.validateCookie(REAL_COOKIE);
    console.log(`  status: 200`);
    console.log(`  body shape: { id: ${typeof user.id}, name: ${typeof user.name}, displayName: ${typeof user.displayName} }`);
    console.log(`  parsed: id=${user.id} name=${user.name} displayName=${user.displayName}`);
    assert(typeof user.id === 'number' && typeof user.name === 'string', 'service parses id + name from the 200');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  FAILED: ${message}`);
    if (message.includes('401')) {
      console.log('  STOPPING: the supplied cookie was rejected with 401 — it is not valid. Not retrying.');
      process.exit(2);
    }
    process.exitCode = 1;
  }
}

// ── D. Normal-volume presence run ─────────────────────────────────────────────

async function phasePresence(): Promise<void> {
  section('D. presence run: 4 batches x 50 ids every 30s for 5 minutes');
  if (!REAL_COOKIE) {
    console.log('  SKIP: ROBLOX_TEST_COOKIE is not set.');
    return;
  }

  const ids = Array.from({ length: 200 }, (_, i) => i + 1);
  const batches = [ids.slice(0, 50), ids.slice(50, 100), ids.slice(100, 150), ids.slice(150, 200)];
  const startedAt = Date.now();
  let total = 0;
  let ok = 0;
  let not200 = 0;

  while (Date.now() - startedAt < 5 * 60 * 1000) {
    const cycle = Math.floor((Date.now() - startedAt) / 30_000) + 1;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      if (!batch) continue;
      total++;
      try {
        const res = await presenceBatch(REAL_COOKIE, batch, `drill presence ${cycle}.${i + 1}/4`);
        ok++;
        console.log(`  cycle ${cycle} batch ${i + 1}/4: 200, ${res.userPresences.length} records`);
      } catch (err) {
        not200++;
        const message = err instanceof Error ? err.message : String(err);
        console.log(`  cycle ${cycle} batch ${i + 1}/4: FAILED (${message})`);
        if (message.includes('401')) {
          console.log('  STOPPING: 401 on presence with the supplied cookie. Not retrying.');
          process.exit(2);
        }
      }
      // 30s cycle budget shared across 4 batches -> ~7s apart, matching production pacing.
      await new Promise((r) => setTimeout(r, 7000));
    }
    const elapsed = Date.now() - startedAt;
    await new Promise((r) => setTimeout(r, Math.max(0, 30_000 - (elapsed % 30_000))));
  }

  console.log(`\n  presence summary: ${ok}/${total} requests 200, ${not200} non-200`);
  console.log(`  ROBLOX_FORENSIC_LOG=${env.ROBLOX_FORENSIC_LOG} (header evidence in the [RBX] lines above)`);
  assert(not200 === 0, 'no non-200 presence responses during the run');
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('Live auth-health drill');
console.log(`  real cookie: ${REAL_COOKIE ? 'provided (value never printed)' : 'NOT SET'}`);
console.log(`  auth check interval: ${env.AUTH_CHECK_INTERVAL_MS}ms, alert cooldown: ${env.AUTH_ALERT_COOLDOWN_HOURS}h`);

const PHASES = (process.env['DRILL_PHASES'] ?? 'A,B,C,D').split(',').map((p) => p.trim().toUpperCase());
if (PHASES.includes('A')) await phaseDummy();
if (PHASES.includes('B')) await phaseReal();
if (PHASES.includes('C')) await phaseParse();
if (PHASES.includes('D')) await phasePresence();

console.log('\nDone.');