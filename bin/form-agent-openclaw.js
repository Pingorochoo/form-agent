#!/usr/bin/env node
/**
 * form-agent OpenClaw adapter launcher.
 *
 * Resolves the compiled adapter entry point (dist/src/openclaw/main.js)
 * relative to this script, falling back to a direct TypeScript run when the
 * project has not been built yet.
 *
 * The adapter always attempts to emit exactly one JSON envelope and exits 0;
 * it exits 1 only when no document could be produced.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const distEntry = fileURLToPath(new URL('../dist/src/openclaw/main.js', import.meta.url));

const args = process.argv.slice(2);

if (existsSync(distEntry)) {
  const { runAdapterCli } = await import(distEntry);
  process.exitCode = await runAdapterCli(args);
} else {
  const { runAdapterCli } = await import('../src/openclaw/main.ts');
  process.exitCode = await runAdapterCli(args);
}
