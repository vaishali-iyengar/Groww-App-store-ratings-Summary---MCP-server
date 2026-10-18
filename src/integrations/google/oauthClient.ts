import { OAuth2Client, type Credentials } from 'google-auth-library';
import type { GoogleOAuthConfig } from '../../config/config.js';
import type { OAuthToken, TokenStore } from '../../auth/tokenStore.js';
import { AppError } from '../../errors/appError.js';
import { mapGoogleError } from '../../errors/googleErrors.js';
import type { Logger } from '../../utils/logging.js';

export interface AuthorizationStatus {
  configured: boolean;
  authorized: boolean;
  email: string | undefined;
  grantedScopes: string[];
}

/**
 * Builds per-user OAuth2 clients from the TokenStore and persists refreshed
 * tokens back to it, so users never re-authorize per request (§12).
 */
export class GoogleAuthProvider {
  constructor(
    private readonly config: GoogleOAuthConfig | undefined,
    private readonly tokenStore: TokenStore,
    private readonly logger: Logger,
  ) {}

  get isConfigured(): boolean {
    return this.config !== undefined;
  }

  get scopes(): string[] {
    return this.config?.scopes ?? [];
  }

  /** A bare client for running the authorization-code flow. */
  createClient(redirectUri?: string): OAuth2Client {
    if (!this.config) {
      throw new AppError(
        'AUTHENTICATION_REQUIRED',
        'Google OAuth is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).',
      );
    }
    return new OAuth2Client({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectUri: redirectUri ?? this.config.redirectUri,
    });
  }

  async getStatus(userId: string): Promise<AuthorizationStatus> {
    if (!this.config) return { configured: false, authorized: false, email: undefined, grantedScopes: [] };
    const token = await this.tokenStore.getToken(userId);
    const authorized = Boolean(token?.refresh_token || token?.access_token);
    return {
      configured: true,
      authorized,
      email: token?.email,
      grantedScopes: (token?.scope ?? '').split(/\s+/).filter(Boolean),
    };
  }

  /**
   * Returns an OAuth2 client ready to call Google APIs for `userId`, refreshing
   * the access token if needed. Fails with AUTHENTICATION_REQUIRED when the user
   * has not authorized or the grant was revoked.
   */
  async getAuthorizedClient(userId: string, requiredScope?: string): Promise<OAuth2Client> {
    const client = this.createClient();
    const token = await this.tokenStore.getToken(userId);
    if (!token || (!token.refresh_token && !token.access_token)) {
      throw new AppError(
        'AUTHENTICATION_REQUIRED',
        'No Google account is authorized for this user. Ask the server operator/user to complete Google authorization.',
      );
    }
    if (requiredScope && token.scope && !token.scope.split(/\s+/).includes(requiredScope)) {
      throw new AppError(
        'AUTHORIZATION_DENIED',
        'The authorized Google account did not grant the permission this operation needs. Re-authorize and accept all requested permissions.',
        { details: { required_scope: requiredScope } },
      );
    }

    client.setCredentials(token as Credentials);
    client.on('tokens', (fresh) => {
      const merged: OAuthToken = {
        ...token,
        ...fresh,
        // Google omits refresh_token on refresh responses; keep the original.
        refresh_token: fresh.refresh_token ?? token.refresh_token ?? null,
      };
      this.tokenStore.saveToken(userId, merged).catch((err) => {
        this.logger.error('failed to persist refreshed Google token', { user_id: userId, error: err });
      });
    });

    try {
      await client.getAccessToken(); // refreshes now if expired, so revocation surfaces before any side effect
    } catch (err) {
      const mapped = mapGoogleError(err, 'gmail');
      if (mapped.code === 'AUTHENTICATION_REQUIRED') {
        this.logger.warn('google token refresh rejected; re-authorization required', { user_id: userId });
      }
      throw mapped;
    }
    return client;
  }
}
