import { AppError } from '../errors/appError.js';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Decides whether a (mapped) error may be retried. Defaults to `err.retryable`. */
  shouldRetry?: (err: AppError, attempt: number) => boolean;
  onRetry?: (err: AppError, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Bounded exponential backoff with full jitter (§19). `fn` must throw
 * AppErrors (map provider errors inside it). Retry-After is honoured when
 * present, capped at maxDelayMs.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const base = options.baseDelayMs ?? 250;
  const max = options.maxDelayMs ?? 5_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const shouldRetry = options.shouldRetry ?? ((err) => err.retryable);

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (raw) {
      const err =
        raw instanceof AppError ? raw : new AppError('INTERNAL_ERROR', 'Unexpected error', { cause: raw });
      if (attempt >= maxAttempts || !shouldRetry(err, attempt) || options.signal?.aborted) throw err;
      const backoff = Math.min(max, base * 2 ** (attempt - 1));
      const jittered = Math.floor(random() * backoff);
      const delay =
        err.retryAfterSeconds !== undefined ? Math.min(max, err.retryAfterSeconds * 1000) : jittered;
      options.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}
