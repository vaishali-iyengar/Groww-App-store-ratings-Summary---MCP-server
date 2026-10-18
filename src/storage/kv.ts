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

const CREDENTIAL_SUFFIXES = [
  { url: 'KV_REST_API_URL', token: 'KV_REST_API_TOKEN' },
  { url: 'REDIS_REST_URL', token: 'REDIS_REST_TOKEN' },
];

export type KvCredentialLookup =
  | { kind: 'found'; url: string; token: string; urlVariable: string }
  | { kind: 'missing' }
  /** Several different databases are configured; the variable names are listed so the operator can pick. */
  | { kind: 'ambiguous'; urlVariables: string[] };

/**
 * Finds Upstash REST credentials: the names the Vercel Marketplace integration injects
 * (KV_REST_API_*), Upstash's own (UPSTASH_REDIS_REST_*), or either with the custom prefix the
 * integration lets you choose (e.g. STORAGE_KV_REST_API_URL). The URL and token must share a prefix.
 */
export function findKvCredentials(env: NodeJS.ProcessEnv = process.env): KvCredentialLookup {
  const candidates: { url: string; token: string; urlVariable: string }[] = [];
  for (const name of Object.keys(env).sort()) {
    for (const suffix of CREDENTIAL_SUFFIXES) {
      if (!name.endsWith(suffix.url)) continue;
      const url = env[name];
      const token = env[name.slice(0, -suffix.url.length) + suffix.token];
      if (url && token) candidates.push({ url, token, urlVariable: name });
    }
  }
  const distinct = new Map(candidates.map((c) => [`${c.url}\n${c.token}`, c]));
  if (distinct.size === 0) return { kind: 'missing' };
  if (distinct.size > 1) return { kind: 'ambiguous', urlVariables: candidates.map((c) => c.urlVariable) };
  return { kind: 'found', ...candidates[0]! };
}

/** Returns an Upstash-backed store when REST credentials are found (see findKvCredentials). */
export function createKvFromEnv(env: NodeJS.ProcessEnv = process.env): KvStore | undefined {
  const found = findKvCredentials(env);
  if (found.kind !== 'found') return undefined;
  // Values are JSON strings we parse ourselves; automatic deserialization would turn them into objects.
  return new UpstashKvStore(
    new Redis({ url: found.url, token: found.token, automaticDeserialization: false }),
  );
}
