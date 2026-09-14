/**
 * Resolve the `form-agent analyze` input argument into local HTML.
 *
 * Phase 1 is offline and fixture-only. Accepted inputs:
 *   1. a local file path (e.g. `fixtures/archives/observed-responder.html`)
 *   2. a fixture URL (`https://fixtures.local/forms/<id>`)
 *   3. a fixture id (archive name or a built-in id)
 *
 * Live `https://docs.google.com/...` URLs are rejected: Phase 1 performs no
 * network fetch and never touches the external form.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { FIXTURE_HARNESS_BASE, loadFixture } from '../fixtures/index.ts';

export class AnalyzeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyzeInputError';
  }
}

export interface ResolvedAnalyzeInput {
  html: string;
  /** The URL used for `meta.url`. */
  url: string;
  source: 'file' | 'archive' | 'inline';
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function fixtureIdFromArg(arg: string): string | null {
  if (arg.startsWith(`${FIXTURE_HARNESS_BASE}/`)) {
    const rest = arg.slice(FIXTURE_HARNESS_BASE.length + 1);
    const id = rest.split(/[/?#]/)[0];
    return id !== undefined && id !== '' ? id : null;
  }
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(arg);
  if (!arg.includes('/') && !arg.includes('\\') && !hasScheme) return arg;
  return null;
}

export async function resolveAnalyzeInput(arg: string): Promise<ResolvedAnalyzeInput> {
  if (arg.trim() === '') {
    throw new AnalyzeInputError('analyze requires a form URL or fixture path');
  }

  if (existsSync(arg)) {
    return { html: await readFile(arg, 'utf8'), url: arg, source: 'file' };
  }

  const fixtureId = fixtureIdFromArg(arg);
  if (fixtureId !== null) {
    try {
      const fixture = await loadFixture(fixtureId);
      return { html: await fixture.snapshot(), url: fixture.url, source: fixture.source };
    } catch {
      throw new AnalyzeInputError(`unknown fixture: ${fixtureId}`);
    }
  }

  if (isHttpUrl(arg)) {
    throw new AnalyzeInputError(
      'live form fetching is not implemented in Phase 1; provide a fixture path, fixture id, or fixture URL',
    );
  }

  throw new AnalyzeInputError(`unknown fixture or file: ${arg}`);
}
