import * as z from 'zod';
import { confirmationToken, idempotencyKey } from './gmailSchemas.js';

const documentId = z
  .string()
  .max(512)
  .describe(
    'ID of an existing Google Doc (the part after /d/ in its URL). A full docs.google.com URL is also accepted.',
  );

export const appendInput = z
  .object({
    document_id: documentId,
    content: z
      .string()
      .describe('Plain text to append. Newlines create new paragraphs. Markdown/HTML is not interpreted.'),
    tab_id: z
      .string()
      .max(128)
      .optional()
      .describe('Optional tab to append to (see google_docs.get_metadata). Defaults to the first tab.'),
    separator: z
      .enum(['none', 'newline', 'double_newline', 'custom'])
      .default('newline')
      .describe(
        'What to insert between existing content and the appended block. "newline" starts a new paragraph; ' +
          '"double_newline" leaves a blank line; "custom" inserts custom_separator verbatim. Skipped for empty documents.',
      ),
    custom_separator: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Required when separator is "custom"; inserted exactly as given (include "\\n" for line breaks).',
      ),
    heading: z
      .string()
      .max(500)
      .optional()
      .describe('Optional single-line heading placed on its own line above the content.'),
    timestamp: z
      .boolean()
      .default(false)
      .describe('When true, adds the current date/time (server time zone) on the heading line.'),
    idempotency_key: idempotencyKey.optional(),
    confirmation_token: confirmationToken.optional(),
  })
  .strict();

export type AppendInput = z.output<typeof appendInput>;

export const appendOutput = z.object({
  success: z.literal(true),
  operation: z.literal('google_docs.append'),
  document_id: z.string(),
  document_title: z.string(),
  tab_id: z.string().nullable(),
  characters_appended: z
    .number()
    .int()
    .describe('Characters inserted, in UTF-16 code units (Google Docs index units).'),
  revision_id: z.string().optional(),
  verified_after_retry: z
    .boolean()
    .optional()
    .describe('True when a transient error occurred and the server confirmed the text was already applied.'),
  idempotent_replay: z.boolean().optional(),
  request_id: z.string(),
});

export const metadataInput = z.object({ document_id: documentId }).strict();

export const metadataOutput = z.object({
  success: z.literal(true),
  operation: z.literal('google_docs.get_metadata'),
  document_id: z.string(),
  title: z.string(),
  revision_id: z.string().optional(),
  document_url: z.string(),
  tabs: z.array(
    z.object({
      tab_id: z.string(),
      title: z.string(),
      index: z.number().int(),
      nesting_level: z.number().int(),
      parent_tab_id: z.string().optional(),
    }),
  ),
  request_id: z.string(),
});

export const statusInput = z.object({}).strict();

export const statusOutput = z.object({
  success: z.literal(true),
  operation: z.literal('connection.get_status'),
  google_oauth_configured: z.boolean(),
  gmail_available: z.boolean(),
  google_docs_available: z.boolean(),
  authorized_user: z.string().nullable(),
  authorization_required: z.boolean(),
  authorization_hint: z.string().optional(),
  authorization_url: z.string().optional(),
  granted_scopes: z.array(z.string()),
  policy: z.object({
    gmail_send_enabled: z.boolean(),
    gmail_requires_confirmation: z.boolean(),
    max_email_recipients: z.number().int(),
    docs_append_enabled: z.boolean(),
    docs_requires_confirmation: z.boolean(),
    docs_restricted_to_allowlist: z.boolean(),
  }),
  server: z.object({ name: z.string(), version: z.string(), transport: z.enum(['stdio', 'http']) }),
  request_id: z.string(),
});
