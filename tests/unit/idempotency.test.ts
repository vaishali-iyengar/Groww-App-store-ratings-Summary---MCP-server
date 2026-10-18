import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/errors/appError.js';
import { MemoryKvStore } from '../../src/storage/kv.js';
import {
  FileIdempotencyStore,
  IN_FLIGHT_LEASE_MS,
  InMemoryIdempotencyStore,
  KvIdempotencyStore,
  runIdempotent,
  type IdempotencyStore,
} from '../../src/utils/idempotency.js';
import { hashRequest } from '../../src/utils/fileStore.js';
import { tempDir } from '../helpers.js';

type StoreFactory = (now?: () => number) => IdempotencyStore;

const stores: [string, StoreFactory][] = [
  ['InMemoryIdempotencyStore', (now) => new InMemoryIdempotencyStore(now)],
  ['KvIdempotencyStore', (now) => new KvIdempotencyStore(new MemoryKvStore(now), now)],
];

const baseWith = (store: IdempotencyStore) => ({
  store,
  key: 'k1',
  requestHash: 'h1',
  ttlSeconds: 60,
  mode: 'explicit' as const,
  classifyFailure: () => 'failed' as const,
});

describe.each(stores)('runIdempotent with %s', (_name, createStore) => {
  const base = (store: IdempotencyStore = createStore()) => baseWith(store);

  it('executes once and replays the stored result for an explicit key', async () => {
    const opts = base();
    const execute = vi.fn(async () => ({ message_id: 'm1' }));
    expect(await runIdempotent({ ...opts, execute })).toEqual({ message_id: 'm1' });
    expect(await runIdempotent({ ...opts, execute })).toEqual({ message_id: 'm1', idempotent_replay: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of a key with different parameters', async () => {
    const opts = base();
    await runIdempotent({ ...opts, execute: async () => ({}) });
    await expect(
      runIdempotent({ ...opts, requestHash: 'other', execute: async () => ({}) }),
    ).rejects.toMatchObject({
      code: 'DUPLICATE_REQUEST',
    });
  });

  it('auto mode rejects the repeat with DUPLICATE_REQUEST instead of replaying', async () => {
    const opts = { ...base(), mode: 'auto' as const };
    await runIdempotent({ ...opts, execute: async () => ({ message_id: 'm1' }) });
    await expect(runIdempotent({ ...opts, execute: async () => ({}) })).rejects.toMatchObject({
      code: 'DUPLICATE_REQUEST',
      details: { previous_result: { message_id: 'm1' } },
    });
  });

  it('rejects a concurrent duplicate while the first is in flight', async () => {
    const opts = base();
    let release!: () => void;
    const first = runIdempotent({
      ...opts,
      execute: () => new Promise<Record<string, unknown>>((r) => (release = () => r({ ok: true }))),
    });
    await new Promise((r) => setTimeout(r, 5));
    await expect(runIdempotent({ ...opts, execute: async () => ({}) })).rejects.toMatchObject({
      code: 'DUPLICATE_REQUEST',
      retryable: true,
    });
    release();
    await first;
  });

  it('allows a retry after a definite failure', async () => {
    const opts = base();
    await expect(
      runIdempotent({ ...opts, execute: async () => Promise.reject(new AppError('RATE_LIMITED', 'x')) }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(await runIdempotent({ ...opts, execute: async () => ({ ok: 1 }) })).toEqual({ ok: 1 });
  });

  it('refuses a retry after an ambiguous failure', async () => {
    const opts = { ...base(), classifyFailure: () => 'outcome_unknown' as const };
    await expect(
      runIdempotent({ ...opts, execute: async () => Promise.reject(new AppError('NETWORK_ERROR', 'reset')) }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    const execute = vi.fn(async () => ({}));
    await expect(runIdempotent({ ...opts, execute })).rejects.toMatchObject({
      code: 'DUPLICATE_REQUEST',
      details: { previous_error: 'NETWORK_ERROR' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('expires records after the TTL', async () => {
    let now = 1_000;
    const store = createStore(() => now);
    const execute = vi.fn(async () => ({}));
    await runIdempotent({ ...base(store), execute });
    now += 61_000;
    await runIdempotent({ ...base(store), execute });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('KvIdempotencyStore', () => {
  it('shares claims between instances using the same KV store', async () => {
    const kv = new MemoryKvStore();
    const a = new KvIdempotencyStore(kv);
    const b = new KvIdempotencyStore(kv);
    await runIdempotent({ ...baseWith(a), execute: async () => ({ id: 'done' }) });
    const execute = vi.fn(async () => ({}));
    expect(await runIdempotent({ ...baseWith(b), execute })).toEqual({ id: 'done', idempotent_replay: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it('treats a claim abandoned past the lease (a crashed or timed-out instance) as outcome_unknown', async () => {
    let now = 1_000;
    const kv = new MemoryKvStore(() => now);
    await new KvIdempotencyStore(kv, () => now).begin('k1', 'h1', 86_400);
    const b = new KvIdempotencyStore(kv, () => now);
    await expect(runIdempotent({ ...baseWith(b), execute: async () => ({}) })).rejects.toMatchObject({
      code: 'DUPLICATE_REQUEST',
      retryable: true,
    });
    now += IN_FLIGHT_LEASE_MS + 1;
    const execute = vi.fn(async () => ({}));
    await expect(runIdempotent({ ...baseWith(b), execute })).rejects.toMatchObject({
      code: 'DUPLICATE_REQUEST',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('FileIdempotencyStore', () => {
  it('persists across instances and treats interrupted attempts as outcome_unknown', async () => {
    const dir = tempDir();
    const a = new FileIdempotencyStore(dir);
    await runIdempotent({ ...baseWith(a), execute: async () => ({ id: 'done' }) });
    await a.begin('crashed', 'h', 60); // simulates a process dying mid-send

    const b = new FileIdempotencyStore(dir);
    expect(await runIdempotent({ ...baseWith(b), execute: async () => ({}) })).toEqual({
      id: 'done',
      idempotent_replay: true,
    });
    await expect(
      runIdempotent({ ...baseWith(b), key: 'crashed', requestHash: 'h', execute: async () => ({}) }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_REQUEST' });
  });
});

describe('hashRequest', () => {
  it('is independent of key order and ignores undefined', () => {
    expect(hashRequest({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      hashRequest({ b: [1, { d: 3, c: 2 }], a: 1, e: undefined }),
    );
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });
});
