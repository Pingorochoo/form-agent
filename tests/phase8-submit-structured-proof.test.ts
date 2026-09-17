/**
 * Phase 8 submit structured-proof override (P8-R9, AX / §9.1).
 *
 * An observed submit exit code alone never proves safety. Exit 0/2/3 is safe
 * only with the accepted machine document; missing/malformed/unrecognized output
 * after start is `unknown_outcome`. The `run --json-error` document is on stdout.
 */

import { describe, expect, it } from 'vitest';

import { classifySubmitResult } from '../src/openclaw/adapter.ts';
import {
  SUBMIT_CLAIM_IDENTITY,
  exitResult,
  runErrorDoc,
  submitSuccessDoc,
  submitUnknownDoc,
} from './support/phase8.ts';

const classify = (result: Parameters<typeof classifySubmitResult>[0]) =>
  classifySubmitResult(result, SUBMIT_CLAIM_IDENTITY);

describe('Finding P strict started-submit proof', () => {
  function successDoc(mutate: (doc: Record<string, any>) => void): string {
    const doc = JSON.parse(submitSuccessDoc()) as Record<string, any>;
    mutate(doc);
    return JSON.stringify(doc);
  }

  it('P4/P5: preflight-mode error documents never prove a started submit outcome', () => {
    const docs: Array<{ code: string; kind: 'usage' | 'block'; exit: number }> = [
      { code: 'EXECUTION_TARGET_UNSUPPORTED', kind: 'usage', exit: 2 },
      { code: 'EXECUTION_NOT_AUTHORIZED', kind: 'block', exit: 3 },
    ];
    for (const testCase of docs) {
      const result = classify(exitResult(testCase.exit, runErrorDoc(testCase.code, testCase.kind, 'preflight')));
      expect(result.ambiguous).toBe(true);
      expect(result.category).toBe('unknown_outcome');
    }
  });

  it('P6/P7: missing/empty/non-string error.code is not proof', () => {
    const badDocs = [
      JSON.stringify({ command: 'run', mode: 'submit', ok: false, error: { kind: 'usage' } }),
      JSON.stringify({ command: 'run', mode: 'submit', ok: false, error: { code: '', kind: 'block' } }),
      JSON.stringify({ command: 'run', mode: 'submit', ok: false, error: { code: 42, kind: 'block' } }),
    ];
    for (const doc of badDocs) {
      expect(classify(exitResult(2, doc)).ambiguous).toBe(true);
      expect(classify(exitResult(3, doc)).ambiguous).toBe(true);
    }
  });

  it('P8: minimal {command,mode,outcome:"success"} is not success proof', () => {
    const result = classify(exitResult(0, JSON.stringify({ command: 'run', mode: 'submit', outcome: 'success' })));
    expect(result.ambiguous).toBe(true);
    expect(result.category).toBe('unknown_outcome');
  });

  it('P9/P10/P11/P12: wrong planId/targetKey/targetDisplay/operator -> unknown_outcome', () => {
    const cases: Array<(doc: Record<string, any>) => void> = [
      (doc) => { doc.plan.planId = 'e'.repeat(64); },
      (doc) => { doc.plan.target.key = 'fixture:other'; },
      (doc) => { doc.plan.target.display = 'other'; },
      (doc) => { doc.receipt.operator = 'telegram:9999999'; },
    ];
    for (const mutate of cases) {
      const result = classify(exitResult(0, successDoc(mutate)));
      expect(result.ambiguous).toBe(true);
      expect(result.category).toBe('unknown_outcome');
    }
  });

  it('P13/P14: submitAttempted !== true or wrong receipt state/outcome/outcomeCode -> unknown_outcome', () => {
    const cases: Array<(doc: Record<string, any>) => void> = [
      (doc) => { doc.receipt.submitAttempted = false; },
      (doc) => { doc.receipt.state = 'unknown_outcome'; },
      (doc) => { doc.receipt.outcome = 'unknown_outcome'; },
      (doc) => { doc.receipt.outcomeCode = 'SOMETHING_ELSE'; },
    ];
    for (const mutate of cases) {
      const result = classify(exitResult(0, successDoc(mutate)));
      expect(result.ambiguous).toBe(true);
      expect(result.category).toBe('unknown_outcome');
    }
  });

  it('P15: malformed runId/fingerprint/softIssues -> unknown_outcome', () => {
    const cases: Array<(doc: Record<string, any>) => void> = [
      (doc) => { doc.runId = 'not-a-number'; },
      (doc) => { doc.plan.fingerprint = 'xyz'; },
      (doc) => { doc.plan.consistency.softIssues = -1; },
      (doc) => { doc.plan.consistency.softIssues = 1.5; },
    ];
    for (const mutate of cases) {
      const result = classify(exitResult(0, successDoc(mutate)));
      expect(result.ambiguous).toBe(true);
      expect(result.category).toBe('unknown_outcome');
    }
  });

  it('P16: exact accepted success JSON bound to the exact claimed identity -> ok_submit_success', () => {
    const result = classify(exitResult(0, submitSuccessDoc()));
    expect(result.ambiguous).toBe(false);
    expect(result.category).toBe('ok_submit_success');
    expect(result.data).toEqual({
      runId: 9,
      planId: SUBMIT_CLAIM_IDENTITY.planId,
      targetDisplay: SUBMIT_CLAIM_IDENTITY.targetDisplay,
      fingerprint: 'f'.repeat(64),
      receiptState: 'success',
      submitAttempted: true,
      outcome: 'success',
      outcomeCode: 'SUBMISSION_CONFIRMED',
      operator: SUBMIT_CLAIM_IDENTITY.operator,
      consistencySoftIssues: 0,
    });
  });
});

describe('Finding B closed run --json-error document', () => {
  it('B1/B2/B3: exact current submit usage/block/already-claimed docs are accepted', () => {
    expect(classify(exitResult(2, runErrorDoc('EXECUTION_TARGET_UNSUPPORTED', 'usage', 'submit'))).category).toBe('usage_error');
    expect(classify(exitResult(3, runErrorDoc('EXECUTION_NOT_AUTHORIZED', 'block', 'submit'))).category).toBe('blocked_submit');
    expect(classify(exitResult(3, runErrorDoc('SUBMISSION_ALREADY_CLAIMED', 'block', 'submit'))).category).toBe('already_claimed');
  });

  it('B4: an extra outer authority-bearing field is not proof', () => {
    const doc = JSON.stringify({
      command: 'run',
      mode: 'submit',
      ok: false,
      error: { code: 'EXECUTION_TARGET_UNSUPPORTED', kind: 'usage' },
      outcome: 'success',
    });
    const result = classify(exitResult(2, doc));
    expect(result.ambiguous).toBe(true);
    expect(result.category).toBe('unknown_outcome');
  });

  it('B5: an extra nested error field is not proof', () => {
    const doc = JSON.stringify({
      command: 'run',
      mode: 'submit',
      ok: false,
      error: { code: 'EXECUTION_NOT_AUTHORIZED', kind: 'block', safe: true },
    });
    const result = classify(exitResult(3, doc));
    expect(result.ambiguous).toBe(true);
    expect(result.category).toBe('unknown_outcome');
  });
});

describe('classifySubmitResult', () => {
  it('exit 0 + valid success JSON -> ok_submit_success', () => {
    const result = classify(exitResult(0, submitSuccessDoc()));
    expect(result.ambiguous).toBe(false);
    expect(result.category).toBe('ok_submit_success');
    expect(result.formAgentExitCode).toBe(0);
    expect(result.data).toMatchObject({ outcome: 'success', submitAttempted: true });
  });

  it('exit 0 + missing/malformed success JSON -> ambiguous unknown_outcome', () => {
    for (const stdout of ['', 'not json', '{}', JSON.stringify({ command: 'run' })]) {
      const result = classify(exitResult(0, stdout));
      expect(result.ambiguous).toBe(true);
      expect(result.category).toBe('unknown_outcome');
    }
  });

  it('exit 0/1 + form-agent unknown_outcome -> ambiguous unknown_outcome', () => {
    for (const code of [0, 1]) {
      const result = classify(exitResult(code, submitUnknownDoc()));
      expect(result.ambiguous).toBe(true);
      expect(result.category).toBe('unknown_outcome');
    }
  });

  it('exit 2 + stdout structured usage proof -> usage_error', () => {
    const result = classify(exitResult(2, runErrorDoc('EXECUTION_TARGET_UNSUPPORTED', 'usage', 'submit')));
    expect(result.ambiguous).toBe(false);
    expect(result.category).toBe('usage_error');
    expect(result.formAgentExitCode).toBe(2);
  });

  it('exit 2 + malformed/missing doc -> ambiguous unknown_outcome', () => {
    for (const stdout of ['', 'blocked for reasons', JSON.stringify({ command: 'run', ok: false })]) {
      const result = classify(exitResult(2, stdout));
      expect(result.ambiguous).toBe(true);
      expect(result.category).toBe('unknown_outcome');
    }
  });

  it('exit 3 + structured block proof -> blocked_submit', () => {
    const result = classify(exitResult(3, runErrorDoc('EXECUTION_NOT_AUTHORIZED', 'block', 'submit')));
    expect(result.ambiguous).toBe(false);
    expect(result.category).toBe('blocked_submit');
  });

  it('exit 3 + SUBMISSION_ALREADY_CLAIMED proof -> already_claimed', () => {
    const result = classify(exitResult(3, runErrorDoc('SUBMISSION_ALREADY_CLAIMED', 'block', 'submit')));
    expect(result.ambiguous).toBe(false);
    expect(result.category).toBe('already_claimed');
  });

  it('exit 3 + malformed/missing doc -> ambiguous unknown_outcome', () => {
    for (const stdout of ['', 'boom', JSON.stringify({ command: 'run', ok: false, error: {} })]) {
      const result = classify(exitResult(3, stdout));
      expect(result.ambiguous).toBe(true);
      expect(result.category).toBe('unknown_outcome');
    }
  });

  it('exit 1 + generic structured error document -> ambiguous unknown_outcome (never a proven terminal)', () => {
    // `run --json-error` with kind:"error" only names an error class; it does
    // not prove that no submit action occurred. Generic exit-1 is NOT in the
    // frozen UNAMBIGUOUS terminal list.
    const result = classify(exitResult(1, runErrorDoc('EXECUTION_BROWSER_ERROR', 'error', 'submit')));
    expect(result.ambiguous).toBe(true);
    expect(result.category).toBe('unknown_outcome');
    expect(result.formAgentExitCode).toBe(1);
  });

  it('exit 1 + malformed/non-proof output -> ambiguous unknown_outcome', () => {
    const result = classify(exitResult(1, 'unstructured failure'));
    expect(result.ambiguous).toBe(true);
    expect(result.category).toBe('unknown_outcome');
  });

  it('K4: a valid first JSON document followed by trailing junk is NOT proof', () => {
    const stdout = `${runErrorDoc('EXECUTION_TARGET_UNSUPPORTED', 'usage', 'submit')}\nUNTRUSTED TRAILING OUTPUT`;
    const result = classify(exitResult(2, stdout));
    expect(result.ambiguous).toBe(true);
    expect(result.category).toBe('unknown_outcome');
  });

  it('K5: two JSON documents on stdout are NOT proof', () => {
    const stdout = `${submitSuccessDoc()}\n${runErrorDoc('EXECUTION_NOT_AUTHORIZED', 'block', 'submit')}`;
    const result = classify(exitResult(0, stdout));
    expect(result.ambiguous).toBe(true);
    expect(result.category).toBe('unknown_outcome');
  });

  it('K6: a valid-looking stderr usage proof with empty stdout is NOT proof (K6)', () => {
    const result = classify(exitResult(2, '', runErrorDoc('EXECUTION_TARGET_UNSUPPORTED', 'usage', 'submit')));
    expect(result.ambiguous).toBe(true);
    expect(result.category).toBe('unknown_outcome');
  });

  it('K7: a valid-looking stderr block proof with malformed stdout is NOT proof (K7)', () => {
    const result = classify(exitResult(3, 'not json', runErrorDoc('EXECUTION_NOT_AUTHORIZED', 'block', 'submit')));
    expect(result.ambiguous).toBe(true);
    expect(result.category).toBe('unknown_outcome');
  });

  it('K7b: stderr never supplies success proof', () => {
    const result = classify(exitResult(0, '', submitSuccessDoc()));
    expect(result.ambiguous).toBe(true);
    expect(result.category).toBe('unknown_outcome');
  });

  it('timeout/output-cap/loss after start is always ambiguous with a null exit code', () => {
    const timeout = classify({
      kind: 'timeout',
      stdout: submitSuccessDoc(),
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      pid: 1,
      processGroup: 1,
      signal: 'SIGTERM',
    });
    expect(timeout.ambiguous).toBe(true);
    expect(timeout.formAgentExitCode).toBeNull();

    const cap = classify({
      kind: 'output_cap',
      stream: 'stdout',
      stdout: '',
      stderr: '',
      pid: 1,
      processGroup: 1,
      signal: null,
    });
    expect(cap.ambiguous).toBe(true);
    expect(cap.formAgentExitCode).toBeNull();
  });
});
