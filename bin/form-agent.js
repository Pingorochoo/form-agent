#!/usr/bin/env node
/**
 * form-agent CLI launcher.
 *
 * Resolves the compiled CLI entry point (dist/src/index.js) relative to this
 * script, falling back to a direct TypeScript run when the project has not
 * been built yet.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const distEntry = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));

const args = process.argv.slice(2);

if (existsSync(distEntry)) {
  const { runCli } = await import(distEntry);
  await runCli(args);
} else {
  const { runCli } = await import('../src/index.ts');
  await runCli(args);
}