/**
 * Live Google integration tests (§29.2). Skipped unless RUN_INTEGRATION=1.
 *
 * Prerequisites (use a dedicated test Google account, never a personal one):
 *   - .env configured and `npm run build && npm run auth` completed for DEFAULT_USER_ID
 *   - INTEGRATION_TEST_RECIPIENT   address that receives the test email (e.g. the test account itself)
 *   - INTEGRATION_TEST_DOC_ID      a test document the account can edit
 *   - INTEGRATION_FORBIDDEN_DOC_ID (optional) a document the account cannot access
 *
 *   npm run test:integration
 */
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { createDeps } from '../../src/container.js';
import { createMcpServer } from '../../src/server/mcpServer.js';
import type { ServerDeps } from '../../src/server/deps.js';
import { loadEnvFile } from '../../src/utils/env.js';
import { createLogger } from '../../src/utils/logging.js';

const enabled = process.env.RUN_INTEGRATION === '1';

describe.skipIf(!enabled)('Google integration', () => {
  let client: Client;
  let deps: ServerDeps;
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name: name.replace(/\./g, '_'), arguments: args })) as {
      isError?: boolean;
      structuredContent: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    };

  beforeAll(async () => {
    loadEnvFile();
    const config = { ...loadConfig(), toolNameStyle: 'underscore' as const };
    deps = createDeps(config, 'stdio', createLogger('warn'));
    const server = createMcpServer(deps);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: 'integration-client', version: '1.0.0' });
    await client.connect(ct);
  });

  it('1. reports an authorized account', async () => {
    const r = await call('connection.get_status');
    expect(r.structuredContent).toMatchObject({ gmail_available: true, google_docs_available: true });
  });

  it('2. sends an email', async () => {
    const r = await call('gmail.send_email', {
      to: [process.env.INTEGRATION_TEST_RECIPIENT],
      subject: `MCP integration test ${new Date().toISOString()}`,
      body: 'Sent by the google-workspace-mcp integration test suite.',
      idempotency_key: randomUUID(),
    });
    expect(r.structuredContent).toMatchObject({ success: true });
    expect(r.structuredContent.message_id).toBeTruthy();
  });

  it('3. fetches document metadata', async () => {
    const r = await call('google_docs.get_metadata', { document_id: process.env.INTEGRATION_TEST_DOC_ID });
    expect(r.structuredContent).toMatchObject({ success: true });
    expect(r.structuredContent.tabs.length).toBeGreaterThan(0);
  });

  it('4. appends to the end of the document', async () => {
    const marker = `integration-${randomUUID()}`;
    const r = await call('google_docs.append', {
      document_id: process.env.INTEGRATION_TEST_DOC_ID,
      heading: 'Integration test',
      content: marker,
      timestamp: true,
    });
    expect(r.structuredContent).toMatchObject({ success: true });
    const doc = await deps.docs.getDocument(deps.config.defaultUserId, process.env.INTEGRATION_TEST_DOC_ID!);
    const firstTab = doc.tabs?.[0]?.documentTab?.body?.content ?? [];
    const text = firstTab
      .flatMap((e) => e.paragraph?.elements ?? [])
      .map((pe) => pe.textRun?.content ?? '')
      .join('');
    expect(text.trimEnd().endsWith(marker)).toBe(true);
  });

  it('5. refreshes an expired access token transparently', async () => {
    const userId = deps.config.defaultUserId;
    const store = (deps.auth as unknown as { tokenStore: import('../../src/auth/tokenStore.js').TokenStore })
      .tokenStore;
    const token = (await store.getToken(userId))!;
    await store.saveToken(userId, { ...token, access_token: 'expired', expiry_date: Date.now() - 60_000 });
    const r = await call('google_docs.get_metadata', { document_id: process.env.INTEGRATION_TEST_DOC_ID });
    expect(r.structuredContent).toMatchObject({ success: true });
    await new Promise((res) => setTimeout(res, 200)); // refreshed token is persisted asynchronously
    expect((await store.getToken(userId))!.access_token).not.toBe('expired');
  });

  it('7. denies access to an unauthorized document', async () => {
    if (!process.env.INTEGRATION_FORBIDDEN_DOC_ID) return;
    const r = await call('google_docs.get_metadata', {
      document_id: process.env.INTEGRATION_FORBIDDEN_DOC_ID,
    });
    expect(['DOCUMENT_ACCESS_DENIED', 'DOCUMENT_NOT_FOUND']).toContain(r.structuredContent.error.code);
  });

  it('8. rejects an invalid document ID', async () => {
    const r = await call('google_docs.get_metadata', {
      document_id: '1ThisDocumentDoesNotExist000000000000',
    });
    expect(['DOCUMENT_NOT_FOUND', 'INVALID_DOCUMENT', 'DOCUMENT_ACCESS_DENIED']).toContain(
      r.structuredContent.error.code,
    );
  });
});
