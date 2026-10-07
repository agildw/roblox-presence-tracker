/**
 * Presence Worker
 *
 * Runs the presence polling loop for presence tracking.
 *
 * The loop re-arms itself one timer at a time instead of using `setInterval`:
 * the next tick is scheduled only after the current cycle finishes, so a cycle
 * can never overlap another one, and a cycle that trips a 429 backs off by the
 * shared cooldown rather than hammering the API on a fixed cadence.
 */

import { env } from '../lib/env.js';
import { adaptInterval, describeCycleFailure } from '../lib/adaptive.js';
import { robloxRateLimiter } from '../lib/ratelimit.js';
import { presenceService } from '../services/presence/presence.service.js';

let timer: NodeJS.Timeout | undefined = undefined;
let running = false;
let stopped = true;

export function startPresenceWorker(): void {
  if (running || timer) return;

  stopped = false;
  console.log(`[Worker] Starting presence polling every ${env.PRESENCE_POLL_INTERVAL_MS / 1000}s...`);
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
  try {
    await presenceService.pollAllPresence();

    const took = Date.now() - startedAt;
    if (took > env.PRESENCE_POLL_INTERVAL_MS) {
      console.warn(
        `[Worker] Presence poll took ${(took / 1000).toFixed(1)}s, longer than the ` +
          `${env.PRESENCE_POLL_INTERVAL_MS / 1000}s base interval. Next poll starts when this one finishes.`,
      );
    }
  } catch (err) {
    console.error(`[Worker] Presence poll failed: ${describeCycleFailure(err)}`);
  } finally {
    running = false;
  }

  const { intervalMs, multiplier } = adaptInterval(env.PRESENCE_POLL_INTERVAL_MS, robloxRateLimiter);
  if (multiplier > 1) {
    console.log(
      `[Worker] Next presence poll in ${(intervalMs / 1000).toFixed(1)}s ` +
        `(base ${env.PRESENCE_POLL_INTERVAL_MS / 1000}s, ×${multiplier.toFixed(1)}).`,
    );
  }
  schedule(intervalMs);
}