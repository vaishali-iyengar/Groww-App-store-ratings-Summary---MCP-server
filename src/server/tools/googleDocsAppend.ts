import type { docs_v1 } from '@googleapis/docs';
import { AppError } from '../../errors/appError.js';
import { failedBeforeSending } from '../../errors/googleErrors.js';
import { buildAppendText, resolveAppendLocation, segmentText } from '../../integrations/google/docsAppend.js';
import { hashRequest } from '../../utils/fileStore.js';
import { runIdempotent } from '../../utils/idempotency.js';
import { withRetry } from '../../utils/retry.js';
import { parseDocumentId, utf8Bytes, utf16Length } from '../../utils/validation.js';
import { appendInput, appendOutput, type AppendInput } from '../schemas/googleDocsSchemas.js';
import type { ToolContext, ToolDefinition } from '../toolRunner.js';

const OPERATION = 'google_docs.append';

/** Failures after which the insert may or may not have been applied by Google. */
function isAmbiguous(err: AppError): boolean {
  if (err.code === 'GOOGLE_API_ERROR' && err.retryable) return true;
  return err.code === 'NETWORK_ERROR' && !failedBeforeSending(err.cause);
}

export function classifyAppendFailure(err: unknown): 'failed' | 'outcome_unknown' {
  return err instanceof AppError && isAmbiguous(err) ? 'outcome_unknown' : 'failed';
}

async function fetchDocument(tc: ToolContext, documentId: string): Promise<docs_v1.Schema$Document> {
  const { deps, user } = tc;
  return withRetry(
    () =>
      deps.metrics.time('google_api_latency_ms', { service: 'docs' }, () =>
        deps.docs.getDocument(user.userId, documentId),
      ),
    {
      onRetry: (err, attempt) => {
        deps.metrics.inc('google_api_retries_total', { service: 'docs' });
        tc.logger.warn('retrying document read', { attempt, error_code: err.code });
      },
    },
  );
}

async function handler(args: AppendInput, tc: ToolContext) {
  const { deps, user, requestId } = tc;

  // 1. Validate inputs (§16.3).
  const documentId = parseDocumentId(args.document_id);
  if (!args.content.trim()) throw new AppError('INVALID_INPUT', 'content must not be empty.');
  if (args.heading !== undefined && /[\r\n]/.test(args.heading)) {
    throw new AppError('INVALID_INPUT', 'heading must be a single line.');
  }
  if (args.separator === 'custom' && !args.custom_separator) {
    throw new AppError('INVALID_INPUT', 'custom_separator is required when separator is "custom".');
  }
  if (args.separator !== 'custom' && args.custom_separator !== undefined) {
    throw new AppError('INVALID_INPUT', 'custom_separator is only allowed when separator is "custom".');
  }
  const audit = (
    status: 'success' | 'failure' | 'blocked' | 'confirmation_required' | 'duplicate',
    extra = {},
  ) =>
    deps.audit.record({
      request_id: requestId,
      user_id: user.userId,
      client_id: user.clientId,
      operation: OPERATION,
      target: documentId,
      status,
      content_sha256: hashRequest({ content: args.content, heading: args.heading }),
      ...extra,
    });
  const checkPolicy = async (bytes: number) => {
    try {
      deps.policy.checkDocsAppend(documentId, bytes);
    } catch (err) {
      await audit('blocked', { error_code: (err as AppError).code });
      throw err;
    }
  };
  await checkPolicy(utf8Bytes(args.content));

  // 2. Resolve the document (verifies access) and the exact append location (§20).
  const doc = await fetchDocument(tc, documentId);
  const location = resolveAppendLocation(doc, args.tab_id);
  const before = segmentText(location.body);
  const text = buildAppendText({
    content: args.content,
    heading: args.heading,
    separator: args.separator,
    customSeparator: args.custom_separator,
    timestamp: args.timestamp,
    segmentIsEmpty: before.trim() === '',
    now: deps.now(),
    timeZone: deps.config.timestampTimezone,
  });
  await checkPolicy(utf8Bytes(text));

  const requestHash = hashRequest({
    document_id: documentId,
    tab_id: location.tabId,
    content: args.content,
    heading: args.heading,
    separator: args.separator,
    custom_separator: args.custom_separator,
    timestamp: args.timestamp,
  });
  const title = doc.title ?? '';

  // 3. Optional user confirmation (§16.2).
  if (deps.policy.policy.googleDocs.requireConfirmation) {
    try {
      const outcome = await deps.confirmations.confirm({
        operation: OPERATION,
        userId: user.userId,
        requestHash,
        summary: `Append ${utf16Length(text)} characters to the end of "${title}"${location.tabId ? ` (tab ${location.tabId})` : ''}?`,
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

  // 4. Insert at the end of the segment. A transient failure is retried only after re-reading the
  //    document proves the earlier attempt was not applied, so a retry cannot duplicate the text.
  const insert = async () => {
    let verifiedAfterRetry = false;
    const response = await withRetry(
      async (attempt) => {
        if (attempt > 1) {
          const current = segmentText(
            resolveAppendLocation(await fetchDocument(tc, documentId), location.tabId).body,
          );
          if (current.length >= before.length + text.length && current.endsWith(text + '\n')) {
            verifiedAfterRetry = true;
            return undefined;
          }
        }
        return deps.metrics.time('google_api_latency_ms', { service: 'docs' }, () =>
          deps.docs.batchUpdate(user.userId, documentId, [
            { insertText: { text, endOfSegmentLocation: location.endOfSegmentLocation } },
          ]),
        );
      },
      {
        shouldRetry: (err) => err.code === 'RATE_LIMITED' || isAmbiguous(err),
        onRetry: (err, attempt) => {
          deps.metrics.inc('google_api_retries_total', { service: 'docs' });
          tc.logger.warn('retrying document append', { attempt, error_code: err.code });
        },
      },
    );
    const revision = response?.writeControl?.requiredRevisionId ?? undefined;
    return {
      success: true as const,
      operation: OPERATION,
      document_id: documentId,
      document_title: title,
      tab_id: location.tabId ?? null,
      characters_appended: utf16Length(text),
      ...(revision ? { revision_id: revision } : {}),
      ...(verifiedAfterRetry ? { verified_after_retry: true } : {}),
    };
  };

  const windowSeconds = deps.config.autoDedupeWindowSeconds;
  try {
    const result: Awaited<ReturnType<typeof insert>> & { idempotent_replay?: boolean } =
      args.idempotency_key || windowSeconds > 0
        ? await runIdempotent({
            store: deps.idempotency,
            key: args.idempotency_key
              ? `explicit:${OPERATION}:${user.userId}:${args.idempotency_key}`
              : `auto:${OPERATION}:${user.userId}:${requestHash}`,
            requestHash,
            ttlSeconds: args.idempotency_key ? deps.config.idempotencyTtlSeconds : windowSeconds,
            mode: args.idempotency_key ? 'explicit' : 'auto',
            execute: insert,
            classifyFailure: classifyAppendFailure,
          })
        : await insert();

    if (result.idempotent_replay) {
      deps.metrics.inc('idempotency_events_total', { tool: OPERATION, event: 'replay' });
      await audit('duplicate');
    } else {
      deps.metrics.inc('docs_appends_total');
      await audit('success', { result_id: result.revision_id });
    }
    return result;
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'INTERNAL_ERROR';
    if (code === 'DUPLICATE_REQUEST') {
      deps.metrics.inc('idempotency_events_total', { tool: OPERATION, event: 'duplicate_rejected' });
    }
    await audit(code === 'DUPLICATE_REQUEST' ? 'duplicate' : 'failure', { error_code: code });
    throw err;
  }
}

export const googleDocsAppendTool: ToolDefinition<typeof appendInput> = {
  name: OPERATION,
  title: 'Append to Google Doc',
  description:
    'Append text to the end of an existing Google Docs document without replacing or deleting existing content. ' +
    'This performs an external write operation. Use when the user has clearly requested that information be added ' +
    'to a specific Google Doc. Call google_docs.get_metadata first to confirm the document title (and tab) with the ' +
    'user. Content is inserted as plain text; Markdown/HTML is not converted. Provide an idempotency_key so a retried ' +
    'call never appends twice. If the result is CONFIRMATION_REQUIRED, show the summary to the user and call again ' +
    'with the confirmation_token only after they approve.',
  inputSchema: appendInput,
  outputSchema: appendOutput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler,
};
