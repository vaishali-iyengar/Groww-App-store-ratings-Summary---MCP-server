import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { docs_v1 } from '@googleapis/docs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { MemoryAuditSink } from '../src/audit/audit.js';
import { InMemoryTokenStore, type OAuthToken } from '../src/auth/tokenStore.js';
import type { TransportMode } from '../src/auth/userContext.js';
import { DEFAULT_SCOPES, loadConfig, type Config } from '../src/config/config.js';
import { AppError } from '../src/errors/appError.js';
import type { DocsApi } from '../src/integrations/google/docsClient.js';
import type { GmailApi, SentMessage } from '../src/integrations/google/gmailClient.js';
import { GoogleAuthProvider } from '../src/integrations/google/oauthClient.js';
import { Metrics } from '../src/observability/metrics.js';
import { ConfirmationService } from '../src/policy/confirmation.js';
import { defaultPolicy, mergePolicy, PolicyEngine } from '../src/policy/policy.js';
import type { ServerDeps } from '../src/server/deps.js';
import { createMcpServer } from '../src/server/mcpServer.js';
import type { KvStore } from '../src/storage/kv.js';
import { KvPendingStore } from '../src/storage/pendingStore.js';
import { InMemoryIdempotencyStore, KvIdempotencyStore } from '../src/utils/idempotency.js';
import { createLogger } from '../src/utils/logging.js';

export const DOC_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
export const TEST_TOKEN: OAuthToken = {
  access_token: 'ya29.test-access-token-SECRET',
  refresh_token: '1//test-refresh-token-SECRET',
  expiry_date: Date.now() + 3600_000,
  scope: DEFAULT_SCOPES.join(' '),
  token_type: 'Bearer',
  email: 'owner@example.com',
};

export function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'gwmcp-test-'));
}

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret-SECRET',
    TOKEN_STORE_ENCRYPTION_KEY: 'k'.repeat(40),
    DATA_DIR: tempDir(),
    LOG_LEVEL: 'silent',
    ...env,
  });
}

export class FakeGmail implements GmailApi {
  readonly sent: { userId: string; raw: string; threadId: string | undefined }[] = [];
  /** Errors thrown by the next calls, in order. */
  readonly failures: unknown[] = [];

  async sendRaw(userId: string, raw: string, threadId?: string): Promise<SentMessage> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push({ userId, raw, threadId });
    const id = `msg${this.sent.length.toString().padStart(4, '0')}`;
    return { id, threadId: threadId ?? `thr${id}`, labelIds: ['SENT'] };
  }

  decoded(i = 0): string {
    return Buffer.from(this.sent[i]!.raw, 'base64url').toString('utf8');
  }
}

interface FakeTab {
  id: string;
  title: string;
  text: string;
  children?: FakeTab[];
}

/** Minimal in-memory Google Docs: each tab's body is plain text ending in "\n". */
export class FakeDocs implements DocsApi {
  readonly documents = new Map<string, { title: string; revision: number; tabs: FakeTab[] }>();
  readonly updates: { documentId: string; requests: docs_v1.Schema$Request[] }[] = [];
  readonly getFailures: unknown[] = [];
  readonly updateFailures: { error: unknown; applyFirst?: boolean }[] = [];
  /** documentId -> userIds allowed to access it (absent = everyone). */
  readonly acl = new Map<string, string[]>();

  addDocument(id: string, title: string, tabs: FakeTab[]): void {
    this.documents.set(id, { title, revision: 1, tabs });
  }

  private access(userId: string, documentId: string) {
    const doc = this.documents.get(documentId);
    if (!doc)
      throw new AppError(
        'DOCUMENT_NOT_FOUND',
        'The document was not found or is not visible to this account.',
      );
    const allowed = this.acl.get(documentId);
    if (allowed && !allowed.includes(userId)) {
      throw new AppError(
        'DOCUMENT_ACCESS_DENIED',
        'The authenticated Google account does not have permission.',
      );
    }
    return doc;
  }

  tabText(documentId: string, tabId: string): string {
    const find = (tabs: FakeTab[]): FakeTab | undefined => {
      for (const t of tabs) {
        if (t.id === tabId) return t;
        const c = find(t.children ?? []);
        if (c) return c;
      }
      return undefined;
    };
    return find(this.documents.get(documentId)!.tabs)!.text;
  }

  async getDocument(userId: string, documentId: string): Promise<docs_v1.Schema$Document> {
    const failure = this.getFailures.shift();
    if (failure) throw failure;
    const doc = this.access(userId, documentId);
    const toTab = (t: FakeTab, level: number, parent?: string, index = 0): docs_v1.Schema$Tab => ({
      tabProperties: {
        tabId: t.id,
        title: t.title,
        index,
        nestingLevel: level,
        ...(parent ? { parentTabId: parent } : {}),
      },
      documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: t.text } }] } }] } },
      childTabs: (t.children ?? []).map((c, i) => toTab(c, level + 1, t.id, i)),
    });
    return {
      documentId,
      title: doc.title,
      revisionId: `rev${doc.revision}`,
      tabs: doc.tabs.map((t, i) => toTab(t, 0, undefined, i)),
    };
  }

  private apply(documentId: string, requests: docs_v1.Schema$Request[]): void {
    const doc = this.documents.get(documentId)!;
    for (const r of requests) {
      const tabId = r.insertText?.endOfSegmentLocation?.tabId ?? doc.tabs[0]!.id;
      const find = (tabs: FakeTab[]): FakeTab | undefined => {
        for (const t of tabs) {
          if (t.id === tabId) return t;
          const c = find(t.children ?? []);
          if (c) return c;
        }
        return undefined;
      };
      const tab = find(doc.tabs)!;
      tab.text = tab.text.slice(0, -1) + (r.insertText?.text ?? '') + '\n';
    }
    doc.revision += 1;
  }

  async batchUpdate(
    userId: string,
    documentId: string,
    requests: docs_v1.Schema$Request[],
  ): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
    this.access(userId, documentId);
    const failure = this.updateFailures.shift();
    if (failure) {
      if (failure.applyFirst) this.apply(documentId, requests);
      throw failure.error;
    }
    this.updates.push({ documentId, requests });
    this.apply(documentId, requests);
    return {
      documentId,
      writeControl: { requiredRevisionId: `rev${this.documents.get(documentId)!.revision}` },
    };
  }
}

export interface Harness {
  client: Client;
  deps: ServerDeps;
  gmail: FakeGmail;
  docs: FakeDocs;
  audit: MemoryAuditSink;
  tokenStore: InMemoryTokenStore;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallResult>;
  close: () => Promise<void>;
}

export interface CallResult {
  isError?: boolean;
  structuredContent?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  content: { type: string; text?: string }[];
}

export interface HarnessOptions {
  env?: Record<string, string>;
  policy?: unknown;
  authorized?: boolean;
  mode?: TransportMode;
  clientCapabilities?: Record<string, unknown>;
  setupClient?: (client: Client) => void;
  /** Shared state store: harnesses given the same one behave like instances of one serverless deployment. */
  kv?: KvStore;
}

export function buildDeps(opts: HarnessOptions = {}) {
  const config = testConfig({ AUTO_DEDUPE_WINDOW_SECONDS: '60', ...(opts.env ?? {}) });
  const tokenStore = new InMemoryTokenStore();
  const logger = createLogger('silent');
  const policy = opts.policy ? mergePolicy(defaultPolicy(config), opts.policy) : defaultPolicy(config);
  const gmail = new FakeGmail();
  const docs = new FakeDocs();
  const audit = new MemoryAuditSink();
  const deps: ServerDeps = {
    config,
    mode: opts.mode ?? 'stdio',
    logger,
    auth: new GoogleAuthProvider(config.google, tokenStore, logger),
    oauthFlow: undefined,
    gmail,
    docs,
    idempotency: opts.kv ? new KvIdempotencyStore(opts.kv) : new InMemoryIdempotencyStore(),
    policy: new PolicyEngine(policy),
    confirmations: new ConfirmationService(
      policy.confirmation,
      Date.now,
      opts.kv ? new KvPendingStore(opts.kv, 'confirm') : undefined,
    ),
    audit,
    metrics: new Metrics(),
    now: () => new Date('2026-10-04T10:00:00Z'),
  };
  return { deps, tokenStore, gmail, docs, audit };
}

/** Connects a generic MCP client to a fresh server over an in-memory transport. */
export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const { deps, tokenStore, gmail, docs, audit } = buildDeps(opts);
  if (opts.authorized !== false) await tokenStore.saveToken(deps.config.defaultUserId, TEST_TOKEN);
  docs.addDocument(DOC_ID, 'Product Notes', [
    { id: 't.0', title: 'Notes', text: 'Existing paragraph.\n' },
    {
      id: 't.1',
      title: 'Archive',
      text: '\n',
      children: [{ id: 't.2', title: 'Old', text: 'Old notes.\n' }],
    },
  ]);

  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'generic-test-client', version: '1.0.0' },
    { capabilities: opts.clientCapabilities ?? {} },
  );
  opts.setupClient?.(client);
  await client.connect(clientTransport);

  const style = deps.config.toolNameStyle;
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({
      name: style === 'dotted' ? name : name.replace(/\./g, '_'),
      arguments: args,
    })) as unknown as CallResult;

  return {
    client,
    deps,
    gmail,
    docs,
    audit,
    tokenStore,
    call,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
