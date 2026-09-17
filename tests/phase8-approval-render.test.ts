/** Phase 8 approval rendering bounds (P8-R10, Z). */

import { describe, expect, it } from 'vitest';

import {
  APPROVAL_DESCRIPTION_MAX,
  APPROVAL_TITLE,
  APPROVAL_TITLE_MAX,
  approvalRenderFits,
  renderApprovalDescription,
} from '../src/openclaw/format.ts';

describe('approval rendering', () => {
  const planId = 'b'.repeat(64);
  const maxDisplay = 'a'.repeat(256);

  it('keeps the fixed title ≤80', () => {
    expect(APPROVAL_TITLE.length).toBeLessThanOrEqual(APPROVAL_TITLE_MAX);
  });

  it('shows the FULL canonical targetDisplay and FULL 64-hex planId within 512 chars at maximum length', () => {
    const description = renderApprovalDescription(maxDisplay, planId, 1_700_000_000_000);
    expect(description.length).toBeLessThanOrEqual(APPROVAL_DESCRIPTION_MAX);
    expect(description).toContain(maxDisplay);
    expect(description).toContain(planId);
    expect(approvalRenderFits(maxDisplay, planId, 1_700_000_000_000)).toBe(true);
  });

  it('contains no answer/secret/HTML fields', () => {
    const description = renderApprovalDescription('demo-fixture', planId, 1_700_000_000_000);
    expect(description.toLowerCase()).not.toContain('apikey');
    expect(description).not.toContain('<');
  });
});
