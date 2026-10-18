import { describe, expect, it } from 'vitest';
import { failedBeforeSending, mapGoogleError } from '../../src/errors/googleErrors.js';
import { toErrorResult } from '../../src/errors/appError.js';

function apiError(
  status: number,
  reason?: string,
  message = 'Google says no',
  headers: Record<string, string> = {},
) {
  const err = new Error(message) as Error & Record<string, unknown>;
  err.status = status;
  err.response = {
    status,
    headers: new Headers(headers),
    data: { error: { code: status, message, errors: reason ? [{ reason }] : [], status: 'X' } },
    config: { headers: { Authorization: 'Bearer ya29.SECRET' } },
  };
  return err;
}

function netError(code: string) {
  return Object.assign(new Error(`connect ${code}`), { code });
}

describe('mapGoogleError', () => {
  it.each([
    ['docs', apiError(404), 'DOCUMENT_NOT_FOUND', false],
    ['docs', apiError(403, 'forbidden'), 'DOCUMENT_ACCESS_DENIED', false],
    ['docs', apiError(400, 'badRequest'), 'INVALID_DOCUMENT', false],
    ['docs', apiError(403, 'insufficientPermissions'), 'AUTHORIZATION_DENIED', false],
    ['gmail', apiError(400, 'invalidArgument', 'Invalid To header'), 'INVALID_RECIPIENT', false],
    ['gmail', apiError(400, 'invalidArgument', 'Invalid raw'), 'INVALID_INPUT', false],
    ['gmail', apiError(403, 'forbidden'), 'AUTHORIZATION_DENIED', false],
    ['gmail', apiError(401), 'AUTHENTICATION_REQUIRED', false],
    ['gmail', apiError(429), 'RATE_LIMITED', true],
    ['gmail', apiError(403, 'userRateLimitExceeded'), 'RATE_LIMITED', true],
    ['gmail', apiError(500), 'GOOGLE_API_ERROR', true],
    ['docs', apiError(503), 'GOOGLE_API_ERROR', true],
    ['gmail', netError('ECONNRESET'), 'NETWORK_ERROR', true],
    ['gmail', netError('ENOTFOUND'), 'NETWORK_ERROR', true],
  ] as const)('%s %o -> %s', (service, err, code, retryable) => {
    const mapped = mapGoogleError(err, service);
    expect(mapped.code).toBe(code);
    expect(mapped.retryable).toBe(retryable);
  });

  it('maps a revoked refresh token (invalid_grant) to AUTHENTICATION_REQUIRED', () => {
    const err = Object.assign(new Error('invalid_grant'), {
      response: {
        status: 400,
        data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      },
    });
    expect(mapGoogleError(err, 'gmail').code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('honours Retry-After', () => {
    expect(
      mapGoogleError(apiError(429, undefined, 'slow down', { 'retry-after': '7' }), 'docs').retryAfterSeconds,
    ).toBe(7);
  });

  it('never leaks request config, headers or tokens into the client-visible result', () => {
    const result = toErrorResult(
      mapGoogleError(apiError(403, 'forbidden'), 'docs'),
      'google_docs.append',
      'req_1',
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('Authorization');
    expect(result.structuredContent).toMatchObject({
      success: false,
      error: { code: 'DOCUMENT_ACCESS_DENIED', retryable: false, details: { google_status: 403 } },
    });
  });

  it('reduces unknown errors to INTERNAL_ERROR without stack traces', () => {
    const result = toErrorResult(new TypeError('x is undefined at /srv/app.js:10'), 'op', 'req_1');
    expect(JSON.stringify(result)).not.toContain('/srv/app.js');
    expect(result.structuredContent).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });
});

describe('failedBeforeSending', () => {
  it('is true only for errors that prove the request never left the host', () => {
    expect(failedBeforeSending(netError('ECONNREFUSED'))).toBe(true);
    expect(failedBeforeSending(netError('ENOTFOUND'))).toBe(true);
    expect(failedBeforeSending(netError('ECONNRESET'))).toBe(false);
    expect(failedBeforeSending(netError('ETIMEDOUT'))).toBe(false);
    expect(failedBeforeSending(apiError(500))).toBe(false);
  });
});
