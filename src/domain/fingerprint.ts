/**
 * Structural fingerprinting.
 *
 * The fingerprint is a SHA-256 of a canonical JSON serialization of the
 * parsed FormSchema (plus form identity and the generator version). It is
 * stable under key re-ordering and undefined-value stripping, and any real
 * form edit yields a new fingerprint — which auto-invalidates both the
 * structural and the semantic caches at the DB level (Phase 1/2).
 */

import { createHash } from 'node:crypto';

export type StructuralFingerprint = string;

export const FINGERPRINT_VERSION = 1;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function reject(value: unknown, reason: string): never {
  throw new Error(`Unsupported value in canonical JSON (${reason}): ${String(value)}`);
}

/** Deterministic JSON serialization: sorted object keys, compact, finite numbers. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) reject(value, 'non-finite number');
      return Object.is(value, -0) ? '0' : String(value);
    }
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      reject(value, 'bigint');
      break;
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((child) => canonicalJson(child)).join(',')}]`;
      if (value instanceof Date) reject(value, 'Date (convert to ISO string first)');
      const entries: Array<[string, string]> = [];
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined) continue;
        entries.push([JSON.stringify(key), canonicalJson(child)]);
      }
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return `{${entries.map(([k, v]) => `${k}:${v}`).join(',')}}`;
    }
    default:
      reject(value, typeof value);
  }
}

export interface FingerprintInput {
  providerId: string;
  formId: string;
  /** Canonicalized FormSchema (plain data only). */
  formJson: unknown;
  /** Version of the DOM parser/analyzer that produced formJson. */
  generatorVersion: string;
}

export function structuralFingerprint(input: FingerprintInput): StructuralFingerprint {
  return createHash('sha256')
    .update(canonicalJson({ version: FINGERPRINT_VERSION, ...input }))
    .digest('hex');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function jsonFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}