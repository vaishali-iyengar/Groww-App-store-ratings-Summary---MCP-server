import { KEY_PREFIX, MemoryKvStore, type KvStore } from './kv.js';

/** Short-lived, single-use records: confirmation tokens and OAuth state. */
export interface PendingStore<T> {
  put(key: string, value: T, ttlMs: number): Promise<void>;
  /** Atomically reads and deletes: a value can be consumed at most once, by any instance. */
  take(key: string): Promise<T | undefined>;
}

export class KvPendingStore<T> implements PendingStore<T> {
  constructor(
    private readonly kv: KvStore,
    private readonly namespace: string,
  ) {}

  private key(key: string): string {
    return `${KEY_PREFIX}${this.namespace}:${key}`;
  }

  async put(key: string, value: T, ttlMs: number): Promise<void> {
    await this.kv.set(this.key(key), JSON.stringify(value), { ttlMs: Math.max(1, Math.ceil(ttlMs)) });
  }

  async take(key: string): Promise<T | undefined> {
    const raw = await this.kv.getDel(this.key(key));
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }
}

/** Process-local pending store (stdio, single-instance HTTP, tests). */
export function inMemoryPendingStore<T>(namespace: string, now?: () => number): PendingStore<T> {
  return new KvPendingStore<T>(new MemoryKvStore(now), namespace);
}
