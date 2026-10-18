import { AppError } from './appError.js';

export type GoogleService = 'gmail' | 'docs';

/** Network error codes meaning the request never left this host, so a retry cannot duplicate a side effect. */
const PRE_SEND_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);
const NETWORK_CODES = new Set([
  ...PRE_SEND_NETWORK_CODES,
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);
const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'quotaExceeded',
  'RATE_LIMIT_EXCEEDED',
  'RESOURCE_EXHAUSTED',
]);
const SCOPE_REASONS = new Set([
  'insufficientPermissions',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'forbidden_scope',
]);

interface ExtractedError {
  status: number | undefined;
  reason: string | undefined;
  googleMessage: string | undefined;
  networkCode: string | undefined;
  retryAfterSeconds: number | undefined;
  oauthError: string | undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const rec = headers as Record<string, unknown>;
  const v = rec[name] ?? rec[name.toLowerCase()];
  return typeof v === 'string' ? v : undefined;
}

/** Pulls the useful fields out of a gaxios / google-auth-library error without depending on its class. */
export function extractGoogleError(err: unknown): ExtractedError {
  const e = (err ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const response = e.response as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  const data = response?.data;
  const status: number | undefined =
    typeof response?.status === 'number'
      ? response.status
      : typeof e.status === 'number'
        ? e.status
        : undefined;

  const apiError = data && typeof data === 'object' ? data.error : undefined;
  const oauthError = typeof apiError === 'string' ? apiError : undefined; // token endpoint: {"error":"invalid_grant"}
  const reason: string | undefined =
    (apiError && typeof apiError === 'object' && (apiError.errors?.[0]?.reason ?? apiError.status)) ||
    undefined;
  const googleMessage: string | undefined =
    (apiError && typeof apiError === 'object' && typeof apiError.message === 'string' && apiError.message) ||
    undefined;

  let networkCode: string | undefined;
  for (const candidate of [e.code, e.cause?.code, e.error?.code]) {
    if (typeof candidate === 'string' && NETWORK_CODES.has(candidate)) networkCode = candidate;
  }
  if (!networkCode && e.name === 'AbortError') networkCode = 'ETIMEDOUT';

  const retryAfterRaw = readHeader(response?.headers, 'retry-after');
  const retryAfter = retryAfterRaw !== undefined ? Number(retryAfterRaw) : NaN;

  const msg = typeof e.message === 'string' ? e.message : '';
  return {
    status,
    reason,
    googleMessage: googleMessage ? googleMessage.slice(0, 300) : undefined,
    networkCode,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined,
    oauthError: oauthError ?? (msg.includes('invalid_grant') ? 'invalid_grant' : undefined),
  };
}

/** True when the failure provably happened before the request reached Google. */
export function failedBeforeSending(err: unknown): boolean {
  const { networkCode, status } = extractGoogleError(err);
  return status === undefined && networkCode !== undefined && PRE_SEND_NETWORK_CODES.has(networkCode);
}

/**
 * Maps a Google API failure to a categorized AppError (§18, §19).
 * Raw Google payloads are reduced to status/reason/message so nothing
 * sensitive (request config, headers, tokens) leaks to the client.
 */
export function mapGoogleError(err: unknown, service: GoogleService): AppError {
  if (err instanceof AppError) return err;
  const x = extractGoogleError(err);
  const details: Record<string, unknown> = {};
  if (x.status !== undefined) details.google_status = x.status;
  if (x.reason) details.google_reason = x.reason;
  if (x.googleMessage) details.google_message = x.googleMessage;

  if (
    x.oauthError === 'invalid_grant' ||
    x.oauthError === 'invalid_client' ||
    x.oauthError === 'unauthorized_client'
  ) {
    return new AppError(
      'AUTHENTICATION_REQUIRED',
      'Google authorization has expired or been revoked. The account must be re-authorized.',
      { cause: err },
    );
  }

  if (x.status === undefined) {
    if (x.networkCode) {
      return new AppError('NETWORK_ERROR', `Network error while contacting Google (${x.networkCode}).`, {
        cause: err,
        details: { network_code: x.networkCode },
      });
    }
    return new AppError('GOOGLE_API_ERROR', 'Unexpected failure while calling the Google API.', {
      cause: err,
      retryable: false,
    });
  }

  const opts = { cause: err, details, retryAfterSeconds: x.retryAfterSeconds };

  if (x.status === 429 || (x.reason && RATE_LIMIT_REASONS.has(x.reason))) {
    return new AppError('RATE_LIMITED', 'Google API rate limit reached. Retry later.', opts);
  }
  if (x.status === 401) {
    return new AppError(
      'AUTHENTICATION_REQUIRED',
      'Google rejected the credentials. Re-authorization is required.',
      opts,
    );
  }
  if (x.status === 403 && x.reason && SCOPE_REASONS.has(x.reason)) {
    return new AppError(
      'AUTHORIZATION_DENIED',
      'The Google authorization does not include the permission required for this operation.',
      opts,
    );
  }
  if (x.status >= 500) {
    return new AppError('GOOGLE_API_ERROR', `Google API temporarily unavailable (HTTP ${x.status}).`, {
      ...opts,
      retryable: true,
    });
  }

  if (service === 'docs') {
    if (x.status === 404) {
      return new AppError(
        'DOCUMENT_NOT_FOUND',
        'The document was not found or is not visible to this account.',
        opts,
      );
    }
    if (x.status === 403) {
      return new AppError(
        'DOCUMENT_ACCESS_DENIED',
        'The authenticated Google account does not have permission to access or edit this document.',
        opts,
      );
    }
    if (x.status === 400) {
      return new AppError('INVALID_DOCUMENT', 'Google rejected the document request as invalid.', opts);
    }
  } else {
    if (x.status === 400) {
      const isRecipient = /recipient|to header|address/i.test(x.googleMessage ?? '');
      return isRecipient
        ? new AppError('INVALID_RECIPIENT', 'Google rejected one or more recipient addresses.', opts)
        : new AppError('INVALID_INPUT', 'Google rejected the email request as invalid.', opts);
    }
    if (x.status === 403) {
      return new AppError(
        'AUTHORIZATION_DENIED',
        'Gmail refused to send this message for this account.',
        opts,
      );
    }
    if (x.status === 404) {
      return new AppError('INVALID_INPUT', 'The referenced Gmail thread or message was not found.', opts);
    }
  }

  return new AppError('GOOGLE_API_ERROR', `Google API request failed (HTTP ${x.status}).`, {
    ...opts,
    retryable: false,
  });
}
