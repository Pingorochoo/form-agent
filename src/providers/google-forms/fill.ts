/**
 * Google Forms fill/verify mechanics (P5-R10, P5-R12).
 *
 * Implements the accepted executable answer kinds: text, paragraph-text,
 * single-choice, multi-choice, linear-scale, multiple-choice-grid (single
 * selection), date, time. Each fill performs a real DOM action and each verify
 * reads the actual browser state back — a successful Playwright action is never
 * treated as proof of correctness (P5-R12 / DOM fill verification).
 *
 * No checkbox-grid, no file upload, no force-clicks. Ambiguity and
 * not-found both fail closed with stable codes.
 */

import type { Locator } from 'playwright';

import type { ChoiceGridQuestion } from '../../domain/types.ts';
import type { DraftDateValue, DraftTimeValue, DraftValue } from '../../domain/draft.ts';
import { ExecutionPreSubmitError } from '../../execution/errors.ts';
import { EXECUTION_PRE_SUBMIT_CODES } from '../../domain/execution.ts';
import type { ExecutionFillItem } from '../../domain/execution.ts';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatDateValue(value: DraftDateValue): string {
  return `${value.year}-${pad2(value.month)}-${pad2(value.day)}`;
}

export function formatTimeValue(value: DraftTimeValue): string {
  return `${pad2(value.hour)}:${pad2(value.minute)}`;
}

function kindError(code: string, message: string): never {
  throw new ExecutionPreSubmitError(code, message);
}

function locateTextControl(container: Locator, kind: 'text' | 'paragraph-text'): Locator {
  if (kind === 'paragraph-text') return container.locator('textarea');
  return container.locator('input[type="text"], input:not([type])');
}

/** The DOM row for a grid row, by accepted row order (index). */
function gridRow(container: Locator, index: number): Locator {
  return container.locator('tbody tr').nth(index);
}

/** The checked column label of a grid row (single-select), or null. */
async function checkedGridColumn(row: Locator): Promise<string | null> {
  const radios = row.getByRole('radio');
  const count = await radios.count();
  for (let i = 0; i < count; i++) {
    const radio = radios.nth(i);
    if (await radio.isChecked()) {
      return await radio.getAttribute('aria-label');
    }
  }
  return null;
}

async function assertSingle(locator: Locator, what: string): Promise<Locator> {
  const count = await locator.count();
  if (count === 0) {
    kindError(EXECUTION_PRE_SUBMIT_CODES.LOCATOR_NOT_FOUND, `could not locate ${what}`);
  }
  if (count > 1) {
    kindError(EXECUTION_PRE_SUBMIT_CODES.LOCATOR_AMBIGUOUS, `ambiguous locator for ${what}`);
  }
  return locator;
}

/**
 * NOTE (value safety): every `what` string passed to `assertSingle` and every
 * error message below is value-free. Only structural ids/kinds/indexes are
 * interpolated — never answer text, selected choice text, or profile values.
 */

/**
 * Fill one answered field into its scoped question container.
 * The container is resolved by the session's section mapping (order-based),
 * never by title alone. The draft value's `kind` drives the mechanics.
 */
export async function fillItem(container: Locator, item: ExecutionFillItem): Promise<void> {
  const question = item.question;
  const value = item.value;

  switch (value.kind) {
    case 'text':
    case 'paragraph-text': {
      const control = await assertSingle(
        locateTextControl(container, value.kind),
        `${value.kind} control for question ${question.id}`,
      );
      await control.fill(value.value);
      return;
    }
    case 'single-choice': {
      const radio = await assertSingle(
        container.getByRole('radio', { name: value.value }),
        `single-choice option for question ${question.id}`,
      );
      await radio.check();
      return;
    }
    case 'multi-choice': {
      for (const choice of value.value) {
        const checkbox = await assertSingle(
          container.getByRole('checkbox', { name: choice }),
          `multi-choice option for question ${question.id}`,
        );
        await checkbox.check();
      }
      return;
    }
    case 'linear-scale': {
      const radio = await assertSingle(
        container.getByRole('radio', { name: String(value.value) }),
        `linear-scale option for question ${question.id}`,
      );
      await radio.check();
      return;
    }
    case 'multiple-choice-grid': {
      const grid = question as ChoiceGridQuestion;
      const rows = grid.rows;
      const byRow = value.value;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row === undefined) continue;
        const column = byRow[row.id];
        if (column === undefined) {
          kindError(
            EXECUTION_PRE_SUBMIT_CODES.FILL_VERIFICATION_FAILED,
            `grid row index ${i} has no accepted column for question ${question.id}`,
          );
        }
        const cell = await assertSingle(
          gridRow(container, i).getByRole('radio', { name: column }),
          `grid row index ${i} for question ${question.id}`,
        );
        await cell.check();
      }
      return;
    }
    case 'date':
    case 'time': {
      const expected = value.kind === 'date' ? formatDateValue(value.value) : formatTimeValue(value.value);
      const control = await assertSingle(
        container.locator('input[type="text"], input:not([type])'),
        `${value.kind} control for question ${question.id}`,
      );
      await control.fill(expected);
      return;
    }
    default:
      kindError(
        EXECUTION_PRE_SUBMIT_CODES.KIND_UNSUPPORTED,
        `unsupported fill kind "${(value as DraftValue).kind}" for question ${question.id}`,
      );
  }
}

/** Verify the browser DOM actually reflects the intended accepted value. */
export async function verifyFilledItem(container: Locator, item: ExecutionFillItem): Promise<void> {
  const question = item.question;
  const value = item.value;
  const id = question.id;

  switch (value.kind) {
    case 'text':
    case 'paragraph-text': {
      const control = await assertSingle(
        locateTextControl(container, value.kind),
        `${value.kind} control for question ${id}`,
      );
      const actual = await control.inputValue();
      if (actual !== value.value) {
        kindError(
          EXECUTION_PRE_SUBMIT_CODES.FILL_VERIFICATION_FAILED,
          `DOM value mismatch for question ${id}`,
        );
      }
      return;
    }
    case 'single-choice': {
      const radio = await assertSingle(
        container.getByRole('radio', { name: value.value }),
        `single-choice option for question ${id}`,
      );
      if (!(await radio.isChecked())) {
        kindError(
          EXECUTION_PRE_SUBMIT_CODES.FILL_VERIFICATION_FAILED,
          `single-choice not selected for question ${id}`,
        );
      }
      return;
    }
    case 'multi-choice': {
      const selected = new Set(value.value);
      const checkboxes = container.getByRole('checkbox');
      const count = await checkboxes.count();
      let checkedCount = 0;
      for (let i = 0; i < count; i++) {
        const checkbox = checkboxes.nth(i);
        const choice = await checkbox.getAttribute('value');
        if (await checkbox.isChecked()) {
          checkedCount += 1;
          if (choice === null || !selected.has(choice)) {
            kindError(
              EXECUTION_PRE_SUBMIT_CODES.FILL_VERIFICATION_FAILED,
              `unexpected checkbox checked for question ${id}`,
            );
          }
        }
      }
      if (checkedCount !== selected.size) {
        kindError(
          EXECUTION_PRE_SUBMIT_CODES.FILL_VERIFICATION_FAILED,
          `multi-choice selected set mismatch for question ${id}`,
        );
      }
      return;
    }
    case 'linear-scale': {
      const radio = await assertSingle(
        container.getByRole('radio', { name: String(value.value) }),
        `linear-scale option for question ${id}`,
      );
      if (!(await radio.isChecked())) {
        kindError(
          EXECUTION_PRE_SUBMIT_CODES.FILL_VERIFICATION_FAILED,
          `linear-scale not selected for question ${id}`,
        );
      }
      return;
    }
    case 'multiple-choice-grid': {
      const grid = question as ChoiceGridQuestion;
      const rows = grid.rows;
      const byRow = value.value;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row === undefined) continue;
        const column = byRow[row.id];
        const actual = await checkedGridColumn(gridRow(container, i));
        if (actual !== column) {
          kindError(
            EXECUTION_PRE_SUBMIT_CODES.FILL_VERIFICATION_FAILED,
            `grid row index ${i} mismatch for question ${id}`,
          );
        }
      }
      return;
    }
    case 'date':
    case 'time': {
      const expected = value.kind === 'date' ? formatDateValue(value.value) : formatTimeValue(value.value);
      const control = await assertSingle(
        container.locator('input[type="text"], input:not([type])'),
        `${value.kind} control for question ${id}`,
      );
      const actual = await control.inputValue();
      if (actual !== expected) {
        kindError(
          EXECUTION_PRE_SUBMIT_CODES.FILL_VERIFICATION_FAILED,
          `DOM ${value.kind} value mismatch for question ${id}`,
        );
      }
      return;
    }
    default:
      kindError(
        EXECUTION_PRE_SUBMIT_CODES.KIND_UNSUPPORTED,
        `unsupported verify kind "${(value as DraftValue).kind}" for question ${id}`,
      );
  }
}
