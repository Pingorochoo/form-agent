/**
 * Phase 8 OpenClaw compatibility metadata (Finding D).
 *
 * The plugin advertises compatibility ONLY for the SDK version that was
 * actually verified. The source declaration and package metadata cannot drift.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  OPENCLAW_VERIFIED_RANGE,
  OPENCLAW_VERIFIED_VERSION,
} from '../integrations/openclaw-plugin/compat.ts';

const pluginPackage = JSON.parse(
  readFileSync(new URL('../integrations/openclaw-plugin/package.json', import.meta.url), 'utf8'),
) as {
  peerDependencies?: Record<string, string>;
  openclaw?: { compat?: Record<string, string> };
};
const indexSource = readFileSync(new URL('../integrations/openclaw-plugin/index.ts', import.meta.url), 'utf8');

describe('OpenClaw compatibility declaration (D)', () => {
  it('pins the verified version in every compatibility field', () => {
    expect(OPENCLAW_VERIFIED_RANGE).toBe(OPENCLAW_VERIFIED_VERSION);
    expect(pluginPackage.peerDependencies?.['openclaw']).toBe(OPENCLAW_VERIFIED_VERSION);
    expect(pluginPackage.openclaw?.compat?.['pluginApi']).toBe(OPENCLAW_VERIFIED_VERSION);
    expect(pluginPackage.openclaw?.compat?.['minGatewayVersion']).toBe(OPENCLAW_VERIFIED_VERSION);
  });

  it('does not advertise the unverified broader lower bound', () => {
    const serialized = JSON.stringify(pluginPackage);
    expect(serialized).not.toContain('2026.5.17');
    expect(serialized).not.toMatch(/>=2026/);
    expect(indexSource).not.toContain('2026.5.17');
  });

  it('the source verified-version declaration matches the package metadata', () => {
    expect(indexSource).toContain(OPENCLAW_VERIFIED_VERSION);
  });
});
