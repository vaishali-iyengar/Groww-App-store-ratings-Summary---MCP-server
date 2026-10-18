import type { CallToolResult } from '@modelcontextprotocol/server';

/** Error categories returned to MCP clients (§18). */
export const ERROR_CODES = [
  'AUTHENTICATION_REQUIRED',
  'AUTHORIZATION_DENIED',
  'INVALID_INPUT',
  'INVALID_RECIPIENT',
  'INVALID_DOCUMENT',
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_ACCESS_DENIED',
  'GOOGLE_API_ERROR',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'DUPLICATE_REQUEST',
  'POLICY_BLOCKED',
  'CONFIRMATION_REQUIRED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const DEFAULT_RETRYABLE: Record<ErrorCode, boolean> = {
  AUTHENTICATION_REQUIRED: false,
  AUTHORIZATION_DENIED: false,
  INVALID_INPUT: false,
  INVALID_RECIPIENT: false,
  INVALID_DOCUMENT: false,
  DOCUMENT_NOT_FOUND: false,
  DOCUMENT_ACCESS_DENIED: false,
  GOOGLE_API_ERROR: true,
  RATE_LIMITED: true,
  NETWORK_ERROR: true,
  DUPLICATE_REQUEST: false,
  POLICY_BLOCKED: false,
  CONFIRMATION_REQUIRED: false,
  INTERNAL_ERROR: false,
};

export interface AppErrorOptions {
  retryable?: boolean;
  /** Safe, model-visible extra information. Never put credentials or raw API payloads here. */
  details?: Record<string, unknown>;
  cause?: unknown;
  /** Seconds the caller should wait before retrying (from Retry-After), when known. */
  retryAfterSeconds?: number;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface ErrorPayload {
  success: false;
  operation: string;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    retry_after_seconds?: number;
    details?: Record<string, unknown>;
  };
  request_id: string;
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError('INTERNAL_ERROR', 'An internal error occurred while processing the request.', {
    cause: err,
  });
}

/**
 * Converts any thrown value into a structured MCP tool error result.
 * Unknown errors are reduced to a generic INTERNAL_ERROR so stack traces and
 * provider internals never reach the client (§18).
 */
export function toErrorResult(err: unknown, operation: string, requestId: string): CallToolResult {
  const appErr = toAppError(err);
  const payload: ErrorPayload = {
    success: false,
    operation,
    error: {
      code: appErr.code,
      message: appErr.message,
      retryable: appErr.retryable,
      ...(appErr.retryAfterSeconds !== undefined ? { retry_after_seconds: appErr.retryAfterSeconds } : {}),
      ...(appErr.details ? { details: appErr.details } : {}),
    },
    request_id: requestId,
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}
