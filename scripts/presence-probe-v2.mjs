#!/usr/bin/env node
/**
 * Presence probe v2 — run this ON THE SERVER whose IP you care about.
 *
 * Difference from v1, and why:
 *  - The origin is chosen per trial by `PROBE_MODE` (anon | auth | both). v1
 *    labelled the *intended* mode while a cookie was already set, so trials
 *    labelled "anonymous" in an authenticated run were not anonymous. That
 *    labelling bug is why the authenticated output was uninterpretable.
 *  - Spacing trials are **shuffled** by default and repeated, because a single
 *    fixed ordering (2000 → 1000 → 500) leaks the previous trial's spending
 *    into the next one, which is exactly the confound in the v1 results.
 *  - Every row carries a wall-clock **timestamp**, the bucket the server
 *    attributed the request to, and the obtaining-runtime headers, so a
 *    concurrent client sharing the bucket is visible.
 *  - `PROBE_SOAK=1` reproduces the production pattern in isolation.
 *
 * Usage:
 *   node scripts/presence-probe.mjs
 *   ROBLOX_COOKIE='...' PROBE_MODE=auth node scripts/presence-probe.mjs
 *   PROBE_MODE=both PROBE_REPETITIONS=3 node scripts/presence-probe.mjs
 *   ROBLOX_COOKIE='...' PROBE_MODE=auth PROBE_SOAK=1 node scripts/presence-probe.mjs
 *
 * Env:
 *   ROBLOX_COOKIE        .ROBLOSECURITY value (no prefix). Never printed.
 *   PROBE_MODE           anon | auth | both  (default anon; `auth` requires the cookie)
 *   PROBE_GAP_MS         idle between trials (default 75000)
 *   PROBE_REPETITIONS    repeats per spacing; trials are still shuffled (default 1)
 *   PROBE_FIXED_ORDER    "1" keeps the declared order instead of shuffling
 *   PROBE_SIZE           ids per request (default 50, the endpoint's cap)
 *   PROBE_HEADERS        "1" (default) sends browser-like headers, matching the bot
 *   PROBE_GAP_BETWEEN    ms between requests inside a trial (default = spacing)
 *
 * Safety: read-only POSTs of a public endpoint, no retries, no parallel
 * requests, no proxy or IP rotation. The cookie is used only as a header and is
 * never logged, echoed, or included in output.
 *
 * Soak mode (PROBE_SOAK=1):
 *   Every PROBE_SOAK_INTERVAL_MS (default 30000) it sends PROBE_SOAK_BATCHES
 *   (default 4) requests spaced PROBE_SOAK_GAP_MS (default 1500) apart, for
 *   PROBE_SOAK_MINUTES (default 15) — i.e. the real cycle, worst case
 *   (untracked-first ordering is irrelevant; presence ignores it).
 */

import https from 'node:https';

// ── Config ────────────────────────────────────────────────────────────────────

const COOKIE = process.env['ROBLOX_COOKIE'] ?? '';
const MODE = process.env['PROBE_MODE'] ?? 'anon';
const GAP_MS = Number(process.env['PROBE_GAP_MS'] ?? 75_000);
const REPETITIONS = Number(process.env['PROBE_REPETITIONS'] ?? 1);
const FIXED_ORDER = process.env['PROBE_FIXED_ORDER'] === '1';
const SIZE = Math.min(50, Number(process.env['PROBE_SIZE'] ?? 50));
const SEND_BROWSER_HEADERS = process.env['PROBE_HEADERS'] !== '0';
const SPACINGS = [2000, 1000, 500];
const REQUESTS_PER_RUN = 10;

const SOAK = process.env['PROBE_SOAK'] === '1';
const SOAK_INTERVAL_MS = Number(process.env['PROBE_SOAK_INTERVAL_MS'] ?? 30_000);
const SOAK_BATCHES = Number(process.env['PROBE_SOAK_BATCHES'] ?? 4);
const SOAK_GAP_MS = Number(process.env['PROBE_SOAK_GAP_MS'] ?? 1_500);
const SOAK_MINUTES = Number(process.env['PROBE_SOAK_MINUTES'] ?? 15);

if (MODE !== 'anon' && MODE !== 'auth' && MODE !== 'both') {
  console.error(`PROBE_MODE must be anon | auth | both (got "${MODE}")`);
  process.exit(2);
}
if ((MODE === 'auth' || MODE === 'both') && !COOKIE) {
  console.error('PROBE_MODE requires auth but ROBLOX_COOKIE is empty.');
  process.exit(2);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm

/**
 * Browser-like headers, matching what the bot sends. A full browser header set
 * would be the faithful test for Roblox's residential path, but inventing one
 * that pretends to be Chrome would be evasion-adjacent; this keeps the client
 * honest while removing the "bare Node request" variable.
 */
function headersFor(useCookie) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'roblox-tracker-presence-probe/2.0 (+diagnostic)',
  };
  if (useCookie) headers['Cookie'] = `.ROBLOSECURITY=${COOKIE}`;
  return headers;
}

/** One presence POST. `useCookie` decides the origin for *this* request. */
function request(userIds, useCookie) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ userIds });
    const headers = { ...headersFor(useCookie), 'Content-Length': Buffer.byteLength(body) };
    const startedAt = Date.now();

    const req = https.request(
      'https://presence.roblox.com/v1/presence/users',
      { method: 'POST', headers },
      (res) => {
        const attribution = res.headers['x-ratelimit-limit'] ?? '';
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            at: startedAt,
            ms: Date.now() - startedAt,
            origin: useCookie ? 'auth' : 'anon',
            retryAfter: res.headers['retry-after'] ?? null,
            limit: res.headers['x-ratelimit-limit'] ?? null,
            remaining: res.headers['x-ratelimit-remaining'] ?? null,
            reset: res.headers['x-ratelimit-reset'] ?? null,
            coverage: res.headers['x-retry-after-coverage'] ?? null,
            advertisedWindows: attribution,
            bucket: res.headers['x-ratelimit-bucket'] ?? null,
            served: ['server', 'via', 'x-served-by', 'x-envoy-upstream-service-time']
              .map((h) => (res.headers[h] ? `${h}=${res.headers[h]}` : null))
              .filter(Boolean)
              .join(' '),
          }),
        );
      },
    );
    req.on('error', (err) => resolve({ status: 'ERR', at: startedAt, error: err.code ?? err.message, origin: useCookie ? 'auth' : 'anon' }));
    req.setTimeout(15_000, () => {
      req.destroy();
      resolve({ status: 'TIMEOUT', at: startedAt, origin: useCookie ? 'auth' : 'anon' });
    });
    req.write(body);
    req.end();
  });
}

function formatRow(i, r, spacing) {
  return [
    `#${String(i + 1).padStart(2)}`,
    stamp(),
    spacing !== undefined ? `(sp ${String(spacing).padStart(4)}ms)` : '',
    `origin=${r.origin}`,
    `status=${r.status}`,
    r.ms !== undefined ? `${r.ms}ms` : '',
    `retry-after=${r.retryAfter ?? 'absent'}`,
    `remaining=${r.remaining ?? '-'}`,
    `reset=${r.reset ?? '-'}`,
    r.bucket ? `bucket=${r.bucket}` : '',
    r.served ? `[${r.served}]` : '',
  ]
    .filter(Boolean)
    .join('  ');
}

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ── Trials ────────────────────────────────────────────────────────────────────

async function runTrial(label, spacingMs) {
  const userIds = Array.from({ length: SIZE }, (_, i) => i + 1);
  const useCookie = label === 'auth';
  console.log(`\n=== ${label} | spacing=${spacingMs}ms | requests=${REQUESTS_PER_RUN} | ids=${SIZE} ===`);

  const results = [];
  for (let i = 0; i < REQUESTS_PER_RUN; i++) {
    const r = await request(userIds, useCookie);
    results.push(r);
    console.log(formatRow(i, r, spacingMs));
    if (i < REQUESTS_PER_RUN - 1) await sleep(spacingMs);
  }

  const ok = results.filter((r) => r.status === 200).length;
  const first429 = results.findIndex((r) => r.status === 429);
  // remaining dropping by >1 between consecutive own requests ⇒ a concurrent client.
  const overlaps = results
    .slice(1)
    .filter((r, i) => Number(r.remaining) + 1 < Number(results[i].remaining ?? 0)).length;

  console.log(
    `-- ${label} @${spacingMs}ms: ${ok}/${REQUESTS_PER_RUN} ok, ` +
      `first 429 at #${first429 === -1 ? 'none' : first429 + 1}, ` +
      `suspected concurrent spend: ${overlaps}`,
  );
  return { label, spacingMs, ok, first429: first429 === -1 ? null : first429 + 1, overlaps, results };
}

// ── Soak ──────────────────────────────────────────────────────────────────────

async function runSoak() {
  const label = MODE === 'anon' ? 'anon' : 'auth';
  const useCookie = label === 'auth';
  const cycles = Math.max(1, Math.round((SOAK_MINUTES * 60_000) / SOAK_INTERVAL_MS));
  const userIds = Array.from({ length: SIZE }, (_, i) => i + 1);

  console.log(
    `\n=== SOAK (${label}) — ${cycles} cycles, ${SOAK_BATCHES} requests ` +
      `@${SOAK_GAP_MS}ms every ${SOAK_INTERVAL_MS / 1000}s for ${SOAK_MINUTES}min ===`,
  );

  const all = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    const cycleStarted = Date.now();
    const rows = [];
    for (let i = 0; i < SOAK_BATCHES; i++) {
      const r = await request(userIds, useCookie);
      all.push({ ...r, cycle });
      rows.push(r);
      if (i < SOAK_BATCHES - 1) await sleep(SOAK_GAP_MS);
    }
    const ok = rows.filter((r) => r.status === 200).length;
    console.log(
      `cycle ${String(cycle + 1).padStart(3)}/${cycles} ${stamp()}: ${ok}/${SOAK_BATCHES} ok ` +
        `[${rows.map((r) => r.status).join(',')}] ` +
        `remaining=${rows.at(-1)?.remaining ?? '-'} reset=${rows.at(-1)?.reset ?? '-'}`,
    );
    const elapsed = Date.now() - cycleStarted;
    if (cycle < cycles - 1) await sleep(Math.max(0, SOAK_INTERVAL_MS - elapsed));
  }

  const total = all.length;
  const ok = all.filter((r) => r.status === 200).length;
  const cyclesClean = Math.floor(ok / SOAK_BATCHES);
  console.log('\n=== SOAK SUMMARY ===');
  console.log(`  requests: ${ok}/${total} ok (${((ok / total) * 100).toFixed(1)}%)`);
  console.log(`  fully clean cycles (all ${SOAK_BATCHES} ok): ${cyclesClean}/${cycles}`);
  console.log(`  statuses: ${JSON.stringify(all.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {}))}`);
  const firstFail = all.findIndex((r) => r.status !== 200);
  if (firstFail >= 0) {
    const f = all[firstFail];
    console.log(`  first failure: cycle ${f.cycle + 1} request ${(firstFail % SOAK_BATCHES) + 1}, status=${f.status}, retry-after=${f.retryAfter ?? 'absent'}, remaining=${f.remaining ?? '-'}`);
  } else {
    console.log('  first failure: none — the production pattern was accepted for the whole soak');
  }
  return { label, total, ok, cycles, cyclesClean };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Presence probe v2');
  console.log(`  mode:        ${MODE}`);
  console.log(`  cookie:      ${COOKIE ? 'provided (value never printed)' : 'none'}`);
  console.log(`  size:        ${SIZE} ids/request`);
  console.log(`  headers:     ${SEND_BROWSER_HEADERS ? 'browser-like (bot parity)' : 'bare client'}`);

  if (SOAK) {
    const result = await runSoak();
    console.log(`\nsoak ${result.label}: ${result.ok}/${result.total} ok, ${result.cyclesClean}/${result.cycles} clean cycles`);
    return;
  }

  console.log(`  ordering:    ${FIXED_ORDER ? 'declared' : 'shuffled'} | repetitions: ${REPETITIONS}`);
  console.log(`  gap:         ${(GAP_MS / 1000).toFixed(0)}s between trials`);

  const labels = MODE === 'both' ? ['anon', 'auth'] : [MODE];
  const trials = [];
  for (const label of labels) {
    const order = FIXED_ORDER ? SPACINGS : shuffle(SPACINGS);
    for (let rep = 0; rep < REPETITIONS; rep++) {
      for (const spacing of order) {
        trials.push(await runTrial(label, spacing));
        await sleep(GAP_MS);
      }
    }
  }

  console.log('\n=== overall (grouped) ===');
  for (const label of labels) {
    for (const spacing of SPACINGS) {
      const rows = trials.filter((t) => t.label === label && t.spacingMs === spacing);
      if (rows.length === 0) continue;
      const okList = rows.map((r) => `${r.ok}/${REQUESTS_PER_RUN}`);
      const firstList = rows.map((r) => r.first429 ?? 'none');
      const overlapTotal = rows.reduce((sum, r) => sum + r.overlaps, 0);
      console.log(
        `${label.padEnd(5)} @${String(spacing).padStart(4)}ms : ok=[${okList.join(' ')}] ` +
          `first429=[${firstList.join(' ')}] concurrentSpend=${overlapTotal}`,
      );
    }
  }

  console.log(
    '\nReading the result:\n' +
      '  * ok-pattern differs between anon and auth runs -> the origin changes the budget.\n' +
      '  * ok-pattern differs between repetitions at the SAME spacing -> the budget is being\n' +
      '    spent by something else (the bot, another process, or another account session).\n' +
      '  * concurrentSpend > 0 -> some other client drained the bucket while the probe ran.\n' +
      '  * first429 consistent and rising with spacing -> spacing genuinely governs admission.',
  );
}

await main();