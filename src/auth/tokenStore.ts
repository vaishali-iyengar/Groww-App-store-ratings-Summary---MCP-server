import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import path from 'node:path';
import { KEY_PREFIX, type KvStore } from '../storage/kv.js';
import { Mutex, readJsonFile, writeJsonFileAtomic } from '../utils/fileStore.js';

/** OAuth credentials for one end user (§14). Never returned to MCP clients or written to logs. */
export interface OAuthToken {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string;
  token_type?: string | null;
  id_token?: string | null;
  /** The Google account email, recorded at authorization time for display in connection status. */
  email?: string;
  updated_at?: string;
}

export interface TokenStore {
  getToken(userId: string): Promise<OAuthToken | null>;
  saveToken(userId: string, token: OAuthToken): Promise<void>;
  deleteToken(userId: string): Promise<void>;
}

export class InMemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, OAuthToken>();
  async getToken(userId: string): Promise<OAuthToken | null> {
    const t = this.tokens.get(userId);
    return t ? { ...t } : null;
  }
  async saveToken(userId: string, token: OAuthToken): Promise<void> {
    this.tokens.set(userId, { ...token });
  }
  async deleteToken(userId: string): Promise<void> {
    this.tokens.delete(userId);
  }
}

interface EncryptedEntry {
  iv: string;
  tag: string;
  data: string;
}

interface TokenFile {
  version: 1;
  kdf: 'scrypt';
  salt: string;
  entries: Record<string, EncryptedEntry>;
}

const MIN_SECRET_LENGTH = 32;

function assertSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH)
    throw new Error(`Token store encryption key must be at least ${MIN_SECRET_LENGTH} characters`);
}

function deriveKey(secret: string, salt: string): Buffer {
  return scryptSync(secret, Buffer.from(salt, 'base64'), 32);
}

/** AES-256-GCM with the userId as AAD, which binds each ciphertext to its user: entries cannot be swapped. */
function encryptEntry(key: Buffer, userId: string, token: OAuthToken): EncryptedEntry {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(userId, 'utf8'));
  const data = Buffer.concat([
    cipher.update(JSON.stringify({ ...token, updated_at: new Date().toISOString() }), 'utf8'),
    cipher.final(),
  ]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptEntry(key: Buffer, userId: string, entry: EncryptedEntry): OAuthToken {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
  decipher.setAAD(Buffer.from(userId, 'utf8'));
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
  try {
    const plain = Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as OAuthToken;
  } catch {
    throw new Error('Unable to decrypt stored token (wrong TOKEN_STORE_ENCRYPTION_KEY or corrupted data)');
  }
}

/**
 * Local-development token store: AES-256-GCM encrypted per entry with a key
 * derived (scrypt) from TOKEN_STORE_ENCRYPTION_KEY; file mode 0600 inside a
 * 0700 directory. Production deployments should implement TokenStore over a
 * KMS-backed database or secret manager instead.
 */
export class EncryptedFileTokenStore implements TokenStore {
  private readonly file: string;
  private readonly mutex = new Mutex();
  private key: Buffer | undefined;

  constructor(
    dataDir: string,
    private readonly secret: string,
  ) {
    assertSecret(secret);
    this.file = path.join(dataDir, 'tokens.enc.json');
  }

  private async readFile(): Promise<TokenFile> {
    const existing = await readJsonFile<TokenFile>(this.file);
    if (existing) return existing;
    return { version: 1, kdf: 'scrypt', salt: randomBytes(16).toString('base64'), entries: {} };
  }

  private deriveKey(salt: string): Buffer {
    this.key ??= deriveKey(this.secret, salt);
    return this.key;
  }

  async getToken(userId: string): Promise<OAuthToken | null> {
    const file = await this.readFile();
    const entry = file.entries[userId];
    return entry ? decryptEntry(this.deriveKey(file.salt), userId, entry) : null;
  }

  saveToken(userId: string, token: OAuthToken): Promise<void> {
    return this.mutex.run(async () => {
      const file = await this.readFile();
      file.entries[userId] = encryptEntry(this.deriveKey(file.salt), userId, token);
      await writeJsonFileAtomic(this.file, file);
    });
  }

  deleteToken(userId: string): Promise<void> {
    return this.mutex.run(async () => {
      const file = await this.readFile();
      if (!(userId in file.entries)) return;
      delete file.entries[userId];
      await writeJsonFileAtomic(this.file, file);
    });
  }
}

/**
 * Token store shared by every instance of a serverless deployment. Same encryption as the file
 * store; one scrypt salt per database, created by whichever instance gets there first.
 */
export class KvTokenStore implements TokenStore {
  private key: Promise<Buffer> | undefined;

  constructor(
    private readonly kv: KvStore,
    private readonly secret: string,
  ) {
    assertSecret(secret);
  }

  private deriveKey(): Promise<Buffer> {
    this.key ??= (async () => {
      const saltKey = `${KEY_PREFIX}token-salt`;
      await this.kv.set(saltKey, randomBytes(16).toString('base64'), { onlyIfAbsent: true });
      const salt = await this.kv.get(saltKey);
      if (!salt) throw new Error('Token store salt is missing');
      return deriveKey(this.secret, salt);
    })();
    // A failed lookup (e.g. Redis briefly unreachable) must not be cached for the instance's lifetime.
    this.key.catch(() => (this.key = undefined));
    return this.key;
  }

  private entryKey(userId: string): string {
    return `${KEY_PREFIX}token:${userId}`;
  }

  async getToken(userId: string): Promise<OAuthToken | null> {
    const raw = await this.kv.get(this.entryKey(userId));
    return raw ? decryptEntry(await this.deriveKey(), userId, JSON.parse(raw) as EncryptedEntry) : null;
  }

  async saveToken(userId: string, token: OAuthToken): Promise<void> {
    const entry = encryptEntry(await this.deriveKey(), userId, token);
    await this.kv.set(this.entryKey(userId), JSON.stringify(entry));
  }

  async deleteToken(userId: string): Promise<void> {
    await this.kv.del(this.entryKey(userId));
  }
}
