/**
 * CLI exit-code contract tests.
 *
 * These are the stability guarantees CI / OpenClaw / Telegram build on.
 */

import { describe, expect, it } from 'vitest';

import {
  EXIT_CODE_MAX,
  EXIT_CODE_MIN,
  ExitCodes,
  describeExitCode,
  isValidExitCode,
} from '../src/cli/exit-codes.ts';

describe('exit-code contract', () => {
  it('defines the full documented set', () => {
    expect(ExitCodes.SUCCESS).toBe(0);
    expect(ExitCodes.ERROR).toBe(1);
    expect(ExitCodes.USAGE).toBe(2);
    expect(ExitCodes.VALIDATION).toBe(3);
    expect(ExitCodes.LLM_OFFLINE).toBe(4);
    expect(ExitCodes.LLM_CONNECTIVITY).toBe(5);
    expect(ExitCodes.UNKNOWN_COMMAND).toBe(127);
  });

  it('never exposes a negative process exit code', () => {
    for (const code of Object.values(ExitCodes)) {
      expect(code).toBeGreaterThanOrEqual(EXIT_CODE_MIN);
      expect(code).toBeLessThanOrEqual(EXIT_CODE_MAX);
      expect(isValidExitCode(code)).toBe(true);
    }
  });

  it('rejects out-of-range codes', () => {
    expect(isValidExitCode(-1)).toBe(false);
    expect(isValidExitCode(-2)).toBe(false);
    expect(isValidExitCode(128)).toBe(false);
    expect(isValidExitCode(1.5)).toBe(false);
    expect(isValidExitCode(Number.NaN)).toBe(false);
  });

  it('preserves the former -1 / -2 meanings at positive codes', () => {
    // The refactor must not silently drop the LLM tiers.
    expect(describeExitCode(ExitCodes.LLM_OFFLINE)).toContain('LLM offline');
    expect(describeExitCode(ExitCodes.LLM_CONNECTIVITY)).toContain('LLM connectivity');
    expect(describeExitCode(ExitCodes.LLM_OFFLINE)).not.toBe(describeExitCode(ExitCodes.LLM_CONNECTIVITY));
  });

  it('describes each code for dashboards', () => {
    expect(describeExitCode(0)).toBe('success');
    expect(describeExitCode(1)).toBe('unexpected error');
    expect(describeExitCode(2)).toBe('bad usage or configuration');
    expect(describeExitCode(3)).toBe('validation/consistency failure');
    expect(describeExitCode(127)).toBe('unknown command');
    expect(describeExitCode(999)).toContain('reserved');
  });

  it('is frozen against accidental reordering', () => {
    expect(Object.keys(ExitCodes)).toEqual([
      'SUCCESS',
      'ERROR',
      'USAGE',
      'VALIDATION',
      'LLM_OFFLINE',
      'LLM_CONNECTIVITY',
      'UNKNOWN_COMMAND',
    ]);
  });
});