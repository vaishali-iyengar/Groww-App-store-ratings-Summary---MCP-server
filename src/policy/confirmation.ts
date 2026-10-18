import { randomBytes } from 'node:crypto';
import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import * as z from 'zod';
import { AppError } from '../errors/appError.js';
import { inMemoryPendingStore, type PendingStore } from '../storage/pendingStore.js';
import type { Policy } from './policy.js';

const confirmSchema = z.object({
  confirm: z.boolean().describe('Approve this action'),
});

export interface PendingConfirmation {
  userId: string;
  operation: string;
  requestHash: string;
  expiresAt: number;
}

export interface ConfirmationRequest {
  operation: string;
  userId: string;
  /** Hash of the tool arguments (excluding confirmation_token): a token only approves this exact request. */
  requestHash: string;
  /** Human-readable description shown to the user. Must not contain secrets. */
  summary: string;
  providedToken: string | undefined;
  ctx: ServerContext;
  clientCapabilities: Record<string, unknown> | undefined;
}

export function clientSupportsElicitation(
  ctx: ServerContext,
  sessionCapabilities: Record<string, unknown> | undefined,
): boolean {
  const perRequest = ctx.mcpReq.envelope?.[
    CLIENT_CAPABILITIES_META_KEY as keyof typeof ctx.mcpReq.envelope
  ] as Record<string, unknown> | undefined;
  const caps = perRequest ?? sessionCapabilities;
  const elicitation = caps?.elicitation as Record<string, unknown> | undefined;
  // A bare `elicitation: {}` means form support (pre-mode rule).
  return (
    elicitation !== undefined && (Object.keys(elicitation).length === 0 || elicitation.form !== undefined)
  );
}

/**
 * Host-agnostic confirmation for side effects (§16.1).
 *
 * 1. Clients that support elicitation get a standard MCP input request; the
 *    host asks the user directly and the call proceeds only on `confirm: true`.
 * 2. Other clients get a CONFIRMATION_REQUIRED error with a single-use token
 *    bound to (user, operation, exact arguments) and a short TTL. The agent
 *    must show the summary to the user and repeat the call with the token.
 */
export class ConfirmationService {
  constructor(
    private readonly policy: Policy['confirmation'],
    private readonly now: () => number = Date.now,
    /** Shared across instances in serverless deployments, so a token issued by one is accepted by another. */
    private readonly pending: PendingStore<PendingConfirmation> = inMemoryPendingStore('confirm', now),
  ) {}

  /** Returns `'confirmed'`, or an input-required result the tool must return as-is. Throws when blocked. */
  async confirm(req: ConfirmationRequest): Promise<'confirmed' | InputRequiredResult> {
    const canElicit = clientSupportsElicitation(req.ctx, req.clientCapabilities);
    const mode = this.policy.mode;

    if (canElicit && mode !== 'token_only') {
      const responses = req.ctx.mcpReq.inputResponses;
      const accepted = acceptedContent(responses, 'confirm', confirmSchema);
      if (accepted?.confirm === true) return 'confirmed';
      const view = inputResponse(responses, 'confirm');
      if ((view.kind === 'elicit' && view.action !== 'accept') || accepted?.confirm === false) {
        throw new AppError('POLICY_BLOCKED', 'The user declined the action.');
      }
      return inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({ message: req.summary, requestedSchema: confirmSchema }),
        },
      });
    }

    if (mode === 'elicitation_only') {
      throw new AppError(
        'POLICY_BLOCKED',
        'Server policy requires direct user confirmation, but this MCP client does not support elicitation.',
      );
    }

    if (req.providedToken) {
      const p = await this.pending.take(req.providedToken); // single use
      if (!p || p.expiresAt < this.now() || p.userId !== req.userId || p.operation !== req.operation) {
        throw new AppError('INVALID_INPUT', 'confirmation_token is invalid, expired, or already used.');
      }
      if (p.requestHash !== req.requestHash) {
        throw new AppError(
          'INVALID_INPUT',
          'confirmation_token was issued for different arguments. Request a new confirmation for the changed request.',
        );
      }
      return 'confirmed';
    }

    const token = `cfm_${randomBytes(18).toString('base64url')}`;
    const expiresAt = this.now() + this.policy.tokenTtlSeconds * 1000;
    await this.pending.put(
      token,
      { userId: req.userId, operation: req.operation, requestHash: req.requestHash, expiresAt },
      this.policy.tokenTtlSeconds * 1000,
    );
    throw new AppError(
      'CONFIRMATION_REQUIRED',
      'Server policy requires explicit user approval. Show the summary to the user; only if they approve, ' +
        'call this tool again with identical arguments plus confirmation_token.',
      {
        details: {
          summary: req.summary,
          confirmation_token: token,
          expires_at: new Date(expiresAt).toISOString(),
        },
      },
    );
  }
}
