import { FileAuditSink, KvAuditSink } from './audit/audit.js';
import { OAuthFlow } from './auth/oauth.js';
import {
  EncryptedFileTokenStore,
  InMemoryTokenStore,
  KvTokenStore,
  type TokenStore,
} from './auth/tokenStore.js';
import type { TransportMode } from './auth/userContext.js';
import type { Config } from './config/config.js';
import { GoogleDocsApi } from './integrations/google/docsClient.js';
import { GoogleGmailApi } from './integrations/google/gmailClient.js';
import { GoogleAuthProvider } from './integrations/google/oauthClient.js';
import { Metrics } from './observability/metrics.js';
import { ConfirmationService } from './policy/confirmation.js';
import { loadPolicy, PolicyEngine } from './policy/policy.js';
import type { ServerDeps } from './server/deps.js';
import { createKvFromEnv, type KvStore } from './storage/kv.js';
import { KvPendingStore } from './storage/pendingStore.js';
import { FileIdempotencyStore, KvIdempotencyStore } from './utils/idempotency.js';
import type { Logger } from './utils/logging.js';

export function createTokenStore(config: Config, kv?: KvStore): TokenStore {
  // Without an encryption key nothing can be stored securely; an empty in-memory store keeps
  // the server discoverable (connection.get_status reports "not configured").
  if (!config.tokenStoreKey) return new InMemoryTokenStore();
  return kv
    ? new KvTokenStore(kv, config.tokenStoreKey)
    : new EncryptedFileTokenStore(config.dataDir, config.tokenStoreKey);
}

/**
 * Wires production implementations of every dependency. With a shared KV store (Upstash Redis,
 * picked up from the environment in HTTP mode) all state lives there, so any number of
 * instances can serve requests; without one, state stays in this process and DATA_DIR.
 */
export function createDeps(
  config: Config,
  mode: TransportMode,
  logger: Logger,
  kv: KvStore | undefined = mode === 'http' ? createKvFromEnv() : undefined,
): ServerDeps {
  const tokenStore = createTokenStore(config, kv);
  const auth = new GoogleAuthProvider(config.google, tokenStore, logger);
  const policy = loadPolicy(config);
  return {
    config,
    mode,
    logger,
    auth,
    oauthFlow:
      mode === 'http' && config.google
        ? new OAuthFlow(
            auth,
            tokenStore,
            config.http.oauthStateSecret,
            Date.now,
            kv ? new KvPendingStore(kv, 'oauth') : undefined,
          )
        : undefined,
    gmail: new GoogleGmailApi(auth),
    docs: new GoogleDocsApi(auth),
    idempotency: kv ? new KvIdempotencyStore(kv) : new FileIdempotencyStore(config.dataDir),
    policy: new PolicyEngine(policy),
    confirmations: new ConfirmationService(
      policy.confirmation,
      Date.now,
      kv ? new KvPendingStore(kv, 'confirm') : undefined,
    ),
    audit: kv ? new KvAuditSink(kv, logger) : new FileAuditSink(config.dataDir, logger),
    metrics: new Metrics(),
    now: () => new Date(),
  };
}
