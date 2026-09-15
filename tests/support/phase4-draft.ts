/**
 * Shared Phase 4 test helpers: produce a deterministic reference bundle for a
 * synthetic schema. Keeps test files focused on assertions rather than
 * re-wiring the accepted Phase 3 draft pipeline.
 */

import { generateDraft } from '../../src/draft/orchestrate.ts';
import { DeterministicReferenceProvider } from '../../src/draft/reference.ts';
import { BUILTIN_SENSITIVE_RULES } from '../../src/policy/sensitive.ts';
import type { FormSchema } from '../../src/domain/types.ts';
import type { DraftBundle } from '../../src/domain/draft.ts';

export function makeProvider(): DeterministicReferenceProvider {
  return new DeterministicReferenceProvider();
}

export const RULES = BUILTIN_SENSITIVE_RULES;

export async function draft(schema: FormSchema, seed = 'seed-1'): Promise<DraftBundle> {
  return generateDraft({ schema, seed, provider: makeProvider(), sensitiveRules: RULES });
}
