/**
 * Decoder for Google Forms' embedded `FB_PUBLIC_LOAD_DATA_` payload.
 *
 * Phase 0 research only: this is NOT the Phase 1 DOM parser. It exists so the
 * observations recorded in docs/phase0.md are reproducible from the committed
 * archive fixture instead of being prose that can drift from the data.
 *
 * The payload is an undocumented, version-specific nested-array serialization.
 * The shapes decoded here were observed on the authorized responder page:
 *
 *   payload = [null, form, ...]
 *   form    = [description, items, ...objects..., title, ?, flags, ...]
 *   item    = [id, title, description?, type, group, ...nulls, [null, title]]
 *   type    = 0 short-answer, 1 paragraph, 2 multiple-choice, 3 dropdown,
 *             4 checkboxes, 5 linear scale, 6 page break, 7 grid,
 *             9 date, 10 time, 13 file upload, 18 rating
 *   group   = [entryId, choices, requiredFlag, placeholderOrRowLabel, ...]
 *             for type 7, group[4..n] are per-row tuples
 *             [rowId, choices, requiredFlag, rowLabel, ...]
 *   choice  = [label, ...rest]
 *   requiredFlag = 1 when required, 0 when optional
 *
 * Only the fields needed for structural analysis are projected; anything not
 * understood stays on the raw item rather than being guessed at.
 */

import type { QuestionKind } from '../domain/types.ts';

/** FormSchema kind (or the `section-break` marker) a payload type code maps to. */
export type ObservedPayloadKind = QuestionKind | 'section-break';

/** Embedded type code -> kind. Phase 1 keys classification off the type code. */
export const EMBEDDED_TYPE_TO_KIND: Readonly<Record<number, ObservedPayloadKind>> = {
  0: 'text',
  1: 'paragraph-text',
  2: 'single-choice',
  3: 'dropdown',
  4: 'multi-choice',
  5: 'linear-scale',
  6: 'section-break',
  // Type 7 is Google's grid. In the observed form every row is single-select
  // (role=radio) so it normalizes to `multiple-choice-grid`; a checkbox grid
  // would be distinguishable by role=checkbox rows and is not present here.
  7: 'multiple-choice-grid',
  9: 'date',
  10: 'time',
  13: 'file-upload',
  18: 'rating',
};

export interface ObservedPayloadSection {
  id: string;
  title: string;
  description: string;
  questionIds: string[];
}

export interface ObservedPayloadQuestion {
  id: string;
  sectionId: string | null;
  kind: ObservedPayloadKind;
  rawType: number;
  required: boolean;
  title: string;
  choices?: string[];
  rowLabels?: string[];
  selectionMode?: 'single' | 'multi';
  validationHints?: { dateFlags?: number[]; timeFlags?: number[] };
}

export interface ObservedPayloadRoutingEvidence {
  /** How many times each section id occurs anywhere in the raw payload. */
  sectionIdOccurrences: Record<string, number>;
  /** True when a section id is re-used, i.e. used as a branch target. */
  anySectionIdAppearsMoreThanOnce: boolean;
  /** Choice-question ids that carry a `goToSection`-style redirect array. */
  conditionalChoices: string[];
  conditionalRoutingDetected: boolean;
}

export interface ObservedPayload {
  title: string;
  description: string;
  /** Version of the payload shape this decoder was written against. */
  generatorVersion: string;
  embeddedShape: {
    payloadTopLevelLength: number;
    formArrayLength: number;
    itemCount: number;
    itemIndices: { id: number; title: number; description: number; type: number; questionGroup: number };
    questionGroupIndices: { entryId: number; choices: number; requiredFlag: number; rowLabelOrPlaceholder: number };
    gridRows: string;
  };
  typeCodeToKind: Readonly<Record<number, ObservedPayloadKind>>;
  sections: ObservedPayloadSection[];
  questions: ObservedPayloadQuestion[];
  routingEvidence: ObservedPayloadRoutingEvidence;
}

/** Normalize a raw choice entry to its label (the first tuple member). */
function choiceLabel(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
  return null;
}

/** `g[0][8]`-style redirect array: a per-choice goToSection target list. */
function hasRoutingArray(group: unknown): boolean {
  if (!Array.isArray(group)) return false;
  return group.some(
    (slot) =>
      Array.isArray(slot) && slot.length > 0 && slot.every((v) => Array.isArray(v) && typeof v[0] === 'number'),
  );
}

/** Extract and parse the embedded payload from responder HTML. */
export function extractPayload(html: string): unknown[] {
  const match = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(\[[\s\S]*?\]);\s*<\/script>/);
  if (match?.[1] === undefined) throw new Error('no FB_PUBLIC_LOAD_DATA_ payload found');
  const parsed: unknown = JSON.parse(match[1]);
  if (!Array.isArray(parsed)) throw new Error('FB_PUBLIC_LOAD_DATA_ payload is not an array');
  return parsed;
}

/** Decode the embedded payload into the documented Phase 0 projection. */
export function decodeEmbeddedPayload(payload: unknown[]): ObservedPayload {
  const form = payload[1];
  if (!Array.isArray(form)) throw new Error('payload[1] (form) is not an array');
  const items = form[1];
  if (!Array.isArray(items)) throw new Error('form[1] (items) is not an array');

  const description = typeof form[0] === 'string' ? form[0] : '';
  const title = typeof form[8] === 'string' ? form[8] : '';

  const sections: ObservedPayloadSection[] = [];
  const questions: ObservedPayloadQuestion[] = [];
  let current: ObservedPayloadSection | null = null;

  const sectionIdCounts = new Map<string, number>();
  for (const item of items) {
    if (Array.isArray(item) && item[3] === 6) {
      const id = String(item[0]);
      sectionIdCounts.set(id, (sectionIdCounts.get(id) ?? 0) + 1);
    }
  }

  for (const raw of items) {
    if (!Array.isArray(raw)) continue;
    const id = raw[0];
    const rawTitle = raw[1];
    const rawDescription = raw[2];
    const type = raw[3];
    const group = raw[4];
    if (typeof type !== 'number') continue;

    if (type === 6) {
      current = {
        id: String(id),
        title: typeof rawTitle === 'string' ? rawTitle.trim() : '',
        description: typeof rawDescription === 'string' ? rawDescription.trim() : '',
        questionIds: [],
      };
      sections.push(current);
      continue;
    }

    const isGrid = type === 7;
    const firstGroup = Array.isArray(group) ? group[0] : undefined;
    const rawChoices = Array.isArray(firstGroup) ? firstGroup[1] : undefined;
    const choices = Array.isArray(rawChoices)
      ? rawChoices.map(choiceLabel).filter((label): label is string => label !== null)
      : [];
    const required = isGrid
      ? Array.isArray(group) && group.some((row) => Array.isArray(row) && row[2] === 1)
      : Array.isArray(firstGroup) && firstGroup[2] === 1;
    const rowLabels =
      isGrid && Array.isArray(group)
        ? group.map((row) => (Array.isArray(row) ? choiceLabel(row[3]) : null)).filter((l): l is string => l !== null)
        : [];
    const dateFlags = type === 9 && Array.isArray(firstGroup?.[7]) ? firstGroup[7] : undefined;
    const timeFlags = type === 10 && Array.isArray(firstGroup?.[6]) ? firstGroup[6] : undefined;

    questions.push({
      id: String(id),
      sectionId: current?.id ?? null,
      kind: EMBEDDED_TYPE_TO_KIND[type] ?? 'unsupported',
      rawType: type,
      required,
      title: typeof rawTitle === 'string' ? rawTitle : '',
      ...(choices.length > 0 ? { choices } : {}),
      ...(rowLabels.length > 0 ? { rowLabels } : {}),
      ...(isGrid ? { selectionMode: 'single' as const } : {}),
      ...(dateFlags !== undefined || timeFlags !== undefined
        ? {
            validationHints: {
              ...(dateFlags !== undefined ? { dateFlags } : {}),
              ...(timeFlags !== undefined ? { timeFlags } : {}),
            },
          }
        : {}),
    });
    current?.questionIds.push(String(id));
  }

  const conditionalChoices: string[] = [];
  for (const question of questions) {
    if (question.kind !== 'single-choice' && question.kind !== 'multi-choice' && question.kind !== 'multiple-choice-grid') {
      continue;
    }
    const item = items.find((candidate) => Array.isArray(candidate) && String(candidate[0]) === question.id);
    if (Array.isArray(item) && hasRoutingArray(item[4])) conditionalChoices.push(question.id);
  }

  return {
    title,
    description,
    generatorVersion: 'phase0-research',
    embeddedShape: {
      payloadTopLevelLength: payload.length,
      formArrayLength: form.length,
      itemCount: items.length,
      itemIndices: { id: 0, title: 1, description: 2, type: 3, questionGroup: 4 },
      questionGroupIndices: { entryId: 0, choices: 1, requiredFlag: 2, rowLabelOrPlaceholder: 3 },
      gridRows: 'g[4..n]: one tuple per row [rowId, choices, requiredFlag, rowLabel, ...]',
    },
    typeCodeToKind: EMBEDDED_TYPE_TO_KIND,
    sections,
    questions,
    routingEvidence: {
      sectionIdOccurrences: Object.fromEntries(sectionIdCounts),
      anySectionIdAppearsMoreThanOnce: [...sectionIdCounts.values()].some((count) => count > 1),
      conditionalChoices,
      conditionalRoutingDetected: conditionalChoices.length > 0,
    },
  };
}