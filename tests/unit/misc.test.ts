import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/errors/appError.js';
import { RateLimiter, verifyBearer, sha256Hex } from '../../src/http/httpServer.js';
import { Metrics } from '../../src/observability/metrics.js';
import { defaultPolicy, mergePolicy, PolicyEngine } from '../../src/policy/policy.js';
import { resolveUserContext } from '../../src/auth/userContext.js';
import { createLogger, redactEmail } from '../../src/utils/logging.js';
import { withRetry } from '../../src/utils/retry.js';
import { testConfig, DOC_ID } from '../helpers.js';

describe('withRetry', () => {
  const noSleep = { sleep: async () => {}, random: () => 0.5 };

  it('retries retryable errors with bounded attempts', async () => {
    const fn = vi.fn(async () => {
      throw new AppError('GOOGLE_API_ERROR', 'down', { retryable: true });
    });
    await expect(withRetry(fn, { ...noSleep, maxAttempts: 3 })).rejects.toMatchObject({
      code: 'GOOGLE_API_ERROR',
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn(async () => {
      throw new AppError('DOCUMENT_NOT_FOUND', 'nope');
    });
    await expect(withRetry(fn, noSleep)).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff with jitter and honours Retry-After', async () => {
    const delays: number[] = [];
    let n = 0;
    await withRetry(
      async () => {
        n++;
        if (n === 1) throw new AppError('NETWORK_ERROR', 'x');
        if (n === 2) throw new AppError('NETWORK_ERROR', 'x');
        if (n === 3) throw new AppError('RATE_LIMITED', 'x', { retryAfterSeconds: 2 });
        return 'ok';
      },
      { ...noSleep, maxAttempts: 4, baseDelayMs: 100, onRetry: (_e, _a, d) => delays.push(d) },
    );
    expect(delays).toEqual([50, 100, 2000]);
  });
});

describe('PolicyEngine', () => {
  const config = testConfig();

  it('enforces recipient limits and domain allow/block lists', () => {
    const engine = new PolicyEngine(
      mergePolicy(defaultPolicy(config), {
        gmail: {
          maxRecipients: 2,
          allowedRecipientDomains: ['example.com'],
          blockedRecipientDomains: ['blocked.example.com'],
        },
      }),
    );
    expect(() => engine.checkGmailSend(['a@example.com', 'b@sub.example.com'], 10)).not.toThrow();
    expect(() => engine.checkGmailSend(['a@example.com', 'b@example.com', 'c@example.com'], 10)).toThrowError(
      expect.objectContaining({ code: 'POLICY_BLOCKED' }),
    );
    expect(() => engine.checkGmailSend(['a@other.org'], 10)).toThrowError(
      expect.objectContaining({ code: 'POLICY_BLOCKED', details: { blocked_domains: ['other.org'] } }),
    );
    expect(() => engine.checkGmailSend(['x@blocked.example.com'], 10)).toThrowError(
      expect.objectContaining({ code: 'POLICY_BLOCKED' }),
    );
  });

  it('enforces an exact recipient allowlist without echoing addresses', () => {
    const engine = new PolicyEngine(
      mergePolicy(defaultPolicy(config), { gmail: { allowedRecipients: ['Owner@Example.com'] } }),
    );
    expect(() => engine.checkGmailSend(['owner@example.com'], 10)).not.toThrow();
    expect(() => engine.checkGmailSend(['OWNER@example.com'], 10)).not.toThrow();
    expect(() => engine.checkGmailSend(['someone@example.com'], 10)).toThrowError(
      expect.objectContaining({ code: 'POLICY_BLOCKED', details: { blocked_recipient_count: 1 } }),
    );
    expect(() => engine.checkGmailSend(['owner@example.com', 'x@other.org'], 10)).toThrowError(
      expect.objectContaining({ code: 'POLICY_BLOCKED' }),
    );
    // Same domain is not enough when an address allowlist is set.
    expect(() => engine.checkGmailSend(['owner2@example.com'], 10)).toThrowError(
      expect.objectContaining({ code: 'POLICY_BLOCKED' }),
    );
  });

  it('loads the deployed policy.json with the recipient allowlist', async () => {
    const { readFileSync } = await import('node:fs');
    const deployed = JSON.parse(readFileSync('policy.json', 'utf8')) as unknown;
    const engine = new PolicyEngine(mergePolicy(defaultPolicy(config), deployed));
    expect(engine.policy.gmail.allowedRecipients).toEqual(['vaishu1996@gmail.com']);
    expect(() => engine.checkGmailSend(['vaishu1996@gmail.com'], 10)).not.toThrow();
    expect(() => engine.checkGmailSend(['anyone.else@gmail.com'], 10)).toThrowError(
      expect.objectContaining({ code: 'POLICY_BLOCKED' }),
    );
    expect(engine.policy.gmail.requireConfirmation).toBe(true);
  });

  it('enforces document allowlists, size limits and kill switches', () => {
    const engine = new PolicyEngine(
      mergePolicy(defaultPolicy(config), { googleDocs: { allowedDocumentIds: [DOC_ID], maxAppendBytes: 5 } }),
    );
    expect(() => engine.checkDocsAppend(DOC_ID, 5)).not.toThrow();
    expect(() => engine.checkDocsAppend(DOC_ID, 6)).toThrowError(
      expect.objectContaining({ code: 'POLICY_BLOCKED' }),
    );
    expect(() => engine.checkDocsAppend('other-document-id-000000', 1)).toThrowError(
      expect.objectContaining({ code: 'POLICY_BLOCKED' }),
    );
    const off = new PolicyEngine(mergePolicy(defaultPolicy(config), { gmail: { send: false } }));
    expect(() => off.checkGmailSend(['a@example.com'], 1)).toThrowError(
      expect.objectContaining({ code: 'POLICY_BLOCKED' }),
    );
  });

  it('rejects unknown policy keys', () => {
    expect(() => mergePolicy(defaultPolicy(config), { gmail: { sendd: true } })).toThrow(/Invalid policy/);
  });
});

describe('resolveUserContext', () => {
  it('uses the configured user for stdio', () => {
    expect(resolveUserContext('stdio', 'default', undefined).userId).toBe('default');
  });
  it('requires a server-verified user in http mode', () => {
    expect(() => resolveUserContext('http', 'default', undefined)).toThrowError(
      expect.objectContaining({ code: 'AUTHENTICATION_REQUIRED' }),
    );
    expect(
      resolveUserContext('http', 'default', {
        token: 't',
        clientId: 'c',
        scopes: [],
        extra: { userId: 'alice' },
      }).userId,
    ).toBe('alice');
  });
});

describe('http auth helpers', () => {
  it('verifies bearer tokens against hashes only', () => {
    const hashes = new Map([
      ['alice', sha256Hex('alice-token')],
      ['bob', sha256Hex('bob-token')],
    ]);
    expect(verifyBearer('Bearer alice-token', hashes)).toBe('alice');
    expect(verifyBearer('bearer bob-token', hashes)).toBe('bob');
    expect(verifyBearer('Bearer wrong', hashes)).toBeUndefined();
    expect(verifyBearer(undefined, hashes)).toBeUndefined();
    expect(verifyBearer('Basic alice-token', hashes)).toBeUndefined();
  });

  it('rate limits per key per minute', () => {
    let now = 0;
    const rl = new RateLimiter(2, () => now);
    expect([rl.allow('a'), rl.allow('a'), rl.allow('a'), rl.allow('b')]).toEqual([true, true, false, true]);
    now = 60_000;
    expect(rl.allow('a')).toBe(true);
  });
});

describe('logging', () => {
  it('redacts credentials and content fields', () => {
    const lines: string[] = [];
    const log = createLogger('debug', {}, (l) => lines.push(l));
    log.info('x', {
      access_token: 'ya29.SECRET',
      refresh_token: 'SECRET',
      client_secret: 'SECRET',
      body: 'private email body',
      content: 'private doc content',
      nested: { Authorization: 'Bearer SECRET' },
      tool: 'gmail.send_email',
    });
    expect(lines[0]).not.toContain('SECRET');
    expect(lines[0]).not.toContain('private');
    expect(JSON.parse(lines[0]!)).toMatchObject({ tool: 'gmail.send_email', level: 'info' });
  });

  it('respects the log level', () => {
    const lines: string[] = [];
    const log = createLogger('warn', {}, (l) => lines.push(l));
    log.info('hidden');
    log.warn('shown');
    expect(lines).toHaveLength(1);
  });

  it('hashes or masks recipient addresses', () => {
    expect(redactEmail('Priya@Example.com', 'hash')).toMatch(/^sha256:[a-f0-9]{12}@Example\.com$/);
    expect(redactEmail('priya@example.com', 'mask')).toBe('p***@example.com');
    expect(redactEmail('priya@example.com', 'plain')).toBe('priya@example.com');
  });
});

describe('Metrics', () => {
  it('renders Prometheus text', async () => {
    const m = new Metrics();
    m.inc('mcp_tool_calls_total', { tool: 'gmail.send_email', status: 'success' });
    m.inc('mcp_tool_calls_total', { tool: 'gmail.send_email', status: 'success' });
    m.observe('google_api_latency_ms', 10, { service: 'gmail' });
    const out = m.render();
    expect(out).toContain('# TYPE mcp_tool_calls_total counter');
    expect(out).toContain('mcp_tool_calls_total{status="success",tool="gmail.send_email"} 2');
    expect(out).toContain('google_api_latency_ms_count{service="gmail"} 1');
  });
});
