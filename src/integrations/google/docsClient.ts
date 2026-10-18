import { docs, type docs_v1 } from '@googleapis/docs';
import { DOCS_SCOPE } from '../../config/config.js';
import { mapGoogleError } from '../../errors/googleErrors.js';
import type { GoogleAuthProvider } from './oauthClient.js';

/** Field mask for metadata reads: title, revision and up to three levels of nested tabs, no body content. */
export const METADATA_FIELDS =
  'documentId,title,revisionId,tabs(tabProperties,childTabs(tabProperties,childTabs(tabProperties,childTabs(tabProperties))))';

/** Google Docs operations the MCP tools depend on. Kept narrow so tests can substitute a fake. */
export interface DocsApi {
  getDocument(userId: string, documentId: string, fields?: string): Promise<docs_v1.Schema$Document>;
  batchUpdate(
    userId: string,
    documentId: string,
    requests: docs_v1.Schema$Request[],
    writeControl?: docs_v1.Schema$WriteControl,
  ): Promise<docs_v1.Schema$BatchUpdateDocumentResponse>;
}

export class GoogleDocsApi implements DocsApi {
  constructor(private readonly auth: GoogleAuthProvider) {}

  private async client(userId: string): Promise<docs_v1.Docs> {
    return docs({ version: 'v1', auth: await this.auth.getAuthorizedClient(userId, DOCS_SCOPE) });
  }

  async getDocument(userId: string, documentId: string, fields?: string): Promise<docs_v1.Schema$Document> {
    const api = await this.client(userId);
    try {
      const res = await api.documents.get(
        { documentId, includeTabsContent: true, ...(fields ? { fields } : {}) },
        { retry: false },
      );
      return res.data;
    } catch (err) {
      throw mapGoogleError(err, 'docs');
    }
  }

  async batchUpdate(
    userId: string,
    documentId: string,
    requests: docs_v1.Schema$Request[],
    writeControl?: docs_v1.Schema$WriteControl,
  ): Promise<docs_v1.Schema$BatchUpdateDocumentResponse> {
    const api = await this.client(userId);
    try {
      const res = await api.documents.batchUpdate(
        { documentId, requestBody: { requests, ...(writeControl ? { writeControl } : {}) } },
        { retry: false },
      );
      return res.data;
    } catch (err) {
      throw mapGoogleError(err, 'docs');
    }
  }
}
