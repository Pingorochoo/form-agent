/**
 * Phase 8 OpenClaw plugin packaging surface (Finding O) + closure (Finding R).
 *
 * IMPORTANT (Finding R status): the real OpenClaw 2026.9.4 runtime is NOT
 * available in this environment, so the required real install/link +
 * `openclaw plugins inspect <id> --runtime --json` proof could NOT be performed.
 * These tests therefore contain NO synthetic OpenClaw/typebox stubs and do NOT
 * claim runtime load. They assert only the honest static surface:
 *   - the declared deployment mechanism (private linked source checkout);
 *   - manifest + skill presence;
 *   - the recursive relative-import closure resolves inside the repo root with
 *     no `..` exemption;
 *   - every in-package runtime module is in the `files` allowlist.
 * `npm pack` here is an internal self-consistency check ONLY; it is not the
 * deployment artifact.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLUGIN_DIR = fileURLToPath(new URL('../integrations/openclaw-plugin', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(PLUGIN_DIR, 'index.ts');
const PACKAGE_JSON = join(PLUGIN_DIR, 'package.json');

interface PackResult {
  files: Array<{ path: string }>;
}

function runPack(): PackResult {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: PLUGIN_DIR, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr || result.stdout}`);
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('npm pack produced no result');
  return parsed[0] as PackResult;
}

function relativeImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specs = new Set<string>();
  const re = /(?:from\s+|import\(\s*)['"](\.[^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    if (match[1] !== undefined) specs.add(match[1]);
  }
  return [...specs];
}

function bareImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specs = new Set<string>();
  const re = /(?:from\s+|import\(\s*)['"]([^.'"][^'"]*)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    if (match[1] !== undefined) specs.add(match[1]);
  }
  return [...specs];
}

function resolveSpecifier(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  if (existsSync(base) && statSync(base).isFile()) return base;
  if (existsSync(`${base}.ts`)) return `${base}.ts`;
  return base;
}

function collectClosure(entry: string): { files: Set<string>; bare: Set<string>; missing: string[] } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const missing: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of bareImports(file)) {
      if (!specifier.startsWith('node:')) bare.add(specifier);
    }
    for (const specifier of relativeImports(file)) {
      const target = resolveSpecifier(file, specifier);
      if (!existsSync(target)) {
        missing.push(`${relative(REPO_ROOT, file)} -> ${specifier}`);
        continue;
      }
      queue.push(target);
    }
  }
  return { files, bare, missing };
}

function coveredByFilesEntry(relPath: string, files: string[]): boolean {
  return files.some((entry) => relPath === entry || relPath.startsWith(`${entry}/`));
}

describe('plugin packaging surface + closure (O/R static)', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    private?: boolean;
    files?: string[];
    peerDependencies?: Record<string, string>;
    openclaw?: { extensions?: string[]; compat?: Record<string, string> };
  };
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, 'openclaw.plugin.json'), 'utf8')) as {
    contracts?: { tools?: string[] };
  };
  const pack = runPack();
  const packed = new Set(pack.files.map((file) => file.path));

  it('declares a private linked source-checkout deployment (not npm-pack standalone)', () => {
    expect(pkg.private).toBe(true);
    expect(pkg.openclaw?.extensions).toEqual(['./index.ts']);
  });

  it('keeps the OpenClaw compatibility pin exact', () => {
    expect(pkg.peerDependencies?.['openclaw']).toBe('2026.9.4');
    expect(pkg.openclaw?.compat?.['pluginApi']).toBe('2026.9.4');
    expect(pkg.openclaw?.compat?.['minGatewayVersion']).toBe('2026.9.4');
  });

  it('manifest + skill are present', () => {
    expect(packed.has('openclaw.plugin.json')).toBe(true);
    expect(packed.has('skills/form-agent/SKILL.md')).toBe(true);
    expect(manifest.contracts?.tools).toEqual(['form_agent', 'form_agent_submit']);
  });

  it('every relative runtime import resolves inside the repo root; no `..` exemption', () => {
    const closure = collectClosure(ENTRY);
    expect(closure.missing).toEqual([]);
    expect(closure.files.size).toBeGreaterThan(0);

    const filesList = pkg.files ?? [];
    const outsideRoot: string[] = [];
    const inPackageNotPacked: string[] = [];
    const inPackageNotAllowed: string[] = [];

    for (const file of closure.files) {
      const relRepo = relative(REPO_ROOT, file);
      if (relRepo.startsWith('..') || isAbsolute(relRepo)) {
        outsideRoot.push(relRepo);
        continue;
      }
      const relPlugin = relative(PLUGIN_DIR, file);
      const insidePackage = !relPlugin.startsWith('..') && !isAbsolute(relPlugin);
      if (insidePackage) {
        if (!packed.has(relPlugin)) inPackageNotPacked.push(relPlugin);
        if (!coveredByFilesEntry(relPlugin, filesList)) inPackageNotAllowed.push(relPlugin);
      }
    }

    expect(outsideRoot).toEqual([]);
    expect(inPackageNotPacked).toEqual([]);
    expect(inPackageNotAllowed).toEqual([]);
    // The only bare runtime deps are the normal package deps of the plugin.
    expect([...closure.bare].sort()).toEqual(['openclaw/plugin-sdk/plugin-entry', 'typebox']);
  });
});
