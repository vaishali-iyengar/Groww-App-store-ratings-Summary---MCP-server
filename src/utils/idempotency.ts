import path from 'node:path';
import { AppError } from '../errors/appError.js';
import { KEY_PREFIX, type KvStore } from '../storage/kv.js';
import { Mutex, readJsonFile, writeJsonFileAtomic } from './fileStore.js';

/**
 * - `in_flight`: an attempt is running.
 * - `succeeded`: completed; the stored result is replayed for retries.
 * - `failed`: failed in a way that provably did not perform the side effect; the key may be reused.
 * - `outcome_unknown`: failed after the request may have reached Google (e.g. timeout); retries are refused.
 */
export type IdempotencyStatus = 'in_flight' | 'succeeded' | 'failed' | 'outcome_unknown';

export interface IdempotencyRecord {
  requestHash: string;
  status: IdempotencyStatus;
  result?: Record<string, unknown>;
  errorCode?: string;
  createdAt: number;
  expiresAt: number;
}

export type BeginResult = { kind: 'started' } | { kind: 'existing'; record: IdempotencyRecord };

export interface IdempotencyStore {
  /** Atomically claims `key` unless a live record exists (a `failed` record is reclaimed). */
  begin(key: string, requestHash: string, ttlSeconds: number): Promise<BeginResult>;
  complete(key: string, result: Record<string, unknown>): Promise<void>;
  fail(key: string, status: 'failed' | 'outcome_unknown', errorCode: string): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  protected records = new Map<string, IdempotencyRecord>();
  protected readonly mutex = new Mutex();

  constructor(protected readonly now: () => number = Date.now) {}

  begin(key: string, requestHash: string, ttlSeconds: number): Promise<BeginResult> {
    return this.mutex.run(async () => {
      await this.load();
      this.prune();
      const existing = this.records.get(key);
      if (existing && existing.status !== 'failed') return { kind: 'existing', record: { ...existing } };
      const t = this.now();
      this.records.set(key, {
        requestHash,
        status: 'in_flight',
        createdAt: t,
        expiresAt: t + ttlSeconds * 1000,
      });
      await this.persist();
      return { kind: 'started' };
    });
  }

  complete(key: string, result: Record<string, unknown>): Promise<void> {
    return this.update(key, { status: 'succeeded', result });
  }

  fail(key: string, status: 'failed' | 'outcome_unknown', errorCode: string): Promise<void> {
    return this.update(key, { status, errorCode });
  }

  private update(key: string, patch: Partial<IdempotencyRecord>): Promise<void> {
    return this.mutex.run(async () => {
      const rec = this.records.get(key);
      if (!rec) return;
      this.records.set(key, { ...rec, ...patch });
      await this.persist();
    });
  }

  private prune(): void {
    const t = this.now();
    for (const [k, r] of this.records) if (r.expiresAt <= t) this.records.delete(k);
  }

  protected async load(): Promise<void> {}
  protected async persist(): Promise<void> {}
}

/** Persists records to a 0600 JSON file so duplicate protection survives restarts of a local server. */
export class FileIdempotencyStore extends InMemoryIdempotencyStore {
  private loaded = false;
  private readonly file: string;

  constructor(dataDir: string, now?: () => number) {
    super(now);
    this.file = path.join(dataDir, 'idempotency.json');
  }

  protected override async load(): Promise<void> {
    if (this.loaded) return;
    const data = await readJsonFile<Record<string, IdempotencyRecord>>(this.file);
    this.records = new Map(Object.entries(data ?? {}));
    // An in_flight record left by a crashed process is ambiguous: we cannot know if the send happened.
    for (const [k, r] of this.records)
      if (r.status === 'in_flight') this.records.set(k, { ...r, status: 'outcome_unknown' });
    this.loaded = true;
  }

  protected override async persist(): Promise<void> {
    await writeJsonFileAtomic(this.file, Object.fromEntries(this.records));
  }
}

/**
 * An in_flight claim older than this is treated like one left by a crashed process (see
 * FileIdempotencyStore.load): the side effect may or may not have happened. Well above the
 * function timeout, so a live attempt is never reclassified.
 */
export const IN_FLIGHT_LEASE_MS = 5 * 60 * 1000;

/**
 * Idempotency records shared by every instance of a serverless deployment. `begin` claims a key
 * with SET NX, so two instances can never both start the same request. `failed` records are
 * deleted rather than stored: the other stores re-claim them anyway, and deleting keeps the
 * claim a single atomic operation.
 */
export class KvIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly kv: KvStore,
    private readonly now: () => number = Date.now,
  ) {}

  private key(key: string): string {
    return `${KEY_PREFIX}idem:${key}`;
  }

  async begin(key: string, requestHash: string, ttlSeconds: number): Promise<BeginResult> {
    const t = this.now();
    const ttlMs = ttlSeconds * 1000;
    const record: IdempotencyRecord = {
      requestHash,
      status: 'in_flight',
      createdAt: t,
      expiresAt: t + ttlMs,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.kv.set(this.key(key), JSON.stringify(record), { ttlMs, onlyIfAbsent: true })) {
        return { kind: 'started' };
      }
      const raw = await this.kv.get(this.key(key));
      if (raw === null) continue; // expired or released between the two calls: try to claim again
      const existing = JSON.parse(raw) as IdempotencyRecord;
      if (existing.status === 'in_flight' && t - existing.createdAt > IN_FLIGHT_LEASE_MS) {
        return { kind: 'existing', record: { ...existing, status: 'outcome_unknown' } };
      }
      return { kind: 'existing', record: existing };
    }
    throw new AppError('INTERNAL_ERROR', 'Could not claim the idempotency key. Retry the request.', {
      retryable: true,
    });
  }

  complete(key: string, result: Record<string, unknown>): Promise<void> {
    return this.update(key, { status: 'succeeded', result });
  }

  async fail(key: string, status: 'failed' | 'outcome_unknown', errorCode: string): Promise<void> {
    if (status === 'failed') return this.kv.del(this.key(key));
    return this.update(key, { status, errorCode });
  }

  /** Only the instance holding the in_flight claim updates a record, so read-modify-write is safe here. */
  private async update(key: string, patch: Partial<IdempotencyRecord>): Promise<void> {
    const raw = await this.kv.get(this.key(key));
    if (raw === null) return;
    const record = { ...(JSON.parse(raw) as IdempotencyRecord), ...patch };
    await this.kv.set(this.key(key), JSON.stringify(record), { keepTtl: true });
  }
}

export interface IdempotentRunOptions<T extends Record<string, unknown>> {
  store: IdempotencyStore;
  key: string;
  requestHash: string;
  ttlSeconds: number;
  /** `explicit`: caller-supplied key, successful retries replay the stored result. `auto`: server-derived dedupe. */
  mode: 'explicit' | 'auto';
  execute: () => Promise<T>;
  /** Classifies a failure: `failed` if the side effect provably did not happen, else `outcome_unknown`. */
  classifyFailure: (err: unknown) => 'failed' | 'outcome_unknown';
}

/**
 * Runs a side-effecting operation at most once per key (§17).
 * Explicit keys replay the earlier result; automatic dedupe rejects the repeat with DUPLICATE_REQUEST
 * so the agent can tell the user nothing new was sent.
 */
export async function runIdempotent<T extends Record<string, unknown>>(
  opts: IdempotentRunOptions<T>,
): Promise<T & { idempotent_replay?: boolean }> {
  const begun = await opts.store.begin(opts.key, opts.requestHash, opts.ttlSeconds);
  if (begun.kind === 'existing') {
    const rec = begun.record;
    if (rec.requestHash !== opts.requestHash) {
      throw new AppError(
        'DUPLICATE_REQUEST',
        'This idempotency_key was already used for a request with different parameters. Use a new key.',
      );
    }
    if (rec.status === 'in_flight') {
      throw new AppError('DUPLICATE_REQUEST', 'An identical request is still being processed.', {
        retryable: true,
      });
    }
    if (rec.status === 'outcome_unknown') {
      throw new AppError(
        'DUPLICATE_REQUEST',
        'A previous identical attempt failed with an unknown outcome and may already have taken effect. ' +
          'Verify with the user before retrying with a new idempotency_key.',
        { details: { previous_error: rec.errorCode } },
      );
    }
    if (opts.mode === 'explicit') return { ...(rec.result as T), idempotent_replay: true };
    throw new AppError(
      'DUPLICATE_REQUEST',
      'An identical request completed moments ago, so this repeat was suppressed. ' +
        'If the user really wants it performed again, retry with a distinct idempotency_key.',
      { details: { previous_result: rec.result } },
    );
  }

  try {
    const result = await opts.execute();
    await opts.store.complete(opts.key, result);
    return result;
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'INTERNAL_ERROR';
    await opts.store.fail(opts.key, opts.classifyFailure(err), code);
    throw err;
  }
}
