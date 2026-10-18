import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { GoogleAuthProvider } from '../integrations/google/oauthClient.js';
import { inMemoryPendingStore, type PendingStore } from '../storage/pendingStore.js';
import type { TokenStore } from './tokenStore.js';

export interface PendingAuthorization {
  userId: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Google OAuth 2.0 authorization-code flow with PKCE (§12).
 *
 * `state` is an HMAC-signed, single-use, 10-minute nonce. The PKCE verifier
 * and the userId the grant will be stored under stay server-side, so a
 * callback can only complete an authorization this process started.
 */
export class OAuthFlow {
  private readonly stateSecret: Buffer;

  constructor(
    private readonly provider: GoogleAuthProvider,
    private readonly tokenStore: TokenStore,
    /** Must be set when several instances serve callbacks; a per-process random secret only works for one. */
    stateSecret?: string,
    private readonly now: () => number = Date.now,
    /** Shared across instances in serverless deployments, so any instance can complete the callback. */
    private readonly pending: PendingStore<PendingAuthorization> = inMemoryPendingStore('oauth', now),
  ) {
    this.stateSecret = stateSecret ? Buffer.from(stateSecret, 'utf8') : randomBytes(32);
  }

  private sign(nonce: string): string {
    return createHmac('sha256', this.stateSecret).update(nonce).digest('base64url');
  }

  /** Starts an authorization for `userId` and returns the Google consent URL. */
  async start(userId: string, redirectUri?: string): Promise<{ url: string; expiresAt: number }> {
    const client = this.provider.createClient(redirectUri);
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const nonce = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + STATE_TTL_MS;
    await this.pending.put(
      nonce,
      {
        userId,
        codeVerifier,
        redirectUri: redirectUri ?? (client as unknown as { redirectUri: string }).redirectUri,
        expiresAt,
      },
      STATE_TTL_MS,
    );
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // guarantees a refresh_token is issued
      scope: this.provider.scopes,
      state: `${nonce}.${this.sign(nonce)}`,
      code_challenge_method: 'S256' as never,
      code_challenge: codeChallenge,
      include_granted_scopes: false,
    });
    return { url, expiresAt };
  }

  /** Completes the flow from the redirect's `code` and `state`, storing tokens for the pending user. */
  async complete(code: string, state: string): Promise<{ userId: string; email: string | undefined }> {
    const [nonce, sig] = state.split('.');
    if (!nonce || !sig) throw new Error('Malformed OAuth state');
    const expected = Buffer.from(this.sign(nonce));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      throw new Error('Invalid OAuth state');
    const pending = await this.pending.take(nonce); // single use, even on failure
    if (!pending || pending.expiresAt < this.now()) throw new Error('OAuth state expired or already used');

    const client = this.provider.createClient(pending.redirectUri);
    const { tokens } = await client.getToken({ code, codeVerifier: pending.codeVerifier });

    let email: string | undefined;
    if (tokens.id_token) {
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token });
      email = ticket.getPayload()?.email;
    }
    await this.tokenStore.saveToken(pending.userId, { ...tokens, email });
    return { userId: pending.userId, email };
  }
}

/** Revokes the user's grant at Google (best effort) and deletes it locally. */
export async function revokeAuthorization(
  provider: GoogleAuthProvider,
  tokenStore: TokenStore,
  userId: string,
): Promise<void> {
  const token = await tokenStore.getToken(userId);
  const revocable = token?.refresh_token ?? token?.access_token;
  if (revocable) {
    try {
      await provider.createClient().revokeToken(revocable);
    } catch {
      // Already revoked/expired: local deletion below is what matters.
    }
  }
  await tokenStore.deleteToken(userId);
}
