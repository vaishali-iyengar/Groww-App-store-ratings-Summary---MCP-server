import { createHash } from 'node:crypto';
import path from 'node:path';
import { Mutex, readJsonFile, writeJsonFileAtomic } from '../utils/fileStore.js';
import { KEY_PREFIX, type KvStore } from './kv.js';

/**
 * Records which documents this server created for each user. With policy
 * `googleDocs.restrictToCreatedDocuments`, only these documents (plus
 * `allowedDocumentIds`) can be read or appended to, so an agent can never
 * write into the user's other documents.
 */
export interface CreatedDocsRegistry {
  add(userId: string, documentId: string): Promise<void>;
  has(userId: string, documentId: string): Promise<boolean>;
}

export class InMemoryCreatedDocsRegistry implements CreatedDocsRegistry {
  private readonly docs = new Set<string>();
  async add(userId: string, documentId: string): Promise<void> {
    this.docs.add(`${userId}\u0000${documentId}`);
  }
  async has(userId: string, documentId: string): Promise<boolean> {
    return this.docs.has(`${userId}\u0000${documentId}`);
  }
}

/** Local mode: a 0600 JSON file in DATA_DIR, so the record survives restarts. */
export class FileCreatedDocsRegistry implements CreatedDocsRegistry {
  private readonly file: string;
  private readonly mutex = new Mutex();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'created-docs.json');
  }

  add(userId: string, documentId: string): Promise<void> {
    return this.mutex.run(async () => {
      const data = (await readJsonFile<Record<string, string[]>>(this.file)) ?? {};
      const list = data[userId] ?? [];
      if (!list.includes(documentId)) list.push(documentId);
      data[userId] = list;
      await writeJsonFileAtomic(this.file, data);
    });
  }

  async has(userId: string, documentId: string): Promise<boolean> {
    const data = await readJsonFile<Record<string, string[]>>(this.file);
    return data?.[userId]?.includes(documentId) ?? false;
  }
}

/** Shared mode (Vercel / multiple instances): one key per user and document in the KV store. */
export class KvCreatedDocsRegistry implements CreatedDocsRegistry {
  constructor(private readonly kv: KvStore) {}

  private key(userId: string, documentId: string): string {
    const user = createHash('sha256').update(userId).digest('hex').slice(0, 16);
    return `${KEY_PREFIX}created-doc:${user}:${documentId}`;
  }

  async add(userId: string, documentId: string): Promise<void> {
    await this.kv.set(this.key(userId, documentId), '1');
  }

  async has(userId: string, documentId: string): Promise<boolean> {
    return (await this.kv.get(this.key(userId, documentId))) !== null;
  }
}
