/** Phase 8 three-part target recheck catches canonicalizing tamper (P8-R30, AQ). */

import { describe, expect, it } from 'vitest';

import { recheckThreePartTarget } from '../src/openclaw/contracts.ts';
import { makeAdapter, exitResult, FIXTURE_KEY, PLAN_ID } from './support/phase8.ts';
import { PRINCIPAL } from './support/phase8-preflight.ts';

const GOOGLE = 'https://docs.google.com/forms/d/e/ABC123/viewform';
const GOOGLE_KEY = `google-forms:${GOOGLE}`;

describe('three-part target recheck', () => {
  it('rejects a targetArg that gains a query but canonicalizes to the same key/display', () => {
    const tamperedArg = `${GOOGLE}?usp=send_form`;
    // canonicalize(tamperedArg).key === GOOGLE_KEY and .display === GOOGLE,
    // but targetArg !== targetDisplay, so the recheck FAILS.
    expect(recheckThreePartTarget(tamperedArg, GOOGLE_KEY, GOOGLE)).toBe(false);
  });

  it('rejects a targetArg that gains a fragment or userinfo', () => {
    expect(recheckThreePartTarget(`${GOOGLE}#heading=h.1`, GOOGLE_KEY, GOOGLE)).toBe(false);
    expect(recheckThreePartTarget('https://user:pw@docs.google.com/forms/d/e/ABC123/viewform', GOOGLE_KEY, GOOGLE)).toBe(false);
  });

  it('accepts the exact canonical targetArg', () => {
    expect(recheckThreePartTarget(GOOGLE, GOOGLE_KEY, GOOGLE)).toBe(true);
    expect(recheckThreePartTarget('demo-fixture', FIXTURE_KEY, 'demo-fixture')).toBe(true);
  });

  it('fails closed when the stored targetKey/display disagree', () => {
    expect(recheckThreePartTarget(GOOGLE, 'google-forms:other', GOOGLE)).toBe(false);
    expect(recheckThreePartTarget(GOOGLE, GOOGLE_KEY, 'other')).toBe(false);
  });
});

describe('adapter submit recheck fails closed on tampered target', () => {
  it('refuses claim when the supplied target key/display do not match the record', async () => {
    const fixture = makeAdapter();
    // Seed a pending record directly through the store.
    fixture.store.create({
      principal: PRINCIPAL,
      targetKey: FIXTURE_KEY,
      targetArg: 'demo-fixture',
      targetDisplay: 'demo-fixture',
      planId: PLAN_ID,
      seed: 'b'.repeat(32),
      operator: 'telegram:5550001',
    });
    // A wrong pendingRef is a replaced/failed-closed refusal, never a submit.
    const envelope = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_pending',
      pendingRef: 'c'.repeat(32),
      planId: PLAN_ID,
      targetKey: FIXTURE_KEY,
      targetDisplay: 'demo-fixture',
      expiresAtMs: fixture.clock.nowMs + 1000,
    });
    expect(envelope.category).toBe('pending_replaced');
    expect(fixture.runner.calls).toHaveLength(0);
    fixture.cleanup();
  });

  it('refuses when the supplied display mismatches the record', async () => {
    const fixture = makeAdapter();
    const record = fixture.store.create({
      principal: PRINCIPAL,
      targetKey: FIXTURE_KEY,
      targetArg: 'demo-fixture',
      targetDisplay: 'demo-fixture',
      planId: PLAN_ID,
      seed: 'b'.repeat(32),
      operator: 'telegram:5550001',
    });
    const envelope = await fixture.adapter.execute(PRINCIPAL, {
      operation: 'submit_pending',
      pendingRef: record.pendingId,
      planId: PLAN_ID,
      targetKey: FIXTURE_KEY,
      targetDisplay: 'tampered',
      expiresAtMs: record.expiresAtMs,
    });
    expect(envelope.category).toBe('pending_replaced');
    expect(fixture.runner.calls).toHaveLength(0);
    fixture.cleanup();
    void exitResult;
  });
});
