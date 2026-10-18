import { describe, expect, it } from 'vitest';
import { KvAuditSink } from '../../src/audit/audit.js';
import { KvTokenStore } from '../../src/auth/tokenStore.js';
import { createKvFromEnv, KEY_PREFIX, MemoryKvStore, UpstashKvStore } from '../../src/storage/kv.js';
import { KvPendingStore } from '../../src/storage/pendingStore.js';
import { createLogger } from '../../src/utils/logging.js';
import { TEST_TOKEN } from '../helpers.js';

const KEY = 'a-very-long-shared-deployment-encryption-key';

describe('MemoryKvStore', () => {
  it('implements NX, TTL, KEEPTTL, GETDEL and capped lists', async () => {
    let now = 0;
    const kv = new MemoryKvStore(() => now);
    expect(await kv.set('a', '1', { ttlMs: 100, onlyIfAbsent: true })).toBe(true);
    expect(await kv.set('a', '2', { onlyIfAbsent: true })).toBe(false);
    expect(await kv.set('a', '3', { keepTtl: true })).toBe(true);
    now = 99;
    expect(await kv.get('a')).toBe('3');
    now = 100;
    expect(await kv.get('a')).toBeNull();

    await kv.set('b', 'x');
    expect(await kv.getDel('b')).toBe('x');
    expect(await kv.getDel('b')).toBeNull();

    for (const v of ['1', '2', '3']) await kv.pushCapped('l', v, 2);
    expect(kv.list('l')).toEqual(['3', '2']);
  });
});

describe('UpstashKvStore', () => {
  it('maps operations onto Redis commands', async () => {
    const calls: unknown[][] = [];
    const values = new Map<string, string>();
    const redis = {
      get: async (k: string) => values.get(k) ?? null,
      set: async (k: string, v: string, opts?: { nx?: boolean }) => {
        calls.push(['set', k, v, opts]);
        if (opts?.nx && values.has(k)) return null;
        values.set(k, v);
        return 'OK';
      },
      getdel: async (k: string) => {
        const v = values.get(k) ?? null;
        values.delete(k);
        return v;
      },
      del: async (k: string) => calls.push(['del', k]),
      pipeline: () => {
        const p = {
          lpush: (...a: unknown[]) => (calls.push(['lpush', ...a]), p),
          ltrim: (...a: unknown[]) => (calls.push(['ltrim', ...a]), p),
          exec: async () => calls.push(['exec']),
        };
        return p;
      },
    };
    const kv = new UpstashKvStore(redis as never);
    expect(await kv.set('k', 'v', { ttlMs: 500, onlyIfAbsent: true })).toBe(true);
    expect(await kv.set('k', 'w', { ttlMs: 500, onlyIfAbsent: true })).toBe(false);
    await kv.set('k', 'x', { keepTtl: true });
    await kv.set('j', 'y', { ttlMs: 10 });
    await kv.set('i', 'z');
    expect(await kv.getDel('k')).toBe('x');
    await kv.del('j');
    await kv.pushCapped('list', 'e', 3);
    expect(calls).toEqual([
      ['set', 'k', 'v', { px: 500, nx: true }],
      ['set', 'k', 'w', { px: 500, nx: true }],
      ['set', 'k', 'x', { keepTtl: true }],
      ['set', 'j', 'y', { px: 10 }],
      ['set', 'i', 'z', undefined],
      ['del', 'j'],
      ['lpush', 'list', 'e'],
      ['ltrim', 'list', 0, 2],
      ['exec'],
    ]);
  });

  it('is created only when REST credentials are present (Vercel or Upstash variable names)', () => {
    expect(createKvFromEnv({})).toBeUndefined();
    expect(createKvFromEnv({ KV_REST_API_URL: 'https://x.upstash.io' })).toBeUndefined();
    expect(
      createKvFromEnv({ KV_REST_API_URL: 'https://x.upstash.io', KV_REST_API_TOKEN: 't' }),
    ).toBeInstanceOf(UpstashKvStore);
    expect(
      createKvFromEnv({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' }),
    ).toBeInstanceOf(UpstashKvStore);
  });
});

describe('KvPendingStore', () => {
  it('lets any instance consume a value exactly once, before it expires', async () => {
    let now = 0;
    const kv = new MemoryKvStore(() => now);
    const a = new KvPendingStore<{ userId: string }>(kv, 'confirm');
    const b = new KvPendingStore<{ userId: string }>(kv, 'confirm');
    await a.put('tok', { userId: 'alice' }, 1_000);
    expect(await b.take('tok')).toEqual({ userId: 'alice' });
    expect(await a.take('tok')).toBeUndefined();

    await a.put('late', { userId: 'alice' }, 1_000);
    now = 1_000;
    expect(await b.take('late')).toBeUndefined();
  });

  it('keeps namespaces apart', async () => {
    const kv = new MemoryKvStore();
    await new KvPendingStore(kv, 'oauth').put('n', 1, 1_000);
    expect(await new KvPendingStore(kv, 'confirm').take('n')).toBeUndefined();
    expect(await kv.get(`${KEY_PREFIX}oauth:n`)).toBe('1');
  });
});

describe('KvTokenStore', () => {
  it('round-trips tokens per user, shared between instances', async () => {
    const kv = new MemoryKvStore();
    await new KvTokenStore(kv, KEY).saveToken('alice', TEST_TOKEN);
    const other = new KvTokenStore(kv, KEY);
    expect(await other.getToken('alice')).toMatchObject({ refresh_token: TEST_TOKEN.refresh_token });
    expect(await other.getToken('bob')).toBeNull();
    await other.deleteToken('alice');
    expect(await new KvTokenStore(kv, KEY).getToken('alice')).toBeNull();
  });

  it('stores only ciphertext, bound to its user, and fails closed with the wrong key', async () => {
    const kv = new MemoryKvStore();
    await new KvTokenStore(kv, KEY).saveToken('alice', TEST_TOKEN);
    const raw = (await kv.get(`${KEY_PREFIX}token:alice`))!;
    expect(raw).not.toContain('ya29');
    expect(raw).not.toContain(String(TEST_TOKEN.refresh_token));

    await kv.set(`${KEY_PREFIX}token:mallory`, raw); // entries cannot be moved to another user
    await expect(new KvTokenStore(kv, KEY).getToken('mallory')).rejects.toThrow(/decrypt/);
    await expect(new KvTokenStore(kv, 'x'.repeat(40)).getToken('alice')).rejects.toThrow(/decrypt/);
    expect(() => new KvTokenStore(kv, 'short')).toThrow();
  });
});

describe('KvAuditSink', () => {
  it('appends records to a capped list without content', async () => {
    const kv = new MemoryKvStore();
    const sink = new KvAuditSink(kv, createLogger('silent'), 2);
    for (const id of ['r1', 'r2', 'r3']) {
      await sink.record({
        request_id: id,
        user_id: 'alice',
        operation: 'gmail.send_email',
        target: ['a@example.com'],
        status: 'success',
      });
    }
    const records = kv.list(KvAuditSink.KEY).map((r) => JSON.parse(r) as { request_id: string });
    expect(records.map((r) => r.request_id)).toEqual(['r3', 'r2']);
  });

  it('never fails the operation when the store is unreachable', async () => {
    const kv = new MemoryKvStore();
    kv.pushCapped = async () => Promise.reject(new Error('down'));
    await expect(
      new KvAuditSink(kv, createLogger('silent')).record({
        request_id: 'r',
        user_id: 'u',
        operation: 'google_docs.append',
        target: 'doc',
        status: 'success',
      }),
    ).resolves.toBeUndefined();
  });
});
