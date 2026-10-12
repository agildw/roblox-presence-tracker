/**
 * Time-zone window helpers for /gamestats.
 *
 * The bot stores and queries instants in UTC. "Today" and the 7/30-day windows
 * are *calendar* concepts in a configured IANA time zone (`env.TZ_NAME`,
 * default Asia/Jakarta). This module converts "local midnight on the day that
 * contains `now`" — and the local midnights N days before it — into absolute
 * UTC instants, so every window is an exact `[from, to)` instant range that the
 * database can compare against `startTime`/`endTime` without doing any
 * time-zone math itself.
 *
 * All functions are pure and take `now` as an argument so tests are
 * deterministic. No `Date.now()` is read inside.
 */

export interface Window {
  /** Inclusive lower bound (UTC instant). */
  from: Date;
  /** Exclusive upper bound (UTC instant). */
  to: Date;
}

export interface StatsWindows {
  /** Since local midnight of the current day, up to `now`. */
  today: Window;
  /** Current local day plus the previous 6 local days (7 days total), up to `now`. */
  last7: Window;
  /** Current local day plus the previous 29 local days (30 days total), up to `now`. */
  last30: Window;
  /** Open-ended: from the caller-supplied epoch to `now`. */
  all: Window;
}

/**
 * Formats `instant` as the local wall-clock date/time in `timeZone`, then reads
 * the numeric fields back out. Used to locate the local day containing `now`.
 */
function localParts(instant: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number.parseInt(part.value, 10) : 0;
  };

  // `hour` can render as "24" for midnight in some locales/engines; normalise.
  const hour = read('hour') % 24;

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour,
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * Returns the UTC instant of a given local wall-clock time in `timeZone`.
 *
 * The naive guess is `Date.UTC(...)` of the wall-clock fields; the offset is the
 * difference between that guess and how the zone actually renders it. One
 * correction pass is enough for every real zone (DST transitions can be off by
 * the shift amount in the ambiguous hour, which is harmless here because we only
 * ever resolve local *midnight* — a boundary that DST shifts never split).
 */
function zonedTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
): Date {
  const guessUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const guess = new Date(guessUtc);
  const rendered = localParts(guess, timeZone);
  const renderedAsUtc = Date.UTC(
    rendered.year,
    rendered.month - 1,
    rendered.day,
    rendered.hour,
    rendered.minute,
    rendered.second,
  );
  const offsetMs = renderedAsUtc - guessUtc;
  return new Date(guessUtc - offsetMs);
}

/**
 * UTC instant of local midnight for the calendar day `daysAgo` days before the
 * local day that contains `now`, in `timeZone`.
 */
export function localMidnight(now: Date, timeZone: string, daysAgo = 0): Date {
  const local = localParts(now, timeZone);
  // Step back by whole local days on a UTC calendar anchor, then re-resolve the
  // local midnight. Day arithmetic on the UTC date is safe here because we only
  // use it to identify a calendar date, not to preserve a time-of-day.
  const anchor = new Date(Date.UTC(local.year, local.month - 1, local.day, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() - daysAgo);
  return zonedTimeToUtc(
    timeZone,
    anchor.getUTCFullYear(),
    anchor.getUTCMonth() + 1,
    anchor.getUTCDate(),
  );
}

/**
 * Builds the four windows used by `/gamestats`.
 *
 * - `today`  = [local midnight today, now]      (calendar day in `timeZone`)
 * - `last7`  = [now − 7 d, now]                  (rolling, to the millisecond)
 * - `last30` = [now − 30 d, now]                 (rolling, to the millisecond)
 * - `all`    = [epoch, now]
 *
 * The rolling windows are measured back from the exact `now` instant, matching
 * `/stats` (which uses `now − n × 24 h`). They still *clip* sessions to the
 * window, so `/gamestats` and `/stats` now differ only for sessions that
 * straddle a window edge: `/stats` counts those in full, `/gamestats` only the
 * in-window part. `today` is intentionally calendar-based and therefore can
 * still differ from a naive 24-hour count.
 *
 * Windows are `[from, to)` with `to === now`.
 */
export function computeStatsWindows(now: Date, timeZone: string): StatsWindows {
  const dayMs = 24 * 60 * 60 * 1000;
  return {
    today: { from: localMidnight(now, timeZone, 0), to: now },
    last7: { from: new Date(now.getTime() - 7 * dayMs), to: now },
    last30: { from: new Date(now.getTime() - 30 * dayMs), to: now },
    all: { from: new Date(0), to: now },
  };
}

/**
 * Overlap in seconds between `[start, end]` and `[from, to)`, clamped at zero.
 * Pure helper backing the SQL window math; kept here so unit tests can assert
 * the same clipping semantics the database applies.
 */
export function overlapSeconds(start: Date, end: Date, from: Date, to: Date): number {
  const lo = Math.max(start.getTime(), from.getTime());
  const hi = Math.min(end.getTime(), to.getTime());
  if (hi <= lo) return 0;
  return Math.floor((hi - lo) / 1000);
}
