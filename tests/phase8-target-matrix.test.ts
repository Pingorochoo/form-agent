/** Phase 8 §7.3 evidence-based target support matrix (P8-R26). */

import { describe, expect, it } from 'vitest';

import { targetKindAllowed, validateTargetCommand } from '../src/openclaw/contracts.ts';

const FIXTURE = 'demo-fixture';
const GOOGLE = 'https://docs.google.com/forms/d/e/ABC123/viewform';
const OTHER_URL = 'https://example.com/forms/abc';
const FILE_PATH = './fixtures/archives/observed-responder.html';

describe('target support matrix', () => {
  it('allows fixtures for every non-submit operation', () => {
    for (const op of ['analyze', 'draft', 'draft_review', 'check', 'preflight'] as const) {
      expect(validateTargetCommand(op, FIXTURE).ok).toBe(true);
    }
  });

  it('allows google-forms ONLY for preflight', () => {
    expect(validateTargetCommand('preflight', GOOGLE).ok).toBe(true);
    for (const op of ['analyze', 'draft', 'draft_review', 'check'] as const) {
      const result = validateTargetCommand(op, GOOGLE);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects arbitrary https URLs, file paths, and raw strings', () => {
    expect(validateTargetCommand('preflight', OTHER_URL).ok).toBe(false);
    expect(validateTargetCommand('analyze', FILE_PATH).ok).toBe(false);
    expect(validateTargetCommand('preflight', FILE_PATH).ok).toBe(false);
    expect(validateTargetCommand('preflight', 'file:relative/path').ok).toBe(false);
  });

  it('exposes the kind-level matrix for submit (pending only)', () => {
    expect(targetKindAllowed('submit', 'fixture')).toBe(true);
    expect(targetKindAllowed('submit', 'google-forms')).toBe(true);
    expect(targetKindAllowed('submit', 'url')).toBe(false);
    expect(targetKindAllowed('submit', 'file')).toBe(false);
    expect(targetKindAllowed('submit', 'raw')).toBe(false);
  });
});
