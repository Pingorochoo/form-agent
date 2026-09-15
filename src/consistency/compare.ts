/**
 * Deterministic kind-aware canonical answer comparison (P4-R8).
 *
 * The comparator normalizes accepted values *without mutating the draft* and
 * without semantic paraphrase or synonym inference. Different structural kinds
 * are never coerced into each other: `answersEqual` returns `false` when the
 * two value kinds differ (callers gate on same-kind before comparing).
 *
 * Implementation: each value is folded to a deterministic canonical string
 * (prefixed per kind so cross-kind collisions are impossible), then the two
 * canonical strings are compared. This keeps the comparison pure and avoids
 * any dependence on object key iteration order.
 */

import type { DraftValue } from '../domain/draft.ts';

/** Structural kinds the accepted comparator can compare. */
const COMPARABLE_KINDS: ReadonlySet<string> = new Set([
  'text',
  'paragraph-text',
  'single-choice',
  'multi-choice',
  'linear-scale',
  'multiple-choice-grid',
  'date',
  'time',
]);

export function isComparableKind(kind: string): boolean {
  return COMPARABLE_KINDS.has(kind);
}

/** Trim outer whitespace and collapse internal whitespace runs; preserve case. */
function normalizeFreeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Fold an accepted value to a stable, collision-safe canonical string. */
function canonical(value: DraftValue): string {
  switch (value.kind) {
    case 'text':
    case 'paragraph-text':
      return `t:${normalizeFreeText(value.value)}`;
    case 'single-choice':
      return `s:${JSON.stringify(value.value)}`;
    case 'multi-choice':
      return `m:${JSON.stringify([...new Set(value.value)].sort())}`;
    case 'linear-scale':
      return `l:${value.value}`;
    case 'multiple-choice-grid':
      return `g:${JSON.stringify(
        Object.entries(value.value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      )}`;
    case 'date':
      return `d:${value.value.year}-${value.value.month}-${value.value.day}`;
    case 'time':
      return `c:${value.value.hour}:${value.value.minute}`;
    default:
      return `u`;
  }
}

/**
 * Compare two accepted draft values of the same structural kind.
 *
 * Never coerces kinds: mismatched `kind` discriminators are simply not equal.
 */
export function answersEqual(a: DraftValue, b: DraftValue): boolean {
  if (a.kind !== b.kind) return false;
  return canonical(a) === canonical(b);
}
