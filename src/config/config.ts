import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';
/** `openid email` lets the server display which Google account is authorized; no mailbox/Drive access. */
export const IDENTITY_SCOPES = ['openid', 'email'];
export const DEFAULT_SCOPES = [GMAIL_SEND_SCOPE, DOCS_SCOPE, ...IDENTITY_SCOPES];

/** Scopes the MVP is allowed to request without ALLOW_BROAD_SCOPES=true (§13). */
const MVP_ALLOWED_SCOPES = new Set([...DEFAULT_SCOPES, 'https://www.googleapis.com/auth/userinfo.email']);

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const positiveInt = z.coerce.number().int().positive();

const envSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: z.url().optional(),
  GOOGLE_OAUTH_SCOPES: z.string().optional(),
  ALLOW_BROAD_SCOPES: bool.default(false),

  TOKEN_STORE_ENCRYPTION_KEY: z.string().optional(),
  DATA_DIR: z.string().optional(),

  MCP_SERVER_NAME: z.string().min(1).default('google-workspace-mcp'),
  MCP_SERVER_VERSION: z.string().min(1).default('1.0.0'),
  TOOL_NAME_STYLE: z.enum(['underscore', 'dotted']).default('underscore'),
  DEFAULT_USER_ID: z.string().min(1).default('default'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  LOG_RECIPIENTS: z.enum(['hash', 'mask', 'plain']).default('hash'),

  MAX_EMAIL_RECIPIENTS: positiveInt.default(20),
  MAX_EMAIL_BODY_BYTES: positiveInt.default(1_000_000),
  MAX_EMAIL_SUBJECT_CHARS: positiveInt.default(500),
  MAX_DOC_APPEND_BYTES: positiveInt.default(1_000_000),
  IDEMPOTENCY_TTL_SECONDS: positiveInt.default(86_400),
  AUTO_DEDUPE_WINDOW_SECONDS: z.coerce.number().int().min(0).default(60),
  TIMESTAMP_TIMEZONE: z.string().default('UTC'),

  POLICY_FILE: z.string().optional(),

  MCP_HTTP_HOST: z.string().default('127.0.0.1'),
  MCP_HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  MCP_PUBLIC_BASE_URL: z.url().optional(),
  MCP_HTTP_TOKEN_HASHES: z.string().optional(),
  MCP_HTTP_ALLOWED_ORIGINS: z.string().optional(),
  MCP_HTTP_RATE_LIMIT_PER_MINUTE: positiveInt.default(60),
  OAUTH_STATE_SECRET: z.string().optional(),
});

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface HttpConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  /** userId -> sha256(token) hex */
  tokenHashes: Map<string, string>;
  allowedOrigins: string[];
  rateLimitPerMinute: number;
  oauthStateSecret: string | undefined;
}

export interface Config {
  serverName: string;
  serverVersion: string;
  toolNameStyle: 'underscore' | 'dotted';
  defaultUserId: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  logRecipients: 'hash' | 'mask' | 'plain';
  google: GoogleOAuthConfig | undefined;
  tokenStoreKey: string | undefined;
  dataDir: string;
  limits: {
    maxEmailRecipients: number;
    maxEmailBodyBytes: number;
    maxEmailSubjectChars: number;
    maxDocAppendBytes: number;
  };
  idempotencyTtlSeconds: number;
  autoDedupeWindowSeconds: number;
  timestampTimezone: string;
  policyFile: string | undefined;
  http: HttpConfig;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const DEFAULT_CLI_REDIRECT = 'http://127.0.0.1:53682/oauth2callback';

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseTokenHashes(raw: string | undefined, issues: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of splitList(raw)) {
    const idx = entry.lastIndexOf(':');
    const userId = entry.slice(0, idx);
    const hash = entry.slice(idx + 1).toLowerCase();
    if (idx <= 0 || !/^[a-f0-9]{64}$/.test(hash)) {
      // Never echo the entry itself: it may be a raw token pasted by mistake.
      issues.push('MCP_HTTP_TOKEN_HASHES entries must be "<userId>:<sha256-hex>"');
      continue;
    }
    map.set(userId, hash);
  }
  return map;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads and validates configuration from environment variables.
 * Error messages name the offending variable but never include its value.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings (common in copied .env.example files) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  const issues: string[] = [];

  let google: GoogleOAuthConfig | undefined;
  if (e.GOOGLE_CLIENT_ID || e.GOOGLE_CLIENT_SECRET) {
    if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) {
      issues.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together');
    } else {
      const scopes = e.GOOGLE_OAUTH_SCOPES ? splitList(e.GOOGLE_OAUTH_SCOPES) : DEFAULT_SCOPES;
      const broad = scopes.filter((s) => !MVP_ALLOWED_SCOPES.has(s));
      if (broad.length > 0 && !e.ALLOW_BROAD_SCOPES) {
        issues.push(
          `GOOGLE_OAUTH_SCOPES contains scopes outside the MVP set (${broad.join(', ')}); ` +
            'set ALLOW_BROAD_SCOPES=true only if a feature genuinely requires them',
        );
      }
      google = {
        clientId: e.GOOGLE_CLIENT_ID,
        clientSecret: e.GOOGLE_CLIENT_SECRET,
        redirectUri: e.GOOGLE_REDIRECT_URI ?? DEFAULT_CLI_REDIRECT,
        scopes,
      };
    }
  }

  if (google && !e.TOKEN_STORE_ENCRYPTION_KEY) {
    issues.push('TOKEN_STORE_ENCRYPTION_KEY is required when Google OAuth is configured');
  }
  if (e.TOKEN_STORE_ENCRYPTION_KEY && e.TOKEN_STORE_ENCRYPTION_KEY.length < 32) {
    issues.push('TOKEN_STORE_ENCRYPTION_KEY must be at least 32 characters (e.g. `openssl rand -base64 32`)');
  }
  if (!isValidTimeZone(e.TIMESTAMP_TIMEZONE)) {
    issues.push('TIMESTAMP_TIMEZONE must be a valid IANA time zone (e.g. UTC, Asia/Kolkata)');
  }
  if (e.OAUTH_STATE_SECRET && e.OAUTH_STATE_SECRET.length < 32) {
    issues.push('OAUTH_STATE_SECRET must be at least 32 characters');
  }

  const tokenHashes = parseTokenHashes(e.MCP_HTTP_TOKEN_HASHES, issues);

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    serverName: e.MCP_SERVER_NAME,
    serverVersion: e.MCP_SERVER_VERSION,
    toolNameStyle: e.TOOL_NAME_STYLE,
    defaultUserId: e.DEFAULT_USER_ID,
    logLevel: e.LOG_LEVEL,
    logRecipients: e.LOG_RECIPIENTS,
    google,
    tokenStoreKey: e.TOKEN_STORE_ENCRYPTION_KEY,
    dataDir: path.resolve(e.DATA_DIR ?? path.join(os.homedir(), '.config', 'google-workspace-mcp')),
    limits: {
      maxEmailRecipients: e.MAX_EMAIL_RECIPIENTS,
      maxEmailBodyBytes: e.MAX_EMAIL_BODY_BYTES,
      maxEmailSubjectChars: e.MAX_EMAIL_SUBJECT_CHARS,
      maxDocAppendBytes: e.MAX_DOC_APPEND_BYTES,
    },
    idempotencyTtlSeconds: e.IDEMPOTENCY_TTL_SECONDS,
    autoDedupeWindowSeconds: e.AUTO_DEDUPE_WINDOW_SECONDS,
    timestampTimezone: e.TIMESTAMP_TIMEZONE,
    policyFile: e.POLICY_FILE,
    http: {
      host: e.MCP_HTTP_HOST,
      port: e.MCP_HTTP_PORT,
      publicBaseUrl: (e.MCP_PUBLIC_BASE_URL ?? `http://${e.MCP_HTTP_HOST}:${e.MCP_HTTP_PORT}`).replace(
        /\/$/,
        '',
      ),
      tokenHashes,
      allowedOrigins: splitList(e.MCP_HTTP_ALLOWED_ORIGINS),
      rateLimitPerMinute: e.MCP_HTTP_RATE_LIMIT_PER_MINUTE,
      oauthStateSecret: e.OAUTH_STATE_SECRET,
    },
  };
}
