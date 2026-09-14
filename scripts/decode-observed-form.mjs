#!/usr/bin/env node
/**
 * Regenerate fixtures/archives/observed-responder.structure.json from the
 * sanitized archive HTML.
 *
 * Usage:
 *   node scripts/decode-observed-form.mjs [archive.html] [out.json]
 *
 * The decoding logic lives in src/fixtures/observed-payload.ts so tests exercise
 * the same code path (Node 24 type-strips the .ts import).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

import { decodeEmbeddedPayload, extractPayload } from '../src/fixtures/observed-payload.ts';

const [, , inputArg, outputArg] = process.argv;
const inputPath = inputArg ?? resolve(process.cwd(), 'fixtures/archives/observed-responder.html');
const target = outputArg ?? resolve(process.cwd(), 'fixtures/archives/observed-responder.structure.json');

const decoded = decodeEmbeddedPayload(extractPayload(readFileSync(inputPath, 'utf8')));
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(decoded, null, 2)}\n`, 'utf8');
process.stdout.write(
  `wrote ${target} (${decoded.questions.length} questions, ${decoded.sections.length} sections, ` +
    `routing=${decoded.routingEvidence.conditionalRoutingDetected})\n`,
);