import { AppError } from '../errors/appError.js';

// Pragmatic addr-spec check (RFC 5321/5322 subset): dot-atom local part, LDH domain labels, alphabetic TLD.
// Display names ("Name <a@b>") and quoted local parts are intentionally rejected as ambiguous for the MVP.
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function isValidEmail(address: string): boolean {
  if (address.length > 254 || /[\s<>,;"\\]/.test(address)) return false;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at !== address.indexOf('@')) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || !LOCAL_PART.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => DOMAIN_LABEL.test(l))) return false;
  return /^[A-Za-z]{2,63}$/.test(labels[labels.length - 1]!);
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * Validates and normalizes a recipient list. Throws INVALID_RECIPIENT naming
 * the field and position of each bad address so the agent can fix it.
 */
export function normalizeRecipients(field: string, list: readonly string[] | undefined): string[] {
  if (!list) return [];
  const invalid: string[] = [];
  const out: string[] = [];
  list.forEach((raw, i) => {
    const addr = raw.trim();
    if (!isValidEmail(addr)) invalid.push(`${field}[${i}]`);
    else out.push(addr);
  });
  if (invalid.length > 0) {
    throw new AppError('INVALID_RECIPIENT', `Invalid email address in ${invalid.join(', ')}.`, {
      details: { invalid_fields: invalid },
    });
  }
  return out;
}

const DOC_ID = /^[A-Za-z0-9_-]{20,128}$/;
const DOC_URL = /^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/;

/** Accepts a bare document ID or a docs.google.com document URL and returns the ID. */
export function parseDocumentId(input: string): string {
  const value = input.trim();
  const fromUrl = DOC_URL.exec(value)?.[1];
  const id = fromUrl ?? value;
  if (!DOC_ID.test(id)) {
    throw new AppError(
      'INVALID_DOCUMENT',
      'document_id must be a Google Docs document ID (letters, digits, "-" and "_") or a docs.google.com document URL.',
    );
  }
  return id;
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Length in UTF-16 code units — the unit Google Docs uses for indexes. */
export function utf16Length(s: string): number {
  return s.length;
}
