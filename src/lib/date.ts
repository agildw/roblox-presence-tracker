/**
 * Date Utility
 * 
 * Handles UTC to WIB (UTC+7) conversions for display.
 */

/**
 * Formats a Date object to a WIB string (UTC+7).
 * Example: "Oct 12, 14:30"
 */
export function formatWIB(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * Returns the current date in UTC.
 * Since JS Date is UTC internally, this just returns new Date().
 */
export function nowUTC(): Date {
  return new Date();
}

/**
 * Formats seconds into a human-readable duration (e.g., "5 minutes" or "2.5 hours").
 */
export function formatDuration(seconds: number): string {
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = (seconds / 3600).toFixed(1);
  return `${hours} hours`;
}
