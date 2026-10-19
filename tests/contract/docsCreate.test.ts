import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/appError.js';
import { FileCreatedDocsRegistry, KvCreatedDocsRegistry } from '../../src/storage/createdDocs.js';
import { MemoryKvStore } from '../../src/storage/kv.js';
import { createHarness, DOC_ID, tempDir, type Harness } from '../helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const deployedPolicy = JSON.parse(readFileSync('policy.json', 'utf8')) as Record<string, unknown>;

describe('google_docs.create', () => {
  it('is disabled unless policy enables it', async () => {
    h = await createHarness();
    const r = await h.call('google_docs.create', { title: 'XYZ', content: 'TBS' });
    expect(r.structuredContent).toMatchObject({ error: { code: 'POLICY_BLOCKED' } });
    expect(h.docs.created).toHaveLength(0);
  });

  it('creates a document with content, without confirmation, under the deployed policy', async () => {
    h = await createHarness({ policy: deployedPolicy });
    const r = await h.call('google_docs.create', {
      title: 'XYZ',
      content: 'TBS',
      idempotency_key: 'create-xyz-0001',
    });
    expect(r.isError).toBeFalsy();
    const id = r.structuredContent!.document_id as string;
    expect(r.structuredContent).toMatchObject({
      success: true,
      operation: 'google_docs.create',
      title: 'XYZ',
      document_url: `https://docs.google.com/document/d/${id}/edit`,
      characters_inserted: 3,
    });
    expect(h.docs.tabText(id, 't.0')).toBe('TBS\n');
    expect(h.audit.records.at(-1)).toMatchObject({
      operation: 'google_docs.create',
      status: 'success',
      result_id: id,
    });
    expect(JSON.stringify(h.audit.records)).not.toContain('TBS');
  });

  it('creates an empty document when no content is given', async () => {
    h = await createHarness({ policy: deployedPolicy });
    const r = await h.call('google_docs.create', { title: 'Empty doc' });
    expect(r.structuredContent).toMatchObject({ success: true, characters_inserted: 0 });
    expect(h.docs.updates).toHaveLength(0);
  });

  it('restricts reads and appends to documents the server created (or allowlisted)', async () => {
    h = await createHarness({ policy: deployedPolicy });
    const created = (await h.call('google_docs.create', { title: 'Weekly', content: 'Week 1' }))
      .structuredContent!;
    const id = created.document_id as string;

    const append = await h.call('google_docs.append', {
      document_id: id,
      content: 'Week 2',
      separator: 'double_newline',
    });
    expect(append.structuredContent).toMatchObject({ success: true });
    expect(h.docs.tabText(id, 't.0')).toBe('Week 1\n\nWeek 2\n');
    expect((await h.call('google_docs.get_metadata', { document_id: id })).structuredContent).toMatchObject({
      success: true,
      title: 'Weekly',
    });

    // A pre-existing document the server did not create is off-limits.
    for (const [tool, args] of [
      ['google_docs.append', { document_id: DOC_ID, content: 'x' }],
      ['google_docs.get_metadata', { document_id: DOC_ID }],
    ] as const) {
      expect((await h.call(tool, args)).structuredContent).toMatchObject({
        error: { code: 'POLICY_BLOCKED' },
      });
    }
    expect(h.docs.tabText(DOC_ID, 't.0')).toBe('Existing paragraph.\n');
  });

  it('still allows documents listed explicitly in allowedDocumentIds', async () => {
    const googleDocs = { ...(deployedPolicy.googleDocs as object), allowedDocumentIds: [DOC_ID] };
    h = await createHarness({ policy: { ...deployedPolicy, googleDocs } });
    expect((await h.call('google_docs.append', { document_id: DOC_ID, content: 'ok' })).isError).toBeFalsy();
  });

  it('records created documents per user', async () => {
    h = await createHarness({ policy: deployedPolicy });
    const id = (await h.call('google_docs.create', { title: 'Mine' })).structuredContent!
      .document_id as string;
    expect(await h.deps.createdDocs.has('default', id)).toBe(true);
    expect(await h.deps.createdDocs.has('someone-else', id)).toBe(false);
  });

  it('never creates a duplicate for the same idempotency key or an identical immediate repeat', async () => {
    h = await createHarness({ policy: deployedPolicy });
    const args = { title: 'XYZ', content: 'TBS', idempotency_key: 'create-xyz-0002' };
    const first = await h.call('google_docs.create', args);
    const second = await h.call('google_docs.create', args);
    expect(second.structuredContent).toMatchObject({
      idempotent_replay: true,
      document_id: first.structuredContent!.document_id,
    });

    await h.call('google_docs.create', { title: 'No key' });
    expect((await h.call('google_docs.create', { title: 'No key' })).structuredContent).toMatchObject({
      error: { code: 'DUPLICATE_REQUEST' },
    });
    expect(h.docs.created).toHaveLength(2);
  });

  it('reports the document id when content insertion fails, and the agent can append instead', async () => {
    h = await createHarness({ policy: deployedPolicy });
    h.docs.updateFailures.push({ error: new AppError('DOCUMENT_ACCESS_DENIED', 'denied') });
    const args = { title: 'XYZ', content: 'TBS', idempotency_key: 'create-xyz-0003' };
    const r = await h.call('google_docs.create', args);
    expect(r.structuredContent).toMatchObject({
      error: { code: 'DOCUMENT_ACCESS_DENIED', retryable: false },
    });
    expect(r.structuredContent!.error.message).toMatch(/was created.*call google_docs.append/);
    const id = r.structuredContent!.error.details.document_id as string;
    expect(id).toBe(h.docs.created[0]!.documentId);

    // Retrying the create cannot make a second document...
    expect((await h.call('google_docs.create', args)).structuredContent).toMatchObject({
      error: { code: 'DUPLICATE_REQUEST' },
    });
    expect(h.docs.created).toHaveLength(1);
    // ...and the recovery path works because the document is registered as server-created.
    expect(
      (await h.call('google_docs.append', { document_id: id, content: 'TBS', separator: 'none' })).isError,
    ).toBeFalsy();
    expect(h.docs.tabText(id, 't.0')).toBe('TBS\n');
  });

  it('does not auto-retry an ambiguous create failure', async () => {
    h = await createHarness({ policy: deployedPolicy });
    h.docs.createFailures.push(
      new AppError('GOOGLE_API_ERROR', 'Google API temporarily unavailable (HTTP 503).', { retryable: true }),
    );
    const r = await h.call('google_docs.create', { title: 'XYZ', idempotency_key: 'create-xyz-0004' });
    expect(r.structuredContent).toMatchObject({ error: { code: 'GOOGLE_API_ERROR', retryable: false } });
    expect(r.structuredContent!.error.message).toMatch(/may or may not have been created/);
    expect(h.docs.created).toHaveLength(0);
  });

  it.each([
    [{ title: '' }, 'INVALID_INPUT'],
    [{ title: 'a\nb' }, 'INVALID_INPUT'],
    [{ title: 'ok', content: '   ' }, 'INVALID_INPUT'],
  ])('rejects %o', async (args, code) => {
    h = await createHarness({ policy: deployedPolicy });
    expect((await h.call('google_docs.create', args)).structuredContent).toMatchObject({ error: { code } });
    expect(h.docs.created).toHaveLength(0);
  });

  it('applies the append size cap to initial content and the confirmation policy when enabled', async () => {
    h = await createHarness({
      policy: { googleDocs: { create: true, maxAppendBytes: 5, requireConfirmation: true } },
    });
    expect(
      (await h.call('google_docs.create', { title: 't', content: '123456' })).structuredContent,
    ).toMatchObject({
      error: { code: 'POLICY_BLOCKED' },
    });
    const r = await h.call('google_docs.create', { title: 't', content: '12345' });
    expect(r.structuredContent).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(r.structuredContent!.error.details.summary).toContain('Create a new Google Doc titled "t"');
    expect(h.docs.created).toHaveLength(0);
  });

  it('reports the create policy in connection status', async () => {
    h = await createHarness({ policy: deployedPolicy });
    expect((await h.call('connection.get_status')).structuredContent!.policy).toMatchObject({
      docs_create_enabled: true,
      docs_restricted_to_created_documents: true,
    });
  });
});

describe('CreatedDocsRegistry implementations', () => {
  it('file registry persists across instances', async () => {
    const dir = tempDir();
    await new FileCreatedDocsRegistry(dir).add('default', 'doc1');
    const again = new FileCreatedDocsRegistry(dir);
    expect(await again.has('default', 'doc1')).toBe(true);
    expect(await again.has('other', 'doc1')).toBe(false);
  });

  it('KV registry is shared through the store', async () => {
    const kv = new MemoryKvStore();
    await new KvCreatedDocsRegistry(kv).add('alice', 'doc1');
    expect(await new KvCreatedDocsRegistry(kv).has('alice', 'doc1')).toBe(true);
    expect(await new KvCreatedDocsRegistry(kv).has('bob', 'doc1')).toBe(false);
  });
});
