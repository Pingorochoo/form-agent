/**
 * Redaction tests — the sensitive-field matrix surface.
 */

import { describe, expect, it } from 'vitest';

import {
  API_KEY_MASK,
  looksLikeGoogleResponseId,
  redactObjectDeep,
  redactText,
} from '../src/logging/redact.ts';

describe('redactText', () => {
  it('redacts emails and phones by default', () => {
    const result = redactText('Contact jane.doe@example.com or +1 555 010 9999 today.');
    expect(result.text).toContain('<REDACTED-EMAIL>');
    expect(result.text).toContain('<REDACTED-PHONE>');
    expect(result.text).not.toContain('jane.doe@example.com');
    expect(result.text).not.toContain('555');
  });

  it('applies a targeted mapping', () => {
    const result = redactText('Please enter your Email in the field labeled Email.', {
      mapping: { Email: 'user@example.test' },
    });
    expect(result.text).toContain('user@example.test');
    // The mapped replacement itself must not be re-processed as an email.
    expect(result.text).not.toContain('<REDACTED-EMAIL>');
    expect(result.text).not.toContain('the field labeled Email');
  });

  it('respects opt-out flags', () => {
    const result = redactText('Email a@b.com', { replaceEmails: false, replacePhones: true, replaceApiKeys: true });
    expect(result.text).toContain('a@b.com');
  });

  it('redacts API-key assignments', () => {
    const result = redactText('Authorization: Bearer sk-huge-secret-value-1234567890123456');
    expect(result.text).toContain('********');
    expect(result.text).not.toContain('sk-huge');
  });

  it('survives missing fields and empty strings', () => {
    expect(redactText('').text).toBe('');
    expect(redactText('no sensitive content here').text).toBe('no sensitive content here');
  });
});

describe('google response-id redaction (false-positive guard)', () => {
  it('does NOT redact ordinary long option labels', () => {
    // Regression: the old /[1-9a-zA-Z_-]{20,}/ rule silently swallowed these.
    const labels = [
      'Supercalifragilisticexpialidocious',
      'Extraordinarilylongoptionlabelword',
      'state-of-the-art-technology-stack',
      'international-collaboration-framework',
    ];
    const result = redactText(labels.join(' | '));
    for (const label of labels) {
      expect(result.text).toContain(label);
    }
    expect(result.text).not.toContain('<REDACTED-RESPONSE-ID>');
  });

  it('does not redact long lowercase or length-only matches', () => {
    expect(redactText('averyveryverylonglowercaseword').text).toBe('averyveryverylonglowercaseword');
    expect(redactText('LongUppercaseTokenWithoutDigitsHere').text).toBe(
      'LongUppercaseTokenWithoutDigitsHere',
    );
    expect(redactText('MixedCaseButNoDigitsAtAllInHere').text).toBe(
      'MixedCaseButNoDigitsAtAllInHere',
    );
  });

  it('still redacts real-looking Google response IDs', () => {
    const result = redactText('response 2_ABaOnufqWz9v_GxYzAbCdEf012345 submitted');
    expect(result.text).toContain('<REDACTED-RESPONSE-ID>');
    expect(result.text).not.toContain('2_ABaOnufqWz9v_GxYzAbCdEf012345');
  });

  it('still redacts leading-digit mixed-case ids and long form ids', () => {
    const formId = '1FAIpQLSd98rnMrAiFm3vA4FoyGnS0UbOqz';
    const result = redactText(`form ${formId} ok`);
    expect(result.text).not.toContain(formId);
    expect(result.text).toContain('<REDACTED-RESPONSE-ID>');
  });

  it('exposes the structural predicate for direct unit testing', () => {
    expect(looksLikeGoogleResponseId('2_ABaOnufqWz9v_GxYzAbCdEf012345')).toBe(true);
    expect(looksLikeGoogleResponseId('Supercalifragilisticexpialidocious')).toBe(false);
    expect(looksLikeGoogleResponseId('state-of-the-art-technology-stack')).toBe(false);
    expect(looksLikeGoogleResponseId('short')).toBe(false);
  });
});

describe('redactObjectDeep', () => {
  it('redacts sensitive keys and email/phone values deeply', () => {
    const out = redactObjectDeep({
      form: {
        title: 'Contact form',
        user: {
          email: 'x@y.com',
          token: 'abc123def456',
          password: 'hunter2',
        },
      },
    }) as { form: { user: { email: string; token: string; password: string } } };
    expect(out.form.user.email).toBe('<REDACTED-EMAIL>');
    expect(out.form.user.token).toBe(API_KEY_MASK);
    expect(out.form.user.password).toBe(API_KEY_MASK);
  });

  it('handles arrays and cycles defensively', () => {
    const obj: Record<string, unknown> = { list: ['a@b.com', 1] };
    obj.self = obj;
    const out = redactObjectDeep(obj) as { list: Array<string | number> };
    expect(out.list[0]).toBe('<REDACTED-EMAIL>');
    expect(out.list[1]).toBe(1);
  });

  it('does not mutate the input', () => {
    const input = { user: { email: 'x@y.com' } };
    redactObjectDeep(input);
    expect(input.user.email).toBe('x@y.com');
  });
});

describe('bootstrap case (targeted label echoed later)', () => {
  it('redacts a literal email label even when it appears verbatim as a question', () => {
    // A question title that echoes the SensitiveField name "Email" — the
    // Phase 2 policy must map label -> replacement for these at runtime.
    const mapping = { Email: 'user@example.test' };
    const result = redactText('Please enter your Email:', { mapping });
    expect(result.text).toContain('user@example.test');
  });
});