/** Calendar-week price policy shared by catalogue, connections and quotes. */
export const PRICE_FRESHNESS_POLICY_VERSION = 'stockholm-calendar-week-v1';
export const PRICE_TIME_ZONE = 'Europe/Stockholm';
const dayMs = 86_400_000;
const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: PRICE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
// A catalogue has thousands of observations in the same week. Resolve the time
// zone once per week, including its DST transition, rather than once per product.
const weeks: Array<{start: number; end: number}> = [];
function localParts(time: number) {
  const parts = Object.fromEntries(formatter.formatToParts(time).map(p => [p.type, p.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
}
function localMidnightUtc(local: number) {
  let utc = local;
  for (let i = 0; i < 2; i++) utc = local - (localParts(utc) - utc);
  return utc;
}
/** Exclusive end: next Monday 00:00 in Swedish time, including DST and New Year. */
export function calendarWeekEnd(timestamp: number): number {
  if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) return NaN;
  for (const week of weeks) if (timestamp >= week.start && timestamp < week.end) return week.end;
  const local = new Date(localParts(timestamp));
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const nextMonday = midnight + (8 - (local.getUTCDay() || 7)) * dayMs;
  const end = localMidnightUtc(nextMonday), start = localMidnightUtc(nextMonday - 7 * dayMs);
  if (weeks.length >= 16) weeks.shift();
  weeks.push({start, end});
  return end;
}
export function scanIsCurrent(timestamp: number, now = Date.now()): boolean {
  return Number.isFinite(timestamp) && Number.isFinite(now) && timestamp <= now + 60_000
    && calendarWeekEnd(timestamp) === calendarWeekEnd(now);
}
