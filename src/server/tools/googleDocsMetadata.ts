import { METADATA_FIELDS } from '../../integrations/google/docsClient.js';
import { flattenTabs } from '../../integrations/google/docsAppend.js';
import { withRetry } from '../../utils/retry.js';
import { parseDocumentId } from '../../utils/validation.js';
import { metadataInput, metadataOutput } from '../schemas/googleDocsSchemas.js';
import type { ToolDefinition } from '../toolRunner.js';

const OPERATION = 'google_docs.get_metadata';

export const googleDocsMetadataTool: ToolDefinition<typeof metadataInput> = {
  name: OPERATION,
  title: 'Get Google Doc metadata',
  description:
    'Read-only. Return the title, revision ID and tabs of an existing Google Doc so the target can be confirmed ' +
    'before writing to it. Does not return document content. Also verifies that the authorized account can access ' +
    'the document.',
  inputSchema: metadataInput,
  outputSchema: metadataOutput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (args, tc) => {
    const { deps, user } = tc;
    const documentId = parseDocumentId(args.document_id);
    deps.policy.checkDocsRead(documentId, await deps.createdDocs.has(user.userId, documentId));
    const doc = await withRetry(
      () =>
        deps.metrics.time('google_api_latency_ms', { service: 'docs' }, () =>
          deps.docs.getDocument(user.userId, documentId, METADATA_FIELDS),
        ),
      { onRetry: () => deps.metrics.inc('google_api_retries_total', { service: 'docs' }) },
    );
    return {
      success: true as const,
      operation: OPERATION,
      document_id: doc.documentId ?? documentId,
      title: doc.title ?? '',
      ...(doc.revisionId ? { revision_id: doc.revisionId } : {}),
      document_url: `https://docs.google.com/document/d/${documentId}/edit`,
      tabs: flattenTabs(doc),
    };
  },
};
