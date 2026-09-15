/**
 * Strict RFC3339/ISO-8601 time-filter parsing (P7-R15).
 *
 * The grammar is validated explicitly BEFORE any parse: a full date AND time
 * component are required, plus an explicit timezone (`Z` or `±HH:MM`). Bare
 * `Date.parse` is deliberately NOT the grammar validator: date-only and
 * local-time-without-zone values are rejected deterministically, and no
 * natural-language/relative parser exists.
 */

const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Parse a strict RFC3339 timestamp to epoch ms, or null when invalid. */
export function parseIsoTimestamp(value: string): number | null {
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8] ?? '';

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  if (zone !== 'Z' && zone !== 'z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (!Number.isInteger(offsetHours) || !Number.isInteger(offsetMinutes)) return null;
    if (offsetHours > 23 || offsetMinutes > 59) return null;
  }

  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Render epoch ms as a canonical UTC ISO string (for stable export output). */
export function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}
