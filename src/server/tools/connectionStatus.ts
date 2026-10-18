import { DOCS_SCOPE, GMAIL_SEND_SCOPE } from '../../config/config.js';
import { AppError } from '../../errors/appError.js';
import { statusInput, statusOutput } from '../schemas/googleDocsSchemas.js';
import type { ToolDefinition } from '../toolRunner.js';

const OPERATION = 'connection.get_status';

export const connectionStatusTool: ToolDefinition<typeof statusInput> = {
  name: OPERATION,
  title: 'Google connection status',
  description:
    'Read-only. Report whether Google authorization is configured for the current user, which capabilities ' +
    '(Gmail send, Google Docs) are available, and which Google account is authorized. Never returns credentials. ' +
    'Call this first if another tool fails with AUTHENTICATION_REQUIRED.',
  inputSchema: statusInput,
  outputSchema: statusOutput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async (_args, tc) => {
    const { deps, user } = tc;
    const status = await deps.auth.getStatus(user.userId);
    let authorized = status.authorized;
    let hint: string | undefined;

    if (authorized) {
      // Live check: surfaces revoked grants instead of reporting stale "authorized" state.
      try {
        await deps.auth.getAuthorizedClient(user.userId);
      } catch (err) {
        if (err instanceof AppError && err.code === 'AUTHENTICATION_REQUIRED') {
          authorized = false;
          hint = 'The stored Google authorization was revoked or expired.';
        }
      }
    }

    let authorizationUrl: string | undefined;
    if (!status.configured) {
      hint = 'Google OAuth is not configured on the server (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).';
    } else if (!authorized) {
      if (deps.oauthFlow) {
        const started = await deps.oauthFlow.start(
          user.userId,
          `${deps.config.http.publicBaseUrl}/oauth2/callback`,
        );
        authorizationUrl = started.url;
        hint =
          `${hint ?? ''} Ask the user to open authorization_url in a browser to connect their Google account (valid 10 minutes).`.trim();
      } else {
        hint =
          `${hint ?? ''} The server operator must run \`npm run auth\` on the server machine to authorize a Google account.`.trim();
      }
    }

    const scopes = status.grantedScopes;
    // Tokens without a recorded scope string predate scope tracking; treat the configured scopes as granted.
    const has = (s: string) => (scopes.length === 0 ? deps.auth.scopes.includes(s) : scopes.includes(s));
    const p = deps.policy.policy;
    return {
      success: true as const,
      operation: OPERATION,
      google_oauth_configured: status.configured,
      gmail_available: authorized && has(GMAIL_SEND_SCOPE) && p.gmail.send,
      google_docs_available: authorized && has(DOCS_SCOPE),
      authorized_user: authorized ? (status.email ?? null) : null,
      authorization_required: !authorized,
      ...(hint ? { authorization_hint: hint } : {}),
      ...(authorizationUrl ? { authorization_url: authorizationUrl } : {}),
      granted_scopes: authorized ? scopes : [],
      policy: {
        gmail_send_enabled: p.gmail.send,
        gmail_requires_confirmation: p.gmail.requireConfirmation,
        max_email_recipients: p.gmail.maxRecipients,
        docs_append_enabled: p.googleDocs.append,
        docs_requires_confirmation: p.googleDocs.requireConfirmation,
        docs_restricted_to_allowlist: p.googleDocs.allowedDocumentIds.length > 0,
      },
      server: { name: deps.config.serverName, version: deps.config.serverVersion, transport: deps.mode },
    };
  },
};
