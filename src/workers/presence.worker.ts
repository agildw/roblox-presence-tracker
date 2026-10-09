/**
 * Presence Worker
 *
 * Runs the presence polling loop for presence tracking.
 *
 * The loop re-arms itself one timer at a time instead of using `setInterval`:
 * the next tick is scheduled only after the current cycle finishes, so a cycle
 * can never overlap another one.
 *
 * Scheduling honours the shared cooldown: the next cycle starts at
 * `max(interval × multiplier, cooldownRemaining)`, so a cycle is never opened
 * while Roblox is still throttling us — that only burned a cycle for zero data.
 */

import { env } from '../lib/env.js';
import { describeCycleFailure, scheduleDelayMs } from '../lib/adaptive.js';
import { robloxRateLimiter } from '../lib/ratelimit.js';
import { presenceService } from '../services/presence/presence.service.js';

let timer: NodeJS.Timeout | undefined = undefined;
let running = false;
let stopped = true;

export function startPresenceWorker(): void {
  if (running || timer) return;

  stopped = false;
  console.log(
    `[Worker] Starting presence polling every ${env.PRESENCE_POLL_INTERVAL_MS / 1000}s ` +
      `(min request gap ${env.ROBLOX_MIN_REQUEST_GAP_MS}ms)...`,
  );
  schedule(0);
}

export function stopPresenceWorker(): void {
  stopped = true;
  clearTimeout(timer);
  timer = undefined;
  console.log('[Worker] Presence polling stopped.');
}

/** Schedules the next cycle after `delayMs`. */
function schedule(delayMs: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    timer = undefined;
    void runCycle();
  }, delayMs);
}

async function runCycle(): Promise<void> {
  if (stopped || running) return;
  running = true;

  const startedAt = Date.now();
  let cleanCycle = false;

  try {
    const outcome = await presenceService.pollAllPresence();
    const took = (Date.now() - startedAt) / 1000;

    // A cycle is clean when it was not throttled and nothing was left unpolled.
    cleanCycle = !outcome.throttled && !outcome.halted;
    if (cleanCycle) robloxRateLimiter.reportCycleClean();

    console.log(
      `[Worker] cycle completed: ${outcome.batchesApplied}/${outcome.batchesTotal} batches applied, ` +
        `took ${took.toFixed(1)}s${outcome.throttled ? ' (throttled)' : ''}` +
        `${outcome.unansweredIds > 0 ? `, ${outcome.unansweredIds} unanswered` : ''}` +
        robloxRateLimiter.describe(),
    );
  } catch (err) {
    console.error(`[Worker] Presence poll failed: ${describeCycleFailure(err)}`);
  } finally {
    running = false;
  }

  const { delayMs, multiplier, cooldownRemainingMs } = scheduleDelayMs(env.PRESENCE_POLL_INTERVAL_MS, robloxRateLimiter);

  if (cooldownRemainingMs > delayMs) {
    console.log(
      `[Worker] Next presence poll in ${(delayMs / 1000).toFixed(1)}s ` +
        `(waiting out ${(cooldownRemainingMs / 1000).toFixed(1)}s cooldown).`,
    );
  } else if (multiplier > 1) {
    console.log(
      `[Worker] Next presence poll in ${(delayMs / 1000).toFixed(1)}s ` +
        `(base ${env.PRESENCE_POLL_INTERVAL_MS / 1000}s, ×${multiplier.toFixed(1)}).`,
    );
  }
  schedule(delayMs);
}