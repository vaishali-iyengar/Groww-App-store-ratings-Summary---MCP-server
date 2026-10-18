import { describe, expect, it } from 'vitest';
import { isValidEmail, normalizeRecipients, parseDocumentId } from '../../src/utils/validation.js';
import { AppError } from '../../src/errors/appError.js';
import { DOC_ID } from '../helpers.js';

describe('isValidEmail', () => {
  it.each([
    'person@example.com',
    'first.last+tag@sub.example.co.in',
    "o'brien@example.org",
    'a_b-c@ex-ample.io',
  ])('accepts %s', (addr) => expect(isValidEmail(addr)).toBe(true));

  it.each([
    '',
    'plainaddress',
    '@example.com',
    'person@',
    'person@example',
    'person@@example.com',
    'a@b@example.com',
    'person@exa mple.com',
    'Person <person@example.com>',
    'person@example.com, other@example.com',
    'person@example.com\r\nBcc: victim@example.com',
    '.person@example.com',
    'per..son@example.com',
    'person@-example.com',
    'person@example.c',
    `${'a'.repeat(65)}@example.com`,
  ])('rejects %j', (addr) => expect(isValidEmail(addr)).toBe(false));
});

describe('normalizeRecipients', () => {
  it('trims and returns valid addresses', () => {
    expect(normalizeRecipients('to', [' a@example.com ', 'b@example.com'])).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
  });

  it('reports every invalid position with INVALID_RECIPIENT', () => {
    try {
      normalizeRecipients('cc', ['ok@example.com', 'bad', 'also bad@x.com']);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INVALID_RECIPIENT');
      expect((err as AppError).details).toEqual({ invalid_fields: ['cc[1]', 'cc[2]'] });
    }
  });
});

describe('parseDocumentId', () => {
  it('accepts a bare ID', () => expect(parseDocumentId(DOC_ID)).toBe(DOC_ID));

  it('extracts the ID from a Docs URL', () => {
    expect(parseDocumentId(`https://docs.google.com/document/d/${DOC_ID}/edit?tab=t.0`)).toBe(DOC_ID);
    expect(parseDocumentId(`https://docs.google.com/document/u/1/d/${DOC_ID}/edit`)).toBe(DOC_ID);
  });

  it.each(['short', '../../etc/passwd', `${DOC_ID}?x=1`, 'https://evil.example.com/document/d/abc', ''])(
    'rejects %j with INVALID_DOCUMENT',
    (input) =>
      expect(() => parseDocumentId(input)).toThrowError(
        expect.objectContaining({ code: 'INVALID_DOCUMENT' }),
      ),
  );
});
