import type { AuditSink } from '../audit/audit.js';
import type { OAuthFlow } from '../auth/oauth.js';
import type { TransportMode } from '../auth/userContext.js';
import type { Config } from '../config/config.js';
import type { DocsApi } from '../integrations/google/docsClient.js';
import type { GmailApi } from '../integrations/google/gmailClient.js';
import type { GoogleAuthProvider } from '../integrations/google/oauthClient.js';
import type { Metrics } from '../observability/metrics.js';
import type { ConfirmationService } from '../policy/confirmation.js';
import type { PolicyEngine } from '../policy/policy.js';
import type { IdempotencyStore } from '../utils/idempotency.js';
import type { Logger } from '../utils/logging.js';

/**
 * Everything the MCP tools need, injected so the transport (stdio/HTTP), the
 * Google adapters and the storage backends can be swapped independently.
 */
export interface ServerDeps {
  config: Config;
  mode: TransportMode;
  logger: Logger;
  auth: GoogleAuthProvider;
  /** Present when the server can complete OAuth itself (HTTP mode with a public callback URL). */
  oauthFlow: OAuthFlow | undefined;
  gmail: GmailApi;
  docs: DocsApi;
  idempotency: IdempotencyStore;
  policy: PolicyEngine;
  confirmations: ConfirmationService;
  audit: AuditSink;
  metrics: Metrics;
  now: () => Date;
}
