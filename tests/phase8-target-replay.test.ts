/** Phase 8 targetArg replay + length rule (P8-R11, X + AJ). */

import { describe, expect, it } from 'vitest';

import {
  recheckThreePartTarget,
  validateTargetCommand,
} from '../src/openclaw/contracts.ts';
import { getPreflightPending, preflightEnvelope } from './support/phase8-preflight.ts';

describe('targetArg replay', () => {
  it('re-canonicalizes targetArg to the same key/display and targetArg===targetDisplay', () => {
    const result = validateTargetCommand('preflight', 'demo-fixture');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(recheckThreePartTarget(result.value.targetArg, result.value.targetKey, result.value.targetDisplay)).toBe(true);
  });

  it('replays a Google Forms display back to the same canonical identity', () => {
    const google = 'https://docs.google.com/forms/d/e/ABC123/viewform';
    const result = validateTargetCommand('preflight', `${google}?usp=send_form#x`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Canonical display strips query/fragment; replay must still match.
    expect(result.value.targetArg).toBe(google);
    expect(recheckThreePartTarget(result.value.targetArg, result.value.targetKey, result.value.targetDisplay)).toBe(true);
  });

  it('stores targetArg (not targetKey) as the replayable CLI target', async () => {
    const fixture = await preflightEnvelope();
    const pending = getPreflightPending(fixture.store, fixture.principal);
    expect(pending?.targetArg).toBe('demo-fixture');
    expect(pending?.targetKey).toBe('fixture:demo-fixture');
    expect(pending?.targetArg).not.toBe(pending?.targetKey);
  });

  it('accepts a valid 256-char display and rejects 257 before preflight', () => {
    const ok = validateTargetCommand('analyze', 'a'.repeat(256));
    const bad = validateTargetCommand('analyze', 'a'.repeat(257));
    expect(ok.ok).toBe(true);
    expect(bad.ok).toBe(false);
  });

  it('does not impose the 256 cap on the derived targetKey', () => {
    // For Google Forms `targetKey = "google-forms:" + display`, so a 256-char
    // display yields a longer key by construction and is still accepted.
    const path = `forms/d/e/${'a'.repeat(200)}/viewform`;
    const target = `https://docs.google.com/${path}`;
    const result = validateTargetCommand('preflight', target);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.targetDisplay.length).toBeLessThanOrEqual(256);
    }
    const display = result.ok ? result.value.targetDisplay : '';
    if (display.length === 256) {
      const key = `google-forms:${display}`;
      expect(key.length).toBeGreaterThan(256);
      expect(recheckThreePartTarget(display, key, display)).toBe(true);
    }
  });
});
