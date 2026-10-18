import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OAuthFlow, type PendingAuthorization } from '../../src/auth/oauth.js';
import { KvTokenStore } from '../../src/auth/tokenStore.js';
import { ConfigError } from '../../src/config/config.js';
import { sha256Hex } from '../../src/http/httpServer.js';
import type { GoogleAuthProvider } from '../../src/integrations/google/oauthClient.js';
import { KEY_PREFIX, MemoryKvStore } from '../../src/storage/kv.js';
import { KvPendingStore } from '../../src/storage/pendingStore.js';
import { createVercelEntry, createVercelHandler } from '../../src/vercel.js';
import { createHarness, DOC_ID, type Harness } from '../helpers.js';

/**
 * Serverless deployments run many instances that share nothing but the KV store. Each test uses
 * two instances over one store and checks that state created on one is honoured by the other.
 */

const email = { to: ['person@example.com'], subject: 'Meeting notes', body: 'Hi, sharing the notes.' };
const SECRET = 's'.repeat(40);
const KEY = 'k'.repeat(40);

let open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.map((h) => h.close()));
  open = [];
});

async function twoInstances(policy?: unknown): Promise<[Harness, Harness]> {
  const kv = new MemoryKvStore();
  const a = await createHarness({ kv, policy });
  const b = await createHarness({ kv, policy });
  open.push(a, b);
  return [a, b];
}

describe('confirmation tokens across instances', () => {
  it('accepts a token issued by another instance, exactly once', async () => {
    const [a, b] = await twoInstances({ gmail: { requireConfirmation: true } });
    const first = await a.call('gmail.send_email', email);
    expect(first.structuredContent).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
    const { confirmation_token } = first.structuredContent!.error.details;

    const ok = await b.call('gmail.send_email', { ...email, confirmation_token });
    expect(ok.isError).toBeFalsy();
    expect(b.gmail.sent).toHaveLength(1);

    const reused = await a.call('gmail.send_email', { ...email, confirmation_token });
    expect(reused.structuredContent).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(a.gmail.sent).toHaveLength(0);
  });
});

describe('duplicate protection across instances', () => {
  it('suppresses an identical send that lands on a different instance', async () => {
    const [a, b] = await twoInstances();
    expect((await a.call('gmail.send_email', email)).isError).toBeFalsy();
    const repeat = await b.call('gmail.send_email', email);
    expect(repeat.structuredContent).toMatchObject({ error: { code: 'DUPLICATE_REQUEST' } });
    expect(b.gmail.sent).toHaveLength(0);
  });

  it('replays an explicit idempotency key on another instance instead of appending twice', async () => {
    const [a, b] = await twoInstances();
    const args = { document_id: DOC_ID, content: 'Once', idempotency_key: 'append-key-0001' };
    await a.call('google_docs.append', args);
    const second = await b.call('google_docs.append', args);
    expect(second.structuredContent).toMatchObject({ idempotent_replay: true });
    expect(b.docs.tabText(DOC_ID, 't.0')).toBe('Existing paragraph.\n');
  });
});

describe('OAuth state across instances', () => {
  function fakeProvider(): GoogleAuthProvider {
    const client = {
      redirectUri: 'https://gwmcp.vercel.app/oauth2/callback',
      generateCodeVerifierAsync: async () => ({ codeVerifier: 'verifier', codeChallenge: 'challenge' }),
      generateAuthUrl: (o: { state: string }) => `https://accounts.google.com/o/oauth2/auth?state=${o.state}`,
      getToken: async ({ code, codeVerifier }: { code: string; codeVerifier: string }) => ({
        tokens: { refresh_token: `refresh-${code}-${codeVerifier}` },
      }),
    };
    return { scopes: ['openid'], createClient: () => client } as unknown as GoogleAuthProvider;
  }

  it('lets any instance complete an authorization another instance started, once', async () => {
    const kv = new MemoryKvStore();
    const flow = (secret: string) =>
      new OAuthFlow(
        fakeProvider(),
        new KvTokenStore(kv, KEY),
        secret,
        Date.now,
        new KvPendingStore(kv, 'oauth'),
      );

    const { url } = await flow(SECRET).start('alice');
    const state = new URL(url).searchParams.get('state')!;

    await expect(flow(SECRET).complete('code1', state)).resolves.toMatchObject({ userId: 'alice' });
    expect(await new KvTokenStore(kv, KEY).getToken('alice')).toMatchObject({
      refresh_token: 'refresh-code1-verifier',
    });
    await expect(flow(SECRET).complete('code1', state)).rejects.toThrow(/expired or already used/);
  });

  it('rejects state signed with a different secret (why OAUTH_STATE_SECRET must be shared)', async () => {
    const kv = new MemoryKvStore();
    const pending = new KvPendingStore<PendingAuthorization>(kv, 'oauth');
    const tokens = new KvTokenStore(kv, KEY);
    const { url } = await new OAuthFlow(fakeProvider(), tokens, SECRET, Date.now, pending).start('alice');
    const state = new URL(url).searchParams.get('state')!;
    await expect(
      new OAuthFlow(fakeProvider(), tokens, 'o'.repeat(40), Date.now, pending).complete('c', state),
    ).rejects.toThrow(/Invalid OAuth state/);
  });
});

describe('Vercel handler', () => {
  const token = 'vercel-token-0123456789';
  const env = {
    MCP_HTTP_TOKEN_HASHES: `alice:${sha256Hex(token)}`,
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    TOKEN_STORE_ENCRYPTION_KEY: KEY,
    OAUTH_STATE_SECRET: SECRET,
    VERCEL_PROJECT_PRODUCTION_URL: 'gwmcp.vercel.app',
    LOG_LEVEL: 'silent',
  };

  it('refuses to start without shared state, bearer tokens or a shared OAuth state secret', () => {
    const kv = new MemoryKvStore();
    expect(() => createVercelHandler(env, undefined)).toThrow(/Upstash Redis/);
    expect(() => createVercelHandler({ ...env, MCP_HTTP_TOKEN_HASHES: '' }, kv)).toThrow(
      /MCP_HTTP_TOKEN_HASHES/,
    );
    expect(() => createVercelHandler({ ...env, OAUTH_STATE_SECRET: undefined }, kv)).toThrow(
      /OAUTH_STATE_SECRET/,
    );
    expect(() => createVercelHandler({ ...env, OAUTH_STATE_SECRET: undefined }, kv)).toThrow(ConfigError);
  });

  it('answers every route with the configuration problems instead of crashing at startup', async () => {
    const server = http.createServer(
      createVercelEntry({ ...env, OAUTH_STATE_SECRET: '' }, new MemoryKvStore()),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { problems: string[] };
      expect(body).toMatchObject({ status: 'misconfigured', error: 'startup_failed' });
      expect(body.problems.join(' ')).toMatch(/OAUTH_STATE_SECRET/);
      expect(JSON.stringify(body)).not.toContain(KEY); // never echoes configured values
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  describe('served over HTTP', () => {
    const kv = new MemoryKvStore();
    const servers: http.Server[] = [];
    const urls: string[] = [];

    beforeAll(async () => {
      for (let i = 0; i < 2; i++) {
        const server = http.createServer(createVercelHandler(env, kv));
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        servers.push(server);
        urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      }
    });
    afterAll(async () => {
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    });

    function request(
      base: string,
      path: string,
      init: { method?: string; headers?: Record<string, string>; body?: string } = {},
    ) {
      return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          new URL(path, base),
          { method: init.method ?? 'GET', headers: init.headers },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end(init.body);
      });
    }

    it('serves /healthz and requires a bearer token on /mcp', async () => {
      expect(await request(urls[0]!, '/healthz')).toEqual({ status: 200, body: '{"status":"ok"}' });
      expect((await request(urls[0]!, '/mcp', { method: 'POST', body: '{}' })).status).toBe(401);
    });

    it('accepts requests addressed to the deployment domain (no localhost Host check)', async () => {
      const res = await request(urls[0]!, '/mcp', {
        method: 'POST',
        headers: {
          Host: 'gwmcp.vercel.app',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 't', version: '1' },
          },
        }),
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('google-workspace-mcp');
    });

    it('issues authorization links for the production domain and keeps their state in the shared store', async () => {
      const client = new Client({ name: 'vercel-test', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${urls[0]}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      try {
        const status = (await client.callTool({ name: 'connection_get_status', arguments: {} })) as {
          structuredContent: { authorization_url: string };
        };
        const link = new URL(status.structuredContent.authorization_url);
        expect(link.searchParams.get('redirect_uri')).toBe('https://gwmcp.vercel.app/oauth2/callback');
        const nonce = link.searchParams.get('state')!.split('.')[0]!;
        expect(await kv.get(`${KEY_PREFIX}oauth:${nonce}`)).not.toBeNull();
      } finally {
        await client.close();
      }
    });
  });
});
