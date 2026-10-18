import { existsSync } from 'node:fs';
import type { RequestListener } from 'node:http';
import path from 'node:path';
import { ConfigError, loadConfig } from './config/config.js';
import { createDeps } from './container.js';
import { createRequestHandler } from './http/httpServer.js';
import { createKvFromEnv, type KvStore } from './storage/kv.js';
import { createLogger } from './utils/logging.js';

const BUNDLED_POLICY = path.resolve('policy.json');

/**
 * Vercel Function entry (see api/index.js). Instances are short-lived and share nothing, so every
 * piece of state must live in the shared KV store; a misconfigured deployment fails at cold start
 * instead of silently losing tokens, confirmations or duplicate protection.
 */
export function createVercelHandler(
  env: NodeJS.ProcessEnv = process.env,
  kv: KvStore | undefined = createKvFromEnv(env),
): RequestListener {
  const set = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const productionHost = set.VERCEL_PROJECT_PRODUCTION_URL;
  const config = loadConfig({
    // Nothing calls listen() on Vercel. A non-local host turns off the localhost-only Host check,
    // which would otherwise reject every request addressed to the deployment's domain.
    MCP_HTTP_HOST: '0.0.0.0',
    // The only writable path; nothing important is written there once the KV stores are wired.
    DATA_DIR: '/tmp/google-workspace-mcp',
    // policy.json is bundled into the function by vercel.json (includeFiles).
    ...(existsSync(BUNDLED_POLICY) ? { POLICY_FILE: BUNDLED_POLICY } : {}),
    ...(productionHost ? { MCP_PUBLIC_BASE_URL: `https://${productionHost}` } : {}),
    ...set,
  });

  const issues: string[] = [];
  if (!kv) {
    issues.push(
      'Vercel deployments need Upstash Redis: set KV_REST_API_URL and KV_REST_API_TOKEN ' +
        '(or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)',
    );
  }
  if (config.http.tokenHashes.size === 0) {
    issues.push('MCP_HTTP_TOKEN_HASHES is required (generate entries with `npm run hash-token -- <userId>`)');
  }
  if (config.google && !config.http.oauthStateSecret) {
    issues.push('OAUTH_STATE_SECRET is required on Vercel: every instance must verify the same OAuth state');
  }
  if (issues.length > 0) throw new ConfigError(issues);

  const logger = createLogger(config.logLevel, { service: config.serverName });
  return createRequestHandler(createDeps(config, 'http', logger, kv));
}

/**
 * Entry used by api/index.js. A startup failure is logged and then answered on every route with
 * 503 and the list of problems, instead of crashing the function (which Vercel only reports as
 * FUNCTION_INVOCATION_FAILED). Configuration errors name variables but never include their values.
 */
export function createVercelEntry(env: NodeJS.ProcessEnv = process.env, kv?: KvStore): RequestListener {
  try {
    return createVercelHandler(env, kv);
  } catch (err) {
    const problems =
      err instanceof ConfigError
        ? err.issues
        : [`${(err as Error).name ?? 'Error'}: ${(err as Error).message ?? String(err)}`];
    console.error(`Startup failed:\n  - ${problems.join('\n  - ')}`);
    const body = JSON.stringify({ status: 'misconfigured', error: 'startup_failed', problems });
    return (_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
    };
  }
}
