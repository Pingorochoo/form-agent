/**
 * Controlled Phase 4 errors.
 *
 * The consistency gate reports issues rather than throwing for detectable
 * inconsistencies. It throws a `ConsistencyInputError` only when the input it
 * was handed is structurally malformed (e.g. `bundle.results` is not an array),
 * so the CLI can map that onto a controlled validation failure without dumping
 * a raw stack or echoing untrusted payloads.
 */

export class ConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsistencyError';
  }
}

/** The gate input is unusable (malformed schema/bundle structure). */
export class ConsistencyInputError extends ConsistencyError {
  constructor(message: string) {
    super(message);
    this.name = 'ConsistencyInputError';
  }
}
