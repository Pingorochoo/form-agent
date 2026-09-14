#!/usr/bin/env node
/**
 * Sanitize a captured Google Forms responder page into a committable archive
 * fixture under fixtures/archives/.
 *
 * Usage:
 *   node scripts/sanitize-observed-form.mjs <captured.html> [out.html]
 *
 * The logic lives in src/fixtures/observed-sanitize.ts so tests exercise the
 * exact same code path (Node 24 type-strips the .ts import).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

import { ARCHIVE_HEADER, assertSanitized, sanitizeResponderHtml } from '../src/fixtures/observed-sanitize.ts';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath) {
  console.error('usage: node scripts/sanitize-observed-form.mjs <captured.html> [out.html]');
  process.exit(2);
}
const target = outputPath ?? resolve(process.cwd(), 'fixtures/archives/observed-responder.html');
const sanitized = sanitizeResponderHtml(readFileSync(inputPath, 'utf8'));
assertSanitized(sanitized);

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, ARCHIVE_HEADER + sanitized, 'utf8');
process.stdout.write(`wrote ${target} (${(ARCHIVE_HEADER + sanitized).length} bytes)\n`);