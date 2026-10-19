import { AppError } from '../../errors/appError.js';
import { failedBeforeSending } from '../../errors/googleErrors.js';
import { sanitizeDocText } from '../../integrations/google/docsAppend.js';
import { hashRequest } from '../../utils/fileStore.js';
import { runIdempotent } from '../../utils/idempotency.js';
import { withRetry } from '../../utils/retry.js';
import { utf8Bytes, utf16Length } from '../../utils/validation.js';
import { createInput, createOutput, type CreateInput } from '../schemas/googleDocsSchemas.js';
import type { ToolContext, ToolDefinition } from '../toolRunner.js';

const OPERATION = 'google_docs.create';

const documentUrl = (id: string) => `https://docs.google.com/document/d/${id}/edit`;

/** Failures after which Google may or may not have created the document. */
function isAmbiguous(err: unknown): boolean {
  if (!(err instanceof AppError)) return true;
  if (err.code === 'GOOGLE_API_ERROR' && err.retryable) return true;
  return err.code === 'NETWORK_ERROR' && !failedBeforeSending(err.cause);
}

async function handler(args: CreateInput, tc: ToolContext) {
  const { deps, user, requestId } = tc;

  // 1. Validate inputs (§16.3).
  const title = args.title.trim();
  if (!title) throw new AppError('INVALID_INPUT', 'title must not be empty.');
  if (/[\r\n]/.test(title)) throw new AppError('INVALID_INPUT', 'title must be a single line.');
  if (args.content !== undefined && !args.content.trim()) {
    throw new AppError(
      'INVALID_INPUT',
      'content must not be empty when provided; omit it to create an empty document.',
    );
  }
  const text = args.content !== undefined ? sanitizeDocText(args.content) : '';

  const audit = (
    status: 'success' | 'failure' | 'blocked' | 'confirmation_required' | 'duplicate',
    extra: Record<string, unknown> = {},
  ) =>
    deps.audit.record({
      request_id: requestId,
      user_id: user.userId,
      client_id: user.clientId,
      operation: OPERATION,
      target: (extra.result_id as string | undefined) ?? 'new-document',
      status,
      content_sha256: hashRequest({ title, content: text }),
      ...extra,
    });

  // 2. Policy (§34): creation must be enabled; initial content obeys the append size cap.
  try {
    deps.policy.checkDocsCreate(utf8Bytes(text));
  } catch (err) {
    await audit('blocked', { error_code: (err as AppError).code });
    throw err;
  }

  const requestHash = hashRequest({ title, content: text });

  // 3. Optional user confirmation (same policy switch as appends).
  if (deps.policy.policy.googleDocs.requireConfirmation) {
    try {
      const outcome = await deps.confirmations.confirm({
        operation: OPERATION,
        userId: user.userId,
        requestHash,
        summary: `Create a new Google Doc titled "${title}"${text ? ` containing ${utf16Length(text)} characters` : ''}?`,
        providedToken: args.confirmation_token,
        ctx: tc.ctx,
        clientCapabilities: tc.clientCapabilities,
      });
      if (outcome !== 'confirmed') return outcome;
    } catch (err) {
      const code = (err as AppError).code;
      await audit(code === 'CONFIRMATION_REQUIRED' ? 'confirmation_required' : 'blocked', {
        error_code: code,
      });
      throw err;
    }
  }

  // 4. Create, register as server-owned, then insert the initial content.
  let createdId: string | undefined;
  const create = async () => {
    const doc = await deps.metrics.time('google_api_latency_ms', { service: 'docs' }, () =>
      deps.docs.createDocument(user.userId, title),
    );
    if (!doc.documentId)
      throw new AppError('GOOGLE_API_ERROR', 'Google did not return a document ID.', { retryable: false });
    createdId = doc.documentId;
    await deps.createdDocs.add(user.userId, createdId);

    let revision = doc.revisionId ?? undefined;
    if (text) {
      try {
        const res = await withRetry(
          () =>
            deps.metrics.time('google_api_latency_ms', { service: 'docs' }, () =>
              deps.docs.batchUpdate(user.userId, createdId!, [
                { insertText: { text, endOfSegmentLocation: {} } },
              ]),
            ),
          // A brand-new document only: retry only when Google definitely rejected the call.
          {
            shouldRetry: (err) => err.code === 'RATE_LIMITED',
            onRetry: () => deps.metrics.inc('google_api_retries_total', { service: 'docs' }),
          },
        );
        revision = res.writeControl?.requiredRevisionId ?? revision;
      } catch (err) {
        const e =
          err instanceof AppError ? err : new AppError('INTERNAL_ERROR', 'Unexpected error', { cause: err });
        throw new AppError(
          e.code,
          `The document "${title}" was created, but adding its content failed (${e.message}). ` +
            'Do not create it again: call google_docs.append with this document_id to add the content.',
          {
            retryable: false,
            cause: e,
            details: { document_id: createdId, document_url: documentUrl(createdId) },
          },
        );
      }
    }

    return {
      success: true as const,
      operation: OPERATION,
      document_id: createdId,
      title: doc.title ?? title,
      document_url: documentUrl(createdId),
      characters_inserted: utf16Length(text),
      ...(revision ? { revision_id: revision } : {}),
    };
  };

  // 5. At most once per request (§17). Never auto-retried: an ambiguous failure could leave a duplicate document.
  const classifyFailure = (err: unknown): 'failed' | 'outcome_unknown' =>
    createdId !== undefined || isAmbiguous(err) ? 'outcome_unknown' : 'failed';
  const windowSeconds = deps.config.autoDedupeWindowSeconds;
  try {
    const result: Awaited<ReturnType<typeof create>> & { idempotent_replay?: boolean } =
      args.idempotency_key || windowSeconds > 0
        ? await runIdempotent({
            store: deps.idempotency,
            key: args.idempotency_key
              ? `explicit:${OPERATION}:${user.userId}:${args.idempotency_key}`
              : `auto:${OPERATION}:${user.userId}:${requestHash}`,
            requestHash,
            ttlSeconds: args.idempotency_key ? deps.config.idempotencyTtlSeconds : windowSeconds,
            mode: args.idempotency_key ? 'explicit' : 'auto',
            execute: create,
            classifyFailure,
          })
        : await create();

    if (result.idempotent_replay) {
      deps.metrics.inc('idempotency_events_total', { tool: OPERATION, event: 'replay' });
      await audit('duplicate', { result_id: result.document_id });
    } else {
      deps.metrics.inc('docs_creates_total');
      await audit('success', { result_id: result.document_id });
      tc.logger.info('document created', { document_id: result.document_id });
    }
    return result;
  } catch (err) {
    const appErr = err instanceof AppError ? err : undefined;
    const code = appErr?.code ?? 'INTERNAL_ERROR';
    if (code === 'DUPLICATE_REQUEST') {
      deps.metrics.inc('idempotency_events_total', { tool: OPERATION, event: 'duplicate_rejected' });
      await audit('duplicate', { error_code: code });
    } else {
      await audit('failure', { error_code: code, ...(createdId ? { result_id: createdId } : {}) });
      if (appErr && !createdId && isAmbiguous(appErr)) {
        throw new AppError(
          appErr.code,
          `${appErr.message} The document may or may not have been created; do not retry automatically — ask the user to check their Google Drive.`,
          {
            retryable: false,
            cause: appErr.cause ?? appErr,
            ...(appErr.details ? { details: appErr.details } : {}),
          },
        );
      }
    }
    throw err;
  }
}

export const googleDocsCreateTool: ToolDefinition<typeof createInput> = {
  name: OPERATION,
  title: 'Create Google Doc',
  description:
    "Create a new Google Doc in the authorized account's Google Drive, optionally with initial plain-text content, " +
    'and return its document_id and link. This performs an external write. Use when the user has asked for a new ' +
    'document. To add more text later, call google_docs.append with the returned document_id; do not create a new ' +
    'document for each addition. Provide an idempotency_key so a retried call never creates a duplicate document. ' +
    'If the result is CONFIRMATION_REQUIRED, show the summary to the user and call again with the confirmation_token ' +
    'only after they approve.',
  inputSchema: createInput,
  outputSchema: createOutput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler,
};
