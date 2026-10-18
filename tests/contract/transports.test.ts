import { execSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer, sha256Hex } from '../../src/http/httpServer.js';
import { GoogleGmailApi } from '../../src/integrations/google/gmailClient.js';
import { buildDeps, DOC_ID, TEST_TOKEN, tempDir } from '../helpers.js';

const root = path.resolve(import.meta.dirname, '..', '..');

describe('stdio transport (built server, spawned like any MCP host would)', () => {
  beforeAll(() => {
    execSync('npm run build', { cwd: root, stdio: 'ignore' });
  }, 120_000);

  it('initializes, lists tools and returns structured results over stdio', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, 'dist', 'index.js')],
      // No Google configuration: the server must still start and be discoverable.
      env: {
        PATH: process.env.PATH ?? '',
        DATA_DIR: tempDir(),
        LOG_LEVEL: 'silent',
        ENV_FILE: '/nonexistent',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-contract-client', version: '1.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(4);
      const status = (await client.callTool({ name: 'connection_get_status', arguments: {} })) as {
        structuredContent: Record<string, unknown>;
      };
      expect(status.structuredContent).toMatchObject({
        success: true,
        google_oauth_configured: false,
        gmail_available: false,
        server: { transport: 'stdio' },
      });
      const send = (await client.callTool({
        name: 'gmail_send_email',
        arguments: { to: ['a@example.com'], subject: 's', body: 'b' },
      })) as { isError: boolean; structuredContent: Record<string, unknown> };
      expect(send.isError).toBe(true);
      expect(send.structuredContent).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe('Streamable HTTP transport with per-user bearer tokens', () => {
  const tokens = { alice: 'alice-token-0123456789', bob: 'bob-token-0123456789' };
  let baseUrl: string;
  let close: () => Promise<void>;
  let harness: ReturnType<typeof buildDeps>;

  beforeAll(async () => {
    harness = buildDeps({
      mode: 'http',
      env: { MCP_HTTP_TOKEN_HASHES: `alice:${sha256Hex(tokens.alice)},bob:${sha256Hex(tokens.bob)}` },
    });
    // Only alice has connected a Google account.
    await harness.tokenStore.saveToken('alice', TEST_TOKEN);
    harness.docs.addDocument(DOC_ID, 'Shared', [{ id: 't.0', title: 'Tab', text: '\n' }]);
    const server = createHttpServer(harness.deps);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });
  afterAll(async () => close?.());

  async function connect(token?: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    });
    const client = new Client({ name: 'http-contract-client', version: '1.0.0' });
    await client.connect(transport);
    return client;
  }

  it('rejects requests without a valid bearer token', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    await expect(connect('wrong-token')).rejects.toThrow();
  });

  it("maps each token to its own Google credentials; bob cannot use alice's grant", async () => {
    const alice = await connect(tokens.alice);
    const bob = await connect(tokens.bob);
    try {
      const a = (await alice.callTool({ name: 'connection_get_status', arguments: {} })) as {
        structuredContent: Record<string, unknown>;
      };
      expect(a.structuredContent).toMatchObject({
        authorized_user: 'owner@example.com',
        server: { transport: 'http' },
      });
      const b = (await bob.callTool({ name: 'connection_get_status', arguments: {} })) as {
        structuredContent: Record<string, unknown>;
      };
      expect(b.structuredContent).toMatchObject({ authorized_user: null, authorization_required: true });

      // With the real Gmail adapter, bob's send fails on his own (missing) credentials.
      harness.deps.gmail = new GoogleGmailApi(harness.deps.auth);
      const send = (await bob.callTool({
        name: 'gmail_send_email',
        arguments: { to: ['a@example.com'], subject: 's', body: 'b' },
      })) as { structuredContent: Record<string, unknown> };
      expect(send.structuredContent).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  it('acts on behalf of the authenticated user', async () => {
    const alice = await connect(tokens.alice);
    try {
      const r = (await alice.callTool({
        name: 'google_docs_append',
        arguments: { document_id: DOC_ID, content: 'From alice' },
      })) as { structuredContent: Record<string, unknown> };
      expect(r.structuredContent).toMatchObject({ success: true });
      expect(harness.audit.records.at(-1)).toMatchObject({
        user_id: 'alice',
        operation: 'google_docs.append',
      });
    } finally {
      await alice.close();
    }
  });

  it('serves health and authenticated metrics', async () => {
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(401);
    const metrics = await fetch(`${baseUrl}/metrics`, {
      headers: { Authorization: `Bearer ${tokens.alice}` },
    });
    expect(await metrics.text()).toContain('mcp_tool_calls_total');
  });
});
