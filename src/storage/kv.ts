import { Redis } from '@upstash/redis';

/** Prefix for every key this server writes, so a shared Redis database stays easy to inspect and clean. */
export const KEY_PREFIX = 'gwmcp:';

export interface KvSetOptions {
  /** Expire the key after this many milliseconds. */
  ttlMs?: number;
  /** Keep the key's current expiry (ignored when `ttlMs` is set). */
  keepTtl?: boolean;
  /** Only write when the key does not exist (SET NX). */
  onlyIfAbsent?: boolean;
}

/**
 * The few key-value operations the shared stores need. Serverless deployments (Vercel) run many
 * short-lived instances, so tokens, idempotency records, confirmations and OAuth state must live
 * here rather than in process memory or on local disk. Values are opaque strings.
 */
export interface KvStore {
  get(key: string): Promise<string | null>;
  /** Returns false when `onlyIfAbsent` is set and the key already exists. */
  set(key: string, value: string, opts?: KvSetOptions): Promise<boolean>;
  /** Atomically reads and deletes the key, so the value can be consumed at most once. */
  getDel(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  /** Prepends to a list and trims it to the newest `maxLength` entries. */
  pushCapped(key: string, value: string, maxLength: number): Promise<void>;
}

/** Single-process KvStore: the default for stdio/Docker and the fake used in tests. */
export class MemoryKvStore implements KvStore {
  private readonly values = new Map<string, { value: string; expiresAt: number | undefined }>();
  private readonly lists = new Map<string, string[]>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string) {
    const entry = this.values.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, v] of this.values)
      if (v.expiresAt !== undefined && v.expiresAt <= t) this.values.delete(k);
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, opts: KvSetOptions = {}): Promise<boolean> {
    this.prune();
    const current = this.live(key);
    if (opts.onlyIfAbsent && current) return false;
    const expiresAt =
      opts.ttlMs !== undefined ? this.now() + opts.ttlMs : opts.keepTtl ? current?.expiresAt : undefined;
    this.values.set(key, { value, expiresAt });
    return true;
  }

  async getDel(key: string): Promise<string | null> {
    const value = this.live(key)?.value ?? null;
    this.values.delete(key);
    return value;
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  async pushCapped(key: string, value: string, maxLength: number): Promise<void> {
    this.lists.set(key, [value, ...(this.lists.get(key) ?? [])].slice(0, maxLength));
  }

  /** Inspection helper for tests and debugging. */
  list(key: string): string[] {
    return [...(this.lists.get(key) ?? [])];
  }
}

/** KvStore over Upstash Redis (REST), which suits serverless functions: no connection pool to keep warm. */
export class UpstashKvStore implements KvStore {
  constructor(private readonly redis: Redis) {}

  get(key: string): Promise<string | null> {
    return this.redis.get<string>(key);
  }

  async set(key: string, value: string, opts: KvSetOptions = {}): Promise<boolean> {
    const { ttlMs, keepTtl, onlyIfAbsent } = opts;
    let result: unknown;
    if (onlyIfAbsent) {
      result =
        ttlMs !== undefined
          ? await this.redis.set(key, value, { px: ttlMs, nx: true })
          : await this.redis.set(key, value, { nx: true });
    } else if (ttlMs !== undefined) {
      result = await this.redis.set(key, value, { px: ttlMs });
    } else if (keepTtl) {
      result = await this.redis.set(key, value, { keepTtl: true });
    } else {
      result = await this.redis.set(key, value);
    }
    return result !== null;
  }

  getDel(key: string): Promise<string | null> {
    return this.redis.getdel<string>(key);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async pushCapped(key: string, value: string, maxLength: number): Promise<void> {
    const p = this.redis.pipeline();
    p.lpush(key, value);
    p.ltrim(key, 0, maxLength - 1);
    await p.exec();
  }
}

/**
 * Returns an Upstash-backed store when its REST credentials are present: the names the Vercel
 * Marketplace integration injects (KV_REST_API_*) or Upstash's own (UPSTASH_REDIS_REST_*).
 */
export function createKvFromEnv(env: NodeJS.ProcessEnv = process.env): KvStore | undefined {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) return undefined;
  // Values are JSON strings we parse ourselves; automatic deserialization would turn them into objects.
  return new UpstashKvStore(new Redis({ url, token, automaticDeserialization: false }));
}
