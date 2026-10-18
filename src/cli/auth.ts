#!/usr/bin/env node
/**
 * Local Google authorization (§12): runs the OAuth 2.0 authorization-code
 * flow with PKCE on a loopback redirect and stores the resulting tokens in
 * the encrypted token store. MCP tool calls never open a browser themselves.
 *
 *   npm run auth                       # authorize DEFAULT_USER_ID
 *   npm run auth -- --user alice       # authorize a specific user (HTTP multi-user mode)
 *   npm run auth -- --status           # show the authorized account
 *   npm run auth -- --revoke           # revoke at Google and delete locally
 */
import http from 'node:http';
import { OAuthFlow, revokeAuthorization } from '../auth/oauth.js';
import { ConfigError, loadConfig } from '../config/config.js';
import { createTokenStore } from '../container.js';
import { GoogleAuthProvider } from '../integrations/google/oauthClient.js';
import { createKvFromEnv } from '../storage/kv.js';
import { loadEnvFile } from '../utils/env.js';
import { createLogger } from '../utils/logging.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  if (!config.google) {
    throw new ConfigError([
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set (see README "Google Cloud setup")',
    ]);
  }
  const userId = arg('--user') ?? config.defaultUserId;
  // With Upstash credentials in the environment this writes to the shared store a Vercel deployment reads.
  const tokenStore = createTokenStore(config, createKvFromEnv());
  const provider = new GoogleAuthProvider(config.google, tokenStore, createLogger('warn'));

  if (process.argv.includes('--status')) {
    const s = await provider.getStatus(userId);
    console.log(
      s.authorized
        ? `User "${userId}" is authorized as ${s.email ?? '(unknown email)'}`
        : `User "${userId}" is not authorized`,
    );
    if (s.authorized) console.log(`Granted scopes: ${s.grantedScopes.join(' ') || '(not recorded)'}`);
    return;
  }

  if (process.argv.includes('--revoke')) {
    await revokeAuthorization(provider, tokenStore, userId);
    console.log(`Revoked and deleted Google authorization for user "${userId}".`);
    return;
  }

  const redirect = new URL(config.google.redirectUri);
  if (!['127.0.0.1', 'localhost'].includes(redirect.hostname)) {
    throw new ConfigError([
      'For `npm run auth`, GOOGLE_REDIRECT_URI must be a loopback URL such as http://127.0.0.1:53682/oauth2callback',
    ]);
  }

  const flow = new OAuthFlow(provider, tokenStore);
  const { url } = await flow.start(userId, config.google.redirectUri);

  const result = await new Promise<{ email: string | undefined }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', config.google!.redirectUri);
      if (reqUrl.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }
      const code = reqUrl.searchParams.get('code');
      const state = reqUrl.searchParams.get('state');
      const finish = (status: number, msg: string) => {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(msg);
        server.close();
      };
      if (!code || !state) {
        finish(400, `Authorization failed: ${reqUrl.searchParams.get('error') ?? 'no code returned'}`);
        reject(
          new Error(`Authorization was not completed (${reqUrl.searchParams.get('error') ?? 'no code'})`),
        );
        return;
      }
      flow
        .complete(code, state)
        .then(({ email }) => {
          finish(200, 'Google account connected. You can close this window and return to the terminal.');
          resolve({ email });
        })
        .catch((err: Error) => {
          finish(400, 'Authorization failed. Return to the terminal for details.');
          reject(err);
        });
    });
    server.on('error', reject);
    server.listen(Number(redirect.port || 80), redirect.hostname, () => {
      console.log(`\nAuthorizing Google account for user "${userId}".`);
      console.log(`Requested scopes: ${config.google!.scopes.join(' ')}\n`);
      console.log('Open this URL in your browser:\n');
      console.log(`  ${url}\n`);
      console.log('Waiting for Google to redirect back...');
    });
    setTimeout(
      () => {
        server.close();
        reject(new Error('Timed out waiting for authorization (10 minutes).'));
      },
      10 * 60 * 1000,
    ).unref();
  });

  console.log(
    `\nAuthorized ${result.email ?? 'Google account'} for user "${userId}". Tokens stored encrypted in ${config.dataDir}`,
  );
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : `Error: ${(err as Error).message}`);
  process.exit(1);
});
