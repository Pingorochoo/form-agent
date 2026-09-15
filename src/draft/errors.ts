/**
 * Controlled Phase 3 errors (P3-R17).
 *
 * Draft generation fails through these typed errors instead of raw stack dumps,
 * so the CLI can map them onto the frozen exit-code contract without leaking
 * provider internals or blocked sensitive values.
 */

export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftError';
  }
}

/** The draft invocation is unusable (e.g. an empty seed). */
export class DraftSeedError extends DraftError {
  constructor(message: string) {
    super(message);
    this.name = 'DraftSeedError';
  }
}

/**
 * A provider produced semantically/profile-structurally invalid output that
 * must not be trusted (invalid structural references, missing synthetic
 * provenance, mismatched identity, etc.).
 */
export class DraftValidationError extends DraftError {
  constructor(message: string) {
    super(message);
    this.name = 'DraftValidationError';
  }
}
