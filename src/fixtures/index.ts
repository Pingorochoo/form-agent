/**
 * Fixture harness.
 *
 * Two fixture sources:
 *   - built-in inline fixtures (programmatic DOM snapshots) used by unit tests
 *   - archived fixtures (fixtures/archives/<id>.html) used by the CI harness
 *     to replay full analyze → preview → approve → run loops without a live
 *     Google server
 *
 * All fixture URLs live under https://fixtures.local/forms/<id> so the config
 * allowlist can safely include them.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { officialSampleSnapshot } from './official-sample.ts';
import { demoSnapshot } from './demo.ts';

export const FIXTURE_HARNESS_BASE = 'https://fixtures.local/forms';

export interface FormFixture {
  id: string;
  url: string;
  title: string;
  description?: string;
  source: 'inline' | 'archive';
  snapshot(): Promise<string>;
}

export const BUILTIN_FIXTURES = ['official', 'demo'] as const;
export type BuiltinFixtureId = (typeof BUILTIN_FIXTURES)[number];

export function isBuiltinFixtureId(value: string): value is BuiltinFixtureId {
  return (BUILTIN_FIXTURES as readonly string[]).includes(value);
}

export function fixtureUrl(id: string): string {
  return `${FIXTURE_HARNESS_BASE}/${id}`;
}

/** Try an archived snapshot at fixtures/archives/<id>.html (repo root). */
export async function tryLoadArchive(id: string): Promise<string | null> {
  const path = resolve(process.cwd(), 'fixtures', 'archives', `${id}.html`);
  if (!existsSync(path)) return null;
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function loadFixture(id: string): Promise<FormFixture> {
  const archive = await tryLoadArchive(id);
  if (archive !== null) {
    return {
      id,
      url: fixtureUrl(id),
      title: id,
      description: `Archive fixture loaded from fixtures/archives/${id}.html`,
      source: 'archive',
      snapshot: async () => archive,
    };
  }
  switch (id) {
    case 'official':
      return {
        id,
        url: fixtureUrl(id),
        title: 'Feedback Form',
        description: 'Official Google Forms sample (feedback, single question)',
        source: 'inline',
        snapshot: officialSampleSnapshot,
      };
    case 'demo':
      return {
        id,
        url: fixtureUrl(id),
        title: 'Demo Harness Form',
        description: 'Exercises text, paragraph, email, single/multi choice, dropdown, linear scale, grids, date, time',
        source: 'inline',
        snapshot: demoSnapshot,
      };
    default:
      throw new Error(`Unknown fixture "${id}" (built-in: ${BUILTIN_FIXTURES.join(', ')})`);
  }
}