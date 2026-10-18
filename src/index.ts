#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig } from './config/config.js';
import { createDeps } from './container.js';
import { createHttpServer } from './http/httpServer.js';
import { createMcpServer } from './server/mcpServer.js';
import { loadEnvFile } from './utils/env.js';
import { createLogger } from './utils/logging.js';

function parseTransport(argv: string[]): 'stdio' | 'http' {
  const flag = argv.find((a) => a.startsWith('--transport'));
  const value = flag?.includes('=')
    ? flag.split('=')[1]
    : flag
      ? argv[argv.indexOf(flag) + 1]
      : process.env.MCP_TRANSPORT;
  if (!value || value === 'stdio') return 'stdio';
  if (value === 'http') return 'http';
  throw new ConfigError([`Unknown transport "${value}" (expected "stdio" or "http")`]);
}

async function main(): Promise<void> {
  loadEnvFile();
  const transport = parseTransport(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { service: config.serverName });
  const deps = createDeps(config, transport, logger);

  if (!config.google)
    logger.warn('Google OAuth is not configured; tools will report AUTHENTICATION_REQUIRED');

  if (transport === 'stdio') {
    const handle = serveStdio(() => createMcpServer(deps), {
      onerror: (err) => logger.warn('stdio transport error', { error: err }),
    });
    logger.info('MCP server listening on stdio', { version: config.serverVersion });
    const shutdown = () => {
      void Promise.resolve((handle as { close?: () => Promise<void> }).close?.()).finally(() =>
        process.exit(0),
      );
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  if (config.http.tokenHashes.size === 0) {
    throw new ConfigError([
      'HTTP mode requires MCP_HTTP_TOKEN_HASHES (generate entries with `npm run hash-token -- <userId>`)',
    ]);
  }
  const server = createHttpServer(deps);
  server.listen(config.http.port, config.http.host, () => {
    logger.info('MCP server listening on Streamable HTTP', {
      url: `${config.http.publicBaseUrl}/mcp`,
      users: config.http.tokenHashes.size,
    });
    if (
      !config.http.publicBaseUrl.startsWith('https://') &&
      !['127.0.0.1', 'localhost', '::1'].includes(config.http.host)
    ) {
      logger.warn(
        'serving on a non-local interface without an https MCP_PUBLIC_BASE_URL; terminate TLS in front of this server',
      );
    }
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // stderr only: stdout belongs to the MCP protocol.
  console.error(err instanceof ConfigError ? err.message : `Fatal: ${(err as Error).message}`);
  process.exit(1);
});
