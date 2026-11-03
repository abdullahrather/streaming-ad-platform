/**
 * src/lib/platform-time.ts
 *
 * Ad schedules and daily limits follow one platform time zone, so "evenings" and
 * "today" mean the same thing for every campaign.
 */
import { env } from '@/config/env';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface LocalTime {
  /** 0 to 23 */
  hour: number;
  /** 0 is Sunday */
  weekday: number;
  /** A date such as 2026-11-03, used to key daily limits. */
  day: string;
}

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: env.PLATFORM_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  weekday: 'short',
});

let cachedMinute = -1;
let cached: LocalTime | null = null;

export const localTimeAt = (time: number): LocalTime => {
  const part = (type: string): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  const parts = formatter.formatToParts(time);

  return {
    hour: Number(part('hour')),
    weekday: WEEKDAYS.indexOf(part('weekday')),
    day: `${part('year')}-${part('month')}-${part('day')}`,
  };
};

/** Ad decisions call this constantly, so the result is kept for a minute. */
export const localTimeNow = (now = Date.now()): LocalTime => {
  const minute = Math.floor(now / 60_000);
  if (minute !== cachedMinute || !cached) {
    cachedMinute = minute;
    cached = localTimeAt(now);
  }
  return cached;
};
