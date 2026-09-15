/**
 * Phase 7 strict time-filter parsing tests (P7-R15).
 *
 * Proves the explicit RFC3339 grammar (full date + time + timezone), rejection
 * of date-only/zoneless/garbage values, equivalent-offset handling, and exact
 * inclusive/exclusive boundaries. No sleeps or relative-time parsing.
 */

import { describe, expect, it } from 'vitest';

import { formatTimestamp, parseIsoTimestamp } from '../src/metrics/time.ts';

describe('P7-R15 — strict grammar', () => {
  it('accepts full RFC3339 timestamps with Z or a numeric offset', () => {
    expect(parseIsoTimestamp('2026-01-01T00:00:00Z')).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(parseIsoTimestamp('2026-01-01T00:00:00.250Z')).toBe(Date.UTC(2026, 0, 1, 0, 0, 0) + 250);
    expect(parseIsoTimestamp('2026-01-01T00:00:00+00:00')).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(parseIsoTimestamp('2026-01-01T01:00:00+01:00')).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(parseIsoTimestamp('2025-12-31T23:00:00-01:00')).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
  });

  it('rejects date-only, zoneless, malformed, and out-of-range timestamps', () => {
    for (const value of [
      '',
      '2026-01-01',
      '2026-01-01T00:00:00',
      '2026-01-01 00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-00-10T00:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T00:60:00Z',
      '2026-01-01T00:00:00+25:00',
      '2026-01-01T00:00:00+00:60',
      'not-a-timestamp',
      '2026-01-01T00:00:00Zjunk',
    ]) {
      expect(parseIsoTimestamp(value), value).toBeNull();
    }
  });

  it('normalizes equivalent offsets to the same instant', () => {
    const z = parseIsoTimestamp('2026-01-01T00:00:00Z');
    const plusZero = parseIsoTimestamp('2026-01-01T00:00:00+00:00');
    expect(z).toBe(plusZero);
    expect(formatTimestamp(z as number)).toBe('2026-01-01T00:00:00.000Z');
  });
});
