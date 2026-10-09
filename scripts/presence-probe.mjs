#!/usr/bin/env node
/**
 * Presence throttle probe — run this ON THE SERVER whose IP you care about
 * (e.g. the AWS host), not on a workstation.
 *
 * It measures the presence endpoint's real admission control at three request
 * spacings, anonymous first and then authenticated, and prints the first-429
 * index plus every status / Retry-After / x-ratelimit-* header per request.
 * That tells you whether the throttle is caused by burst *density* (spacings
 * differ) or by the IP/session (auth differs, or all spacings fail).
 *
 * Usage (anonymous only):
 *   node scripts/presence-probe.mjs
 * Usage (also authenticated — cookie is read from the env, never printed):
 *   ROBLOX_COOKIE='...' node scripts/presence-probe.mjs
 *
 * Env:
 *   ROBLOX_COOKIE   optional .ROBLOSECURITY cookie value (no ".ROBLOSECURITY=" prefix)
 *   PROBE_GAP_MS    idle time between runs (default 75000; endpoint penalty was
 *                   measured at up to ~95s, so do not lower this much)
 *   PROBE_SIZE      ids per request (default 50, the endpoint's hard cap)
 *
 * Safety: read-only POSTs of the public presence endpoint, at most 10 requests
 * per run with 500ms+ spacing and 75s of idle between runs. No retries, no
 * parallel requests, no IP rotation. The cookie is used only as a request header
 * and is never logged, echoed, or included in any output.
 */

import https from 'node:https';

const COOKIE = process.env['ROBLOX_COOKIE'] ?? '';
const GAP_MS = Number(process.env['PROBE_GAP_MS'] ?? 75_000);
const SIZE = Math.min(50, Number(process.env['PROBE_SIZE'] ?? 50));
const SPACINGS = [2000, 1000, 500];
const REQUESTS_PER_RUN = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One presence POST. Resolves with status, timing and the rate-limit headers. */
function request(userIds) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ userIds });
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    // Cookie is added only when present; it is never printed anywhere below.
    if (COOKIE) headers['Cookie'] = `.ROBLOSECURITY=${COOKIE}`;

    const startedAt = Date.now();
    const req = https.request(
      'https://presence.roblox.com/v1/presence/users',
      { method: 'POST', headers },
      (res) => {
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            ms: Date.now() - startedAt,
            retryAfter: res.headers['retry-after'] ?? null,
            limit: res.headers['x-ratelimit-limit'] ?? null,
            remaining: res.headers['x-ratelimit-remaining'] ?? null,
            reset: res.headers['x-ratelimit-reset'] ?? null,
            coverage: res.headers['x-retry-after-coverage'] ?? null,
          }),
        );
      },
    );
    req.on('error', (err) => resolve({ status: 'ERR', error: err.code ?? err.message }));
    req.setTimeout(15_000, () => {
      req.destroy();
      resolve({ status: 'TIMEOUT' });
    });
    req.write(body);
    req.end();
  });
}

/** Runs one spacing trial and reports the first 429 index (1-based, null if none). */
async function runTrial(mode, spacingMs) {
  const userIds = Array.from({ length: SIZE }, (_, i) => i + 1);
  console.log(`\n=== ${mode} | spacing=${spacingMs}ms | requests=${REQUESTS_PER_RUN} | ids=${SIZE} ===`);

  const results = [];
  for (let i = 0; i < REQUESTS_PER_RUN; i++) {
    const r = await request(userIds);
    results.push(r);
    const parts = [
      `#${String(i + 1).padStart(2)}`,
      `status=${r.status}`,
      r.ms !== undefined ? `${r.ms}ms` : '',
      `retry-after=${r.retryAfter ?? 'absent'}`,
      `limit=${r.limit ?? '-'}`,
      `remaining=${r.remaining ?? '-'}`,
      `reset=${r.reset ?? '-'}`,
      r.coverage ? `coverage=${r.coverage}` : '',
    ].filter(Boolean);
    console.log(parts.join('  '));
    if (i < REQUESTS_PER_RUN - 1) await sleep(spacingMs);
  }

  const first429 = results.findIndex((r) => r.status === 429);
  const okCount = results.filter((r) => r.status === 200).length;
  console.log(
    `-- summary [${mode} @${spacingMs}ms]: ${okCount}/${REQUESTS_PER_RUN} ok, ` +
      `first 429 at #${first429 === -1 ? 'none' : first429 + 1}`,
  );
  return { mode, spacingMs, okCount, first429: first429 === -1 ? null : first429 + 1 };
}

async function main() {
  console.log('Presence throttle probe');
  console.log(`  cookie:      ${COOKIE ? 'provided (value never printed)' : 'none (anonymous)'}`);
  console.log(`  gap between runs: ${(GAP_MS / 1000).toFixed(0)}s`);
  console.log(`  per request: ${SIZE} ids`);

  const trials = [];
  trials.push(await runTrial('anonymous', 2000));
  await sleep(GAP_MS);
  trials.push(await runTrial('anonymous', 1000));
  await sleep(GAP_MS);
  trials.push(await runTrial('anonymous', 500));

  if (COOKIE) {
    await sleep(GAP_MS);
    trials.push(await runTrial('authenticated', 2000));
    await sleep(GAP_MS);
    trials.push(await runTrial('authenticated', 1000));
    await sleep(GAP_MS);
    trials.push(await runTrial('authenticated', 500));
  } else {
    console.log('\n(skipping authenticated trials: set ROBLOX_COOKIE to include them)');
  }

  console.log('\n=== overall ===');
  for (const t of trials) {
    console.log(
      `${t.mode.padEnd(13)} @${String(t.spacingMs).padStart(4)}ms : ` +
        `${t.okCount}/${REQUESTS_PER_RUN} ok, first 429 at #${t.first429 ?? 'none'}`,
    );
  }
  console.log(
    '\nReading the result:\n' +
      '  * first-429 index rising as spacing widens  -> throttle is burst DENSITY; pacing is the fix.\n' +
      '  * all spacings failing at the same index    -> throttle is per-IP/per-session; pacing alone will not fix it.\n' +
      '  * authenticated succeeding where anonymous fails (or vice versa) -> auth changes the budget.',
  );
}

await main();