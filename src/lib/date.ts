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
