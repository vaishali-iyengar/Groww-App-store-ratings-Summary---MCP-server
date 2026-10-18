import { describe, expect, it } from 'vitest';
import { buildMimeMessage, encodeHeaderValue, htmlToText } from '../../src/integrations/google/mime.js';

function header(raw: string, name: string): string | undefined {
  const head = raw.split('\r\n\r\n')[0]!.replace(/\r\n /g, ' ');
  return head
    .split('\r\n')
    .find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':'))
    ?.slice(name.length + 1)
    .trim();
}

function decodeBase64Part(part: string): string {
  return Buffer.from(part.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

describe('encodeHeaderValue', () => {
  it('leaves printable ASCII untouched', () =>
    expect(encodeHeaderValue('Meeting notes')).toBe('Meeting notes'));

  it('RFC 2047-encodes UTF-8 and round-trips', () => {
    const subject = 'Réunion — 会议记录 🚀 '.repeat(4);
    const encoded = encodeHeaderValue(subject);
    const words = encoded.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(w.length).toBeLessThanOrEqual(75);
    }
    const decoded = words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
    expect(decoded).toBe(subject);
  });

  it('encodes values that look like encoded words', () => {
    expect(encodeHeaderValue('=?UTF-8?B?abc?=')).toMatch(/^=\?UTF-8\?B\?/);
  });
});

describe('buildMimeMessage', () => {
  it('builds a plain-text message with To/Cc/Bcc', () => {
    const raw = buildMimeMessage({
      to: ['a@example.com', 'b@example.com'],
      cc: ['c@example.com'],
      bcc: ['d@example.com'],
      subject: 'Hello',
      body: 'Line one\nnamaste नमस्ते',
      contentType: 'text/plain',
    });
    expect(header(raw, 'To')).toBe('a@example.com, b@example.com');
    expect(header(raw, 'Cc')).toBe('c@example.com');
    expect(header(raw, 'Bcc')).toBe('d@example.com');
    expect(header(raw, 'Subject')).toBe('Hello');
    expect(header(raw, 'MIME-Version')).toBe('1.0');
    expect(header(raw, 'Content-Type')).toBe('text/plain; charset="UTF-8"');
    expect(header(raw, 'Content-Transfer-Encoding')).toBe('base64');
    const body = raw.split('\r\n\r\n')[1]!;
    for (const line of body.trim().split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    expect(decodeBase64Part(body)).toBe('Line one\nnamaste नमस्ते');
  });

  it('omits empty Cc/Bcc headers', () => {
    const raw = buildMimeMessage({
      to: ['a@example.com'],
      subject: 's',
      body: 'b',
      contentType: 'text/plain',
    });
    expect(header(raw, 'Cc')).toBeUndefined();
    expect(header(raw, 'Bcc')).toBeUndefined();
  });

  it('builds multipart/alternative for HTML with a text fallback', () => {
    const raw = buildMimeMessage(
      {
        to: ['a@example.com'],
        subject: 's',
        body: '<p>Hello <b>World</b></p><ul><li>One</li></ul>',
        contentType: 'text/html',
      },
      'seed',
    );
    expect(header(raw, 'Content-Type')).toBe('multipart/alternative; boundary="mcp_alt_seed"');
    const parts = raw.split('--mcp_alt_seed');
    expect(parts).toHaveLength(4); // preamble, text, html, closing
    expect(parts[1]).toContain('text/plain; charset="UTF-8"');
    expect(decodeBase64Part(parts[1]!.split('\r\n\r\n')[1]!)).toBe('Hello World\n- One');
    expect(parts[2]).toContain('text/html; charset="UTF-8"');
    expect(decodeBase64Part(parts[2]!.split('\r\n\r\n')[1]!)).toContain('<b>World</b>');
    expect(parts[3]!.startsWith('--')).toBe(true);
  });

  it('adds reply threading headers', () => {
    const raw = buildMimeMessage({
      to: ['a@example.com'],
      subject: 'Re: s',
      body: 'b',
      contentType: 'text/plain',
      inReplyTo: '<orig@mail.gmail.com>',
    });
    expect(header(raw, 'In-Reply-To')).toBe('<orig@mail.gmail.com>');
    expect(header(raw, 'References')).toBe('<orig@mail.gmail.com>');
  });

  it('refuses header injection through addresses or reply ids', () => {
    expect(() =>
      buildMimeMessage({
        to: ['a@example.com\r\nBcc: x@evil.com'],
        subject: 's',
        body: 'b',
        contentType: 'text/plain',
      }),
    ).toThrow(/line breaks/);
    expect(() =>
      buildMimeMessage({
        to: ['a@example.com'],
        subject: 's',
        body: 'b',
        contentType: 'text/plain',
        inReplyTo: '<a@b>\nX: y',
      }),
    ).toThrow(/line breaks/);
  });

  it('encodes a subject containing CRLF instead of emitting a new header', () => {
    const raw = buildMimeMessage({
      to: ['a@example.com'],
      subject: 'Hi\r\nBcc: x@evil.com',
      body: 'b',
      contentType: 'text/plain',
    });
    expect(header(raw, 'Bcc')).toBeUndefined();
  });
});

describe('htmlToText', () => {
  it('strips scripts, tags and decodes entities', () => {
    expect(htmlToText('<style>p{}</style><script>alert(1)</script><p>A &amp; B</p><br>C&nbsp;D')).toBe(
      'A & B\n\nC D',
    );
  });
});
