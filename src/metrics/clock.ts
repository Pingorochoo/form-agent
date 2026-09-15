/**
 * Injectable timing for Phase 7 metrics (P7-R7).
 *
 * Durations use a MONOTONIC source (`performance.now()`); `at_ms` storage uses
 * normalized wall-clock epoch milliseconds. Both are injectable/controllable so
 * unit tests never sleep and never depend on wall-clock deltas.
 */

import { performance } from 'node:perf_hooks';

export interface MetricsClock {
  /** Normalized wall-clock epoch milliseconds (for `at_ms`). */
  wallNowMs(): number;
  /** Monotonic milliseconds (for elapsed command duration). */
  monotonicNowMs(): number;
}

export const systemMetricsClock: MetricsClock = {
  wallNowMs: () => Date.now(),
  monotonicNowMs: () => performance.now(),
};

export interface ElapsedTimer {
  elapsedMs(): number;
}

export function startTimer(clock: MetricsClock = systemMetricsClock): ElapsedTimer {
  const startedAt = clock.monotonicNowMs();
  return { elapsedMs: () => clock.monotonicNowMs() - startedAt };
}
