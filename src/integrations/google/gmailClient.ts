import { gmail } from '@googleapis/gmail';
import { GMAIL_SEND_SCOPE } from '../../config/config.js';
import { mapGoogleError } from '../../errors/googleErrors.js';
import type { GoogleAuthProvider } from './oauthClient.js';

export interface SentMessage {
  id: string;
  threadId: string;
  labelIds: string[];
}

/** Gmail operations the MCP tools depend on. Kept narrow so tests can substitute a fake. */
export interface GmailApi {
  /** Sends a base64url-encoded RFC 5322 message. Must NOT retry internally (duplicate-send risk). */
  sendRaw(userId: string, raw: string, threadId?: string): Promise<SentMessage>;
}

export class GoogleGmailApi implements GmailApi {
  constructor(private readonly auth: GoogleAuthProvider) {}

  async sendRaw(userId: string, raw: string, threadId?: string): Promise<SentMessage> {
    const authClient = await this.auth.getAuthorizedClient(userId, GMAIL_SEND_SCOPE);
    try {
      const res = await gmail({ version: 'v1', auth: authClient }).users.messages.send(
        { userId: 'me', requestBody: { raw, ...(threadId ? { threadId } : {}) } },
        { retry: false }, // retries are decided by the idempotency layer, never by the HTTP client
      );
      return { id: res.data.id ?? '', threadId: res.data.threadId ?? '', labelIds: res.data.labelIds ?? [] };
    } catch (err) {
      throw mapGoogleError(err, 'gmail');
    }
  }
}
