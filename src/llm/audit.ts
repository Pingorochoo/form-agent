/**
 * Safe LLM-call audit persistence (P6-R11, migration 4 `llm_calls`).
 *
 * Reuses the accepted migration-4 table for safe metadata only: provider,
 * model, stage, latency, token counts reported by the provider, and a stable
 * success/failure status. It NEVER persists prompt or response content, API
 * keys, Authorization headers, or raw provider exceptions. Phase 7 owns any
 * metrics expansion; no new migration is introduced here.
 */

import type { FormAgentDatabase } from '../db/database.ts';

export interface LlmCallAuditEntry {
  providerId: string;
  model: string;
  stage: string;
  status: 'success' | 'error';
  errorCode?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  finishReason?: string;
}

export class LlmCallStore {
  private readonly database: FormAgentDatabase;

  constructor(database: FormAgentDatabase) {
    this.database = database;
  }

  record(entry: LlmCallAuditEntry): void {
    this.database.db
      .prepare(
        `INSERT INTO llm_calls
           (provider_id, model, stage, cache_key, input_tokens, output_tokens,
            total_tokens, duration_ms, finish_reason, status)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.providerId,
        entry.model,
        entry.stage,
        entry.inputTokens ?? null,
        entry.outputTokens ?? null,
        entry.totalTokens ?? null,
        entry.durationMs ?? null,
        entry.finishReason ?? null,
        entry.status === 'success' ? 'success' : 'error',
      );
  }

  /** Number of recorded calls for a provider (audit/test aid). */
  countForProvider(providerId: string): number {
    const row = this.database.db
      .prepare('SELECT COUNT(*) AS n FROM llm_calls WHERE provider_id = ?')
      .get(providerId) as { n: number };
    return row.n;
  }
}
