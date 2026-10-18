import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_SCOPES, loadConfig } from '../../src/config/config.js';

const google = {
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'super-secret-value',
  TOKEN_STORE_ENCRYPTION_KEY: 'k'.repeat(32),
};

describe('loadConfig', () => {
  it('starts without Google configuration (discoverable, reports not configured)', () => {
    const c = loadConfig({});
    expect(c.google).toBeUndefined();
    expect(c.toolNameStyle).toBe('underscore');
    expect(c.limits.maxEmailRecipients).toBe(20);
    expect(c.idempotencyTtlSeconds).toBe(86_400);
  });

  it('uses the narrow MVP scopes by default', () => {
    expect(loadConfig(google).google?.scopes).toEqual(DEFAULT_SCOPES);
    expect(DEFAULT_SCOPES).not.toContain('https://mail.google.com/');
  });

  it('rejects broad scopes unless explicitly allowed', () => {
    const env = { ...google, GOOGLE_OAUTH_SCOPES: 'https://mail.google.com/' };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(loadConfig({ ...env, ALLOW_BROAD_SCOPES: 'true' }).google?.scopes).toEqual([
      'https://mail.google.com/',
    ]);
  });

  it('requires client id and secret together, and an encryption key', () => {
    expect(() => loadConfig({ GOOGLE_CLIENT_ID: 'id' })).toThrow(/must be set together/);
    expect(() => loadConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' })).toThrow(
      /TOKEN_STORE_ENCRYPTION_KEY/,
    );
    expect(() => loadConfig({ ...google, TOKEN_STORE_ENCRYPTION_KEY: 'short' })).toThrow(/at least 32/);
  });

  it('never includes secret values in error messages', () => {
    try {
      loadConfig({ ...google, TOKEN_STORE_ENCRYPTION_KEY: 'tooshort-secret', MAX_EMAIL_RECIPIENTS: 'abc' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret-value');
      expect((err as Error).message).not.toContain('tooshort-secret');
    }
  });

  it('validates numbers, time zones and token hash entries', () => {
    expect(() => loadConfig({ MAX_EMAIL_RECIPIENTS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ TIMESTAMP_TIMEZONE: 'Mars/Base' })).toThrow(/TIMESTAMP_TIMEZONE/);
    expect(() => loadConfig({ MCP_HTTP_TOKEN_HASHES: 'alice:raw-token' })).toThrow(/sha256/);
    const hash = 'a'.repeat(64);
    expect(
      loadConfig({ MCP_HTTP_TOKEN_HASHES: `alice:${hash}, bob:${'b'.repeat(64)}` }).http.tokenHashes.get(
        'alice',
      ),
    ).toBe(hash);
  });

  it('treats empty strings as unset', () => {
    expect(
      loadConfig({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', LOG_LEVEL: '' }).google,
    ).toBeUndefined();
  });
});
