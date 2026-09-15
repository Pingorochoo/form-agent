/**
 * Local loopback OpenAI-compatible LLM stub (Phase 6 tests only).
 *
 * A deterministic in-process HTTP server that speaks the OpenAI-compatible
 * chat-completions contract and records every request (path, model, safe
 * headers, body) for assertions. Tests use ONLY this stub — no real cloud LLM
 * endpoint is ever contacted.
 *
 * Scenarios mirror docs/PHASE_6.md §22-§24: valid stages, malformed JSON,
 * invalid stage objects, malformed envelopes, 401/403/429/500, timeout,
 * oversized body, and redirect. The stub derives the provider stage from the
 * versioned system prompt and generates schema-valid structured output for the
 * `valid` scenario.
 */

import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

export const LLM_STUB_MODEL = 'stub-model-1';
export const SECRET_SENTINEL = 'VERY_SECRET_LLM_TOKEN';

export type LlmStubScenario =
  | 'valid'
  | 'malformed-json'
  | 'invalid-stage'
  | 'malformed-envelope'
  | 'http-401'
  | 'http-403'
  | 'http-429'
  | 'http-500'
  | 'timeout'
  | 'oversized'
  | 'redirect';

export type LlmStubStage = 'semantics' | 'profile' | 'answer' | 'unknown';

export interface LlmStubRequest {
  path: string;
  method: string;
  model: string;
  authorization: string | null;
  system: string;
  user: string;
  body: Record<string, unknown>;
  stage: LlmStubStage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function detectStage(system: string, user: string): LlmStubStage {
  if (system.includes('whole-form semantic model')) return 'semantics';
  if (system.includes('synthetic respondent profile')) return 'profile';
  if (system.includes('single draft answer')) return 'answer';
  void user;
  return 'unknown';
}

function validSemantics(user: Record<string, unknown>): Record<string, unknown> {
  const sections = Array.isArray(user['sections']) ? (user['sections'] as Array<Record<string, unknown>>) : [];
  const questions = Array.isArray(user['questions']) ? (user['questions'] as Array<Record<string, unknown>>) : [];

  const questionsOut: Record<string, unknown> = {};
  const tags: Record<string, string> = {};
  for (const question of questions) {
    const id = String(question['id']);
    questionsOut[id] = {
      questionId: id,
      topic: 'survey',
      semanticAnswer: { semanticTag: `tag-${id}`, rationale: 'stub semantic rationale' },
      relationships: [],
      freeTextSemantics: 'unknown',
    };
    tags[id] = `tag-${id}`;
  }
  const sectionsOut: Record<string, unknown> = {};
  for (const section of sections) {
    const id = String(section['id']);
    sectionsOut[id] = {
      sectionId: id,
      meaning: 'survey',
      rationale: 'stub section rationale',
      confidence: 'low',
    };
  }

  return {
    version: 1,
    purpose: 'collect structured responses',
    topic: 'survey',
    style: 'formal',
    targetAudience: {
      domain: 'unknown',
      setting: 'unknown',
      likelyGroups: [],
      likelyAgeRange: 'unknown',
      roles: [],
      relevantInterests: [],
      hardConstraints: [],
      softConstraints: [],
      confidence: 'low',
      evidence: [],
    },
    questions: questionsOut,
    sections: sectionsOut,
    structuredQuestionTags: tags,
    confidence: 'low',
    evidence: [],
  };
}

function validProfile(): Record<string, unknown> {
  return {
    identity: { ageBand: '18-24' },
    latentTraits: [],
    facts: [{ key: 'respondent_role', value: 'synthetic-respondent', rationale: 'stub synthetic provenance' }],
    archetype: 'composite',
  };
}

function validAnswer(user: Record<string, unknown>): Record<string, unknown> {
  const question = isRecord(user['question']) ? user['question'] : {};
  const kind = String(question['kind']);
  const choices = Array.isArray(question['choices']) ? (question['choices'] as string[]) : [];
  const rows = Array.isArray(question['rows']) ? (question['rows'] as Array<{ id: string }>) : [];
  const minValue = typeof question['minValue'] === 'number' ? question['minValue'] : 1;

  switch (kind) {
    case 'text':
    case 'paragraph-text':
      return { kind, value: 'synthetic stub answer' };
    case 'single-choice':
      return { kind: 'single-choice', value: choices[0] ?? '' };
    case 'multi-choice':
      return { kind: 'multi-choice', value: choices.length > 0 ? [choices[0] as string] : [] };
    case 'linear-scale':
      return { kind: 'linear-scale', value: minValue };
    case 'multiple-choice-grid': {
      const grid: Record<string, string> = {};
      for (const row of rows) grid[row.id] = choices[0] ?? '';
      return { kind: 'multiple-choice-grid', value: grid };
    }
    case 'date':
      return { kind: 'date', value: { year: 2000, month: 1, day: 1 } };
    case 'time':
      return { kind: 'time', value: { hour: 0, minute: 0 } };
    default:
      return { kind, value: null };
  }
}

function envelope(content: string): string {
  return JSON.stringify({
    model: LLM_STUB_MODEL,
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

export class LlmStub {
  private server: Server | null = null;
  private readonly port: number;
  private scenario: LlmStubScenario = 'valid';
  private timeoutMs = 1000;
  readonly requests: LlmStubRequest[] = [];

  constructor(port = 0) {
    this.port = port;
  }

  setScenario(scenario: LlmStubScenario): void {
    this.scenario = scenario;
  }

  /** Delay applied to the `timeout` scenario (must exceed the client timeout). */
  setTimeoutMs(ms: number): void {
    this.timeoutMs = ms;
  }

  requestCount(): number {
    return this.requests.length;
  }

  countForStage(stage: LlmStubStage): number {
    return this.requests.filter((request) => request.stage === stage).length;
  }

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }

        const messages = Array.isArray(body['messages']) ? (body['messages'] as Array<Record<string, unknown>>) : [];
        const system = messages.find((message) => message['role'] === 'system');
        const user = messages.find((message) => message['role'] === 'user');
        const systemText = typeof system?.['content'] === 'string' ? (system['content'] as string) : '';
        const userText = typeof user?.['content'] === 'string' ? (user['content'] as string) : '';

        const authorization = req.headers['authorization'] ?? null;
        const request: LlmStubRequest = {
          path: req.url ?? '/',
          method: req.method ?? '',
          model: typeof body['model'] === 'string' ? (body['model'] as string) : '',
          authorization,
          system: systemText,
          user: userText,
          body,
          stage: detectStage(systemText, userText),
        };
        this.requests.push(request);

        void this.respond(res, request);
      });
    });

    server.listen(this.port, '127.0.0.1');
    await once(server, 'listening');
    this.server = server;
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('llm stub did not bind to a TCP port');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  private async respond(res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string) => void }, request: LlmStubRequest): Promise<void> {
    const scenario = this.scenario;

    if (scenario === 'http-401') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (scenario === 'http-403') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    if (scenario === 'http-429') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate limited' }));
      return;
    }
    if (scenario === 'http-500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
      return;
    }
    if (scenario === 'redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/redirected', 'content-type': 'application/json' });
      res.end('');
      return;
    }
    if (scenario === 'timeout') {
      // Hold the response open past the client timeout; the client aborts.
      setTimeout(() => {
        try {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(envelope('{}'));
        } catch {
          // client already aborted
        }
      }, this.timeoutMs);
      return;
    }

    let content: string;
    if (scenario === 'malformed-json') {
      content = 'this is not json {{{';
    } else if (scenario === 'invalid-stage') {
      content = JSON.stringify({ unexpected: 'shape' });
    } else {
      // valid (or malformed-envelope is handled below via a valid content but a
      // wrong envelope).
      const user = this.parseUser(request.user);
      if (request.stage === 'semantics') content = JSON.stringify(validSemantics(user));
      else if (request.stage === 'profile') content = JSON.stringify(validProfile());
      else if (request.stage === 'answer') content = JSON.stringify(validAnswer(user));
      else content = JSON.stringify({});
    }

    if (scenario === 'malformed-envelope') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ not: 'an openai envelope' }));
      return;
    }
    if (scenario === 'oversized') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: LLM_STUB_MODEL, choices: [{ message: { content: 'x'.repeat(4 * 1024 * 1024) }, finish_reason: 'stop' }], usage: {} }));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(envelope(content));
  }

  private parseUser(user: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(user);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  async stop(): Promise<void> {
    if (this.server === null) return;
    const server = this.server;
    this.server = null;
    server.close();
    await once(server, 'close');
  }
}
