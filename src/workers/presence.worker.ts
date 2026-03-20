/**
 * Presence Worker
 *
 * Runs the polling loop for presence tracking.
 */

import { presenceService } from '../services/presence/presence.service.js';

let intervalId: NodeJS.Timeout | null = null;
let isPolling = false;

// Interval configured per SKILL.md (10-20 seconds)
const POLL_INTERVAL_MS = 15000;

export function startPresenceWorker(): void {
  if (intervalId) return;

  console.log(`[Worker] Starting presence polling every ${POLL_INTERVAL_MS / 1000}s...`);

  intervalId = setInterval(() => {
    if (isPolling) {
      console.warn('[Worker] Presence poll skipped: previous cycle still running.');
      return;
    }
    isPolling = true;

    presenceService.pollAllPresence().catch((err) => {
      console.error('[Worker] Error during presence polling cycle:', err);
    }).finally(() => {
      isPolling = false;
    });
  }, POLL_INTERVAL_MS);
}

export function stopPresenceWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[Worker] Presence polling stopped.');
  }
}
