import { createHash, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { localhostHostValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import type { ServerDeps } from '../server/deps.js';
import { createMcpServer } from '../server/mcpServer.js';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Verifies `Authorization: Bearer <token>` against the configured
 * userId -> sha256(token) map. Only hashes are held in configuration, and
 * comparison is constant-time. Returns the userId or undefined.
 */
export function verifyBearer(header: string | undefined, hashes: Map<string, string>): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!match) return undefined;
  const given = Buffer.from(sha256Hex(match[1]!), 'hex');
  let found: string | undefined;
  for (const [userId, hash] of hashes) {
    const expected = Buffer.from(hash, 'hex');
    if (expected.length === given.length && timingSafeEqual(expected, given)) found = userId;
  }
  return found;
}

/** Fixed-window per-user rate limiter. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limitPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}
  allow(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= 60_000) {
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= this.limitPerMinute;
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function sendHtml(res: ServerResponse, status: number, title: string, message: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`,
  );
}

/**
 * Remote mode (§23): Streamable HTTP at /mcp, protected by per-user bearer
 * tokens. Each token maps to exactly one userId, and that userId selects the
 * Google credentials, so one user's grant is never usable by another (§33).
 */
export function createHttpServer(deps: ServerDeps): http.Server {
  return http.createServer(createRequestHandler(deps));
}

/** The router behind createHttpServer, exposed for hosts that call a handler instead of listen() (Vercel). */
export function createRequestHandler(deps: ServerDeps): http.RequestListener {
  const { config, logger } = deps;
  const mcpHandler = createMcpHandler(() => createMcpServer(deps), {
    onerror: (err) => logger.warn('mcp http handler error', { error: err }),
  });
  const limiter = new RateLimiter(config.http.rateLimitPerMinute);
  const isLocalBind = ['127.0.0.1', 'localhost', '::1'].includes(config.http.host);
  const hostGuard = isLocalBind ? localhostHostValidation() : undefined;
  const originGuard =
    config.http.allowedOrigins.length > 0
      ? originValidation(config.http.allowedOrigins)
      : isLocalBind
        ? originValidation(['localhost', '127.0.0.1', '[::1]'])
        : undefined;

  const handleMcp = async (req: IncomingMessage, res: ServerResponse) => {
    if (hostGuard && !hostGuard(req, res)) return;
    if (originGuard && !originGuard(req, res)) return;
    const userId = verifyBearer(req.headers.authorization, config.http.tokenHashes);
    if (!userId) {
      sendJson(
        res,
        401,
        { error: 'unauthorized', message: 'A valid bearer token is required.' },
        { 'WWW-Authenticate': `Bearer realm="${config.serverName}"` },
      );
      return;
    }
    if (!limiter.allow(userId)) {
      sendJson(res, 429, { error: 'rate_limited', message: 'Too many requests.' }, { 'Retry-After': '60' });
      return;
    }
    const authInfo: AuthInfo = {
      token: sha256Hex(req.headers.authorization ?? ''), // never the raw token
      clientId: 'bearer-token',
      scopes: [],
      extra: { userId },
    };
    const node = toNodeHandler(
      { fetch: (request: Request) => mcpHandler.fetch(request, { authInfo }) },
      { maxRequestBodySize: 2 * 1024 * 1024 },
    );
    await node(req, res);
  };

  const handleCallback = async (url: URL, res: ServerResponse) => {
    if (!deps.oauthFlow)
      return sendHtml(res, 404, 'Not available', 'OAuth is not configured on this server.');
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (error || !code || !state) {
      return sendHtml(
        res,
        400,
        'Authorization not completed',
        'Google did not return an authorization code.',
      );
    }
    try {
      const { userId, email } = await deps.oauthFlow.complete(code, state);
      logger.info('google account authorized', { user_id: userId });
      sendHtml(
        res,
        200,
        'Google account connected',
        `Connected ${email ?? 'your Google account'}. You can close this window.`,
      );
    } catch (err) {
      logger.warn('oauth callback failed', { error: err });
      sendHtml(
        res,
        400,
        'Authorization failed',
        'The authorization link is invalid or expired. Request a new one.',
      );
    }
  };

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const done = (p: Promise<void> | void) =>
      Promise.resolve(p).catch((err) => {
        logger.error('http request failed', { path: url.pathname, error: err });
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      });

    if (url.pathname === '/mcp') return void done(handleMcp(req, res));
    if (url.pathname === '/oauth2/callback' && req.method === 'GET')
      return void done(handleCallback(url, res));
    if (url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
    if (url.pathname === '/metrics' && req.method === 'GET') {
      if (!verifyBearer(req.headers.authorization, config.http.tokenHashes)) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      return void res.end(deps.metrics.render());
    }
    sendJson(res, 404, { error: 'not_found' });
  };
}
