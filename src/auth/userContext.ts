import type { AuthInfo } from '@modelcontextprotocol/server';
import { AppError } from '../errors/appError.js';

/**
 * The end user whose Google credentials a request acts on (§15). This is
 * deliberately separate from the MCP client identity (`clientId`): the
 * client is the agent/app; the user owns the Google account.
 */
export interface UserContext {
  userId: string;
  clientId: string | undefined;
}

export type TransportMode = 'stdio' | 'http';

/**
 * Deterministically maps an MCP request to an end user.
 * - stdio (local, single-user): the configured DEFAULT_USER_ID.
 * - http: only the userId attached by the server's own bearer-token verifier.
 *   Nothing in tool arguments or Google content can select a different user.
 */
export function resolveUserContext(
  mode: TransportMode,
  defaultUserId: string,
  authInfo: AuthInfo | undefined,
): UserContext {
  if (mode === 'stdio') return { userId: defaultUserId, clientId: authInfo?.clientId };
  const userId = authInfo?.extra?.userId;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new AppError(
      'AUTHENTICATION_REQUIRED',
      'The MCP request is not associated with an authenticated user.',
    );
  }
  return { userId, clientId: authInfo?.clientId };
}
