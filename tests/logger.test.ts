/**
 * Logger + redaction integration: the sensitive-field matrix surface.
 */

import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/logging/logger.ts';
import { parseConfig } from '../src/config/schema.ts';

function captureLogger(level: 'trace' | 'debug' | 'info' | 'warn' | 'error') {
  const lines: string[] = [];
  const config = parseConfig({ log: { level } });
  const logger = createLogger(config, { sink: (line) => lines.push(line) });
  return { logger, lines };
}

describe('logger', () => {
  it('respects level filtering', () => {
    const { logger, lines } = captureLogger('warn');
    logger.debug('noise');
    logger.warn('careful');
    logger.error('boom');
    expect(lines).toHaveLength(2);
  });

  it('redacts emails and phones in structured fields', () => {
    const { logger, lines } = captureLogger('info');
    logger.info('form loaded', {
      url: 'https://fixtures.local/forms/official',
      contact: 'jane.doe@example.com',
      phone: '+1 555 010 9999',
    });
    expect(lines[0]).toContain('<REDACTED-EMAIL>');
    expect(lines[0]).toContain('<REDACTED-PHONE>');
    expect(lines[0]).not.toContain('jane.doe@example.com');
  });

  it('child loggers prefix the module', () => {
    const { logger, lines } = captureLogger('info');
    logger.child('policy').info('ready');
    expect(lines[0]).toContain('[policy] ready');
  });
});