import { randomBytes } from 'node:crypto';

export interface MimeMessageInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  contentType: 'text/plain' | 'text/html';
  /** RFC 5322 Message-ID of the message being replied to, e.g. `<abc@mail.gmail.com>`. */
  inReplyTo?: string;
  references?: string;
}

const CRLF = '\r\n';

/** Header values must never contain line breaks — that would allow header injection. */
function assertHeaderSafe(name: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`Header ${name} must not contain line breaks`);
}

/**
 * RFC 2047 "B" encoding for non-ASCII header text, split into encoded words of
 * at most 75 chars without breaking a multi-byte UTF-8 sequence.
 */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value) && !value.includes('=?')) return value;
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    // 45 bytes of input -> 60 base64 chars -> 72-char encoded word including the 12-char wrapper.
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

function base64Body(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return b64.replace(/.{1,76}/g, (line) => line + CRLF).trimEnd();
}

/** Plain-text alternative for HTML mail clients that do not render HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Builds an RFC 5322 / MIME message (UTF-8, base64 transfer encoding).
 * Bcc is included as a header: Gmail uses it for delivery and strips it from
 * the copies recipients receive.
 */
export function buildMimeMessage(input: MimeMessageInput, boundarySeed?: string): string {
  const headers: [string, string][] = [['To', input.to.join(', ')]];
  if (input.cc?.length) headers.push(['Cc', input.cc.join(', ')]);
  if (input.bcc?.length) headers.push(['Bcc', input.bcc.join(', ')]);
  headers.push(['Subject', encodeHeaderValue(input.subject)]);
  if (input.inReplyTo) {
    headers.push(['In-Reply-To', input.inReplyTo]);
    headers.push(['References', input.references ?? input.inReplyTo]);
  }
  headers.push(['MIME-Version', '1.0']);
  for (const [name, value] of headers) {
    if (name !== 'Subject') assertHeaderSafe(name, value);
  }

  let bodyPart: string;
  if (input.contentType === 'text/plain') {
    headers.push(['Content-Type', 'text/plain; charset="UTF-8"']);
    headers.push(['Content-Transfer-Encoding', 'base64']);
    bodyPart = base64Body(input.body);
  } else {
    const boundary = `mcp_alt_${boundarySeed ?? randomBytes(12).toString('hex')}`;
    headers.push(['Content-Type', `multipart/alternative; boundary="${boundary}"`]);
    bodyPart = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(htmlToText(input.body)),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(input.body),
      `--${boundary}--`,
    ].join(CRLF);
  }

  return headers.map(([n, v]) => `${n}: ${v}`).join(CRLF) + CRLF + CRLF + bodyPart + CRLF;
}

export function toBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}
