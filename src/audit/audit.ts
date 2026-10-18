import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir } from '../utils/fileStore.js';
import { KEY_PREFIX, type KvStore } from '../storage/kv.js';
import type { Logger } from '../utils/logging.js';

export type AuditStatus = 'success' | 'failure' | 'blocked' | 'confirmation_required' | 'duplicate';

/** One record per attempted external side effect (§35). Contains targets and IDs, never message/document content. */
export interface AuditRecord {
  audit_id: string;
  request_id: string;
  user_id: string;
  client_id?: string | undefined;
  operation: string;
  target: string | string[];
  timestamp: string;
  status: AuditStatus;
  error_code?: string | undefined;
  result_id?: string | undefined;
  content_sha256?: string | undefined;
}

export interface AuditSink {
  record(entry: Omit<AuditRecord, 'audit_id' | 'timestamp'>): Promise<void>;
}

export const newAuditId = () => `aud_${randomBytes(9).toString('base64url')}`;

export class MemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];
  async record(entry: Omit<AuditRecord, 'audit_id' | 'timestamp'>): Promise<void> {
    this.records.push({ audit_id: newAuditId(), timestamp: new Date().toISOString(), ...entry });
  }
}

/** Append-only JSONL audit log (0600). Production deployments can ship this file or swap in a database sink. */
export class FileAuditSink implements AuditSink {
  private readonly file: string;
  constructor(
    dataDir: string,
    private readonly logger: Logger,
  ) {
    this.file = path.join(dataDir, 'audit.log');
  }

  async record(entry: Omit<AuditRecord, 'audit_id' | 'timestamp'>): Promise<void> {
    const rec: AuditRecord = { audit_id: newAuditId(), timestamp: new Date().toISOString(), ...entry };
    try {
      await ensurePrivateDir(path.dirname(this.file));
      await fs.appendFile(this.file, JSON.stringify(rec) + '\n', { mode: 0o600 });
    } catch (err) {
      // Audit failure must be visible to operators but must not turn a completed send into a reported failure.
      this.logger.error('failed to write audit record', { audit_id: rec.audit_id, error: err });
    }
  }
}

/** Capped audit list in the shared KV store, for serverless deployments with no persistent disk. */
export class KvAuditSink implements AuditSink {
  static readonly KEY = `${KEY_PREFIX}audit`;

  constructor(
    private readonly kv: KvStore,
    private readonly logger: Logger,
    private readonly maxEntries = 10_000,
  ) {}

  async record(entry: Omit<AuditRecord, 'audit_id' | 'timestamp'>): Promise<void> {
    const rec: AuditRecord = { audit_id: newAuditId(), timestamp: new Date().toISOString(), ...entry };
    try {
      await this.kv.pushCapped(KvAuditSink.KEY, JSON.stringify(rec), this.maxEntries);
    } catch (err) {
      // Same rule as the file sink: a failed audit write must not turn a completed send into a failure.
      this.logger.error('failed to write audit record', { audit_id: rec.audit_id, error: err });
    }
  }
}
