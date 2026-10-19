import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';
import { WEEKLY_NOTE_MAX_CHARS, weekStart } from '../../src/server/prompts/weeklyNote.js';
import { createHarness, DOC_ID, type Harness } from '../helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const deployedPolicy = JSON.parse(readFileSync('policy.json', 'utf8')) as Record<string, unknown>;

function promptText(result: { messages: { content: { type: string; text?: string } }[] }): string {
  return result.messages.map((m) => m.content.text ?? '').join('\n');
}

describe('weekStart', () => {
  it('returns the Monday of the current week in the configured zone', () => {
    expect(weekStart(new Date('2026-10-04T10:00:00Z'), 'UTC')).toBe('2026-09-28'); // Sunday
    expect(weekStart(new Date('2026-10-05T00:30:00Z'), 'UTC')).toBe('2026-10-05'); // Monday
    // 23:00 UTC Sunday is already Monday in Asia/Kolkata.
    expect(weekStart(new Date('2026-10-04T23:00:00Z'), 'Asia/Kolkata')).toBe('2026-10-05');
  });
});

describe('weekly_note prompt', () => {
  it('is discoverable by any MCP client', async () => {
    h = await createHarness();
    const { prompts } = await h.client.listPrompts();
    const weekly = prompts.find((p) => p.name === 'weekly_note');
    expect(weekly).toBeDefined();
    expect(weekly!.arguments?.map((a) => a.name).sort()).toEqual(['notes', 'recipient', 'week_of']);
    expect(JSON.stringify(weekly)).not.toMatch(/claude|anthropic|chatgpt|openai|gemini/i);
  });

  it('targets the configured recipient, the current week and a one-page plain-text note', async () => {
    h = await createHarness({ env: { WEEKLY_NOTE_RECIPIENT: 'vaishu1996@gmail.com' } });
    const text = promptText(
      await h.client.getPrompt({ name: 'weekly_note', arguments: { notes: 'Shipped the MCP server.' } }),
    );
    expect(text).toContain('week of 2026-09-28');
    expect(text).toContain('Send it to vaishu1996@gmail.com only.');
    expect(text).toContain('to: ["vaishu1996@gmail.com"]');
    expect(text).toContain('subject: "Weekly Note – Week of 2026-09-28"');
    expect(text).toContain('idempotency_key: "weekly-note-2026-09-28"');
    expect(text).toContain(`at most ${WEEKLY_NOTE_MAX_CHARS} characters`);
    expect(text).toContain('email it by calling gmail_send_email');
    expect(text).toMatch(/Do not save or send it before they approve/);
    // Without SUMMARY_DOC_ID there is no Google Docs step.
    expect(text).not.toContain('google_docs_append');
    expect(text).toContain('<notes>\nShipped the MCP server.\n</notes>');
  });

  it('uses dotted tool names when configured, and asks for a recipient when none is configured', async () => {
    h = await createHarness({ env: { TOOL_NAME_STYLE: 'dotted' } });
    const text = promptText(
      await h.client.getPrompt({ name: 'weekly_note', arguments: { week_of: '2026-10-12' } }),
    );
    expect(text).toContain('email it by calling gmail.send_email');
    expect(text).toContain('Weekly Note – Week of 2026-10-12');
    expect(text).toContain('Ask the user who should receive it before sending.');
  });
});

describe('weekly_note prompt with SUMMARY_DOC_ID', () => {
  it('appends to the configured Doc with a dated heading before emailing', async () => {
    h = await createHarness({
      env: {
        WEEKLY_NOTE_RECIPIENT: 'vaishu1996@gmail.com',
        SUMMARY_DOC_ID: `https://docs.google.com/document/d/${DOC_ID}/edit`,
      },
    });
    const { prompts } = await h.client.listPrompts();
    expect(prompts.find((p) => p.name === 'weekly_note')!.description).toContain('google_docs_append');
    const text = promptText(await h.client.getPrompt({ name: 'weekly_note', arguments: {} }));
    expect(text).toContain(
      '2. After approval, add it to the weekly notes Google Doc by calling google_docs_append',
    );
    expect(text).toContain(`document_id: "${DOC_ID}"`);
    expect(text).toContain('heading: "Weekly Note – Week of 2026-09-28"');
    expect(text).toContain('separator: "double_newline"');
    expect(text).toContain('timestamp: true');
    expect(text).toContain('idempotency_key: "weekly-doc-2026-09-28"');
    expect(text).toContain('3. Then email it by calling gmail_send_email');
    expect(text.indexOf('google_docs_append')).toBeLessThan(text.indexOf('gmail_send_email'));
    expect(text).toMatch(/^5\. If one step fails/m);
  });

  it('adds the note to the end of the Doc without a confirmation step under the deployed policy', async () => {
    h = await createHarness({
      policy: {
        ...deployedPolicy,
        googleDocs: { ...(deployedPolicy.googleDocs as object), allowedDocumentIds: [DOC_ID] },
      },
    });
    const note = 'Highlights\n- Shipped the MCP server';
    const args = {
      document_id: DOC_ID,
      heading: 'Weekly Note – Week of 2026-09-28',
      content: note,
      separator: 'double_newline',
      timestamp: true,
      idempotency_key: 'weekly-doc-2026-09-28',
    };
    const r = await h.call('google_docs.append', args);
    expect(r.structuredContent).toMatchObject({ success: true, document_title: 'Product Notes' });
    expect(h.docs.tabText(DOC_ID, 't.0')).toBe(
      `Existing paragraph.\n\nWeekly Note – Week of 2026-09-28 — 2026-10-04 10:00 (UTC)\n${note}\n`,
    );
    // Re-running the same week's step does not add the entry twice.
    expect((await h.call('google_docs.append', args)).structuredContent).toMatchObject({
      idempotent_replay: true,
    });
    expect(h.docs.updates).toHaveLength(1);
    // The allowlist keeps every other document read-only for this server.
    h.docs.addDocument('1SomeOtherDocument00000000000', 'Other', [{ id: 't.0', title: 'T', text: '\n' }]);
    const other = await h.call('google_docs.append', {
      ...args,
      document_id: '1SomeOtherDocument00000000000',
      idempotency_key: 'other-doc-1',
    });
    expect(other.structuredContent).toMatchObject({ error: { code: 'POLICY_BLOCKED' } });
  });
});

describe('weekly note delivery under the deployed policy.json', () => {
  const note = (chars: number) => 'Highlights\n- ' + 'x'.repeat(chars - 14);
  const args = (body: string, extra: Record<string, unknown> = {}) => ({
    to: ['vaishu1996@gmail.com'],
    subject: 'Weekly Note – Week of 2026-09-28',
    body,
    content_type: 'text/plain',
    idempotency_key: 'weekly-note-2026-09-28',
    ...extra,
  });

  it('sends a one-page note to vaishu1996@gmail.com after confirmation, exactly once', async () => {
    h = await createHarness({ policy: deployedPolicy });
    const first = await h.call('gmail.send_email', args(note(WEEKLY_NOTE_MAX_CHARS)));
    expect(first.structuredContent).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(h.gmail.sent).toHaveLength(0);

    const token = first.structuredContent!.error.details.confirmation_token;
    const sent = await h.call(
      'gmail.send_email',
      args(note(WEEKLY_NOTE_MAX_CHARS), { confirmation_token: token }),
    );
    expect(sent.structuredContent).toMatchObject({ success: true, recipients: ['vaishu1996@gmail.com'] });
    expect(h.gmail.sent).toHaveLength(1);
    const mime = h.gmail.decoded();
    expect(mime).toContain('To: vaishu1996@gmail.com');
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');

    // A retry of the same week's note returns the original result instead of sending again.
    const again = await h.call('gmail.send_email', args(note(WEEKLY_NOTE_MAX_CHARS)));
    expect(again.structuredContent).toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
    const replay = await h.call(
      'gmail.send_email',
      args(note(WEEKLY_NOTE_MAX_CHARS), {
        confirmation_token: again.structuredContent!.error.details.confirmation_token,
      }),
    );
    expect(replay.structuredContent).toMatchObject({ idempotent_replay: true });
    expect(h.gmail.sent).toHaveLength(1);
  });

  it('rejects notes longer than the one-page cap and any other recipient', async () => {
    h = await createHarness({ policy: deployedPolicy });
    const tooLong = await h.call('gmail.send_email', args('x'.repeat(5001)));
    expect(tooLong.structuredContent).toMatchObject({
      error: { code: 'POLICY_BLOCKED', details: { max_body_bytes: 5000 } },
    });
    const other = await h.call('gmail.send_email', args(note(100), { to: ['someone.else@gmail.com'] }));
    expect(other.structuredContent).toMatchObject({ error: { code: 'POLICY_BLOCKED' } });
    const extraCc = await h.call('gmail.send_email', args(note(100), { cc: ['someone.else@gmail.com'] }));
    expect(extraCc.structuredContent).toMatchObject({ error: { code: 'POLICY_BLOCKED' } });
    expect(h.gmail.sent).toHaveLength(0);
  });
});

describe('SUMMARY_DOC_ID config', () => {
  it('accepts a document ID or URL and rejects anything else', () => {
    expect(loadConfig({}).summaryDocId).toBeUndefined();
    expect(loadConfig({ SUMMARY_DOC_ID: DOC_ID }).summaryDocId).toBe(DOC_ID);
    expect(
      loadConfig({ SUMMARY_DOC_ID: `https://docs.google.com/document/d/${DOC_ID}/edit` }).summaryDocId,
    ).toBe(DOC_ID);
    expect(() => loadConfig({ SUMMARY_DOC_ID: 'not a doc' })).toThrow(/SUMMARY_DOC_ID/);
  });
});

describe('WEEKLY_NOTE_RECIPIENT config', () => {
  it('is optional and must be a plain email address', () => {
    expect(loadConfig({}).weeklyNoteRecipient).toBeUndefined();
    expect(loadConfig({ WEEKLY_NOTE_RECIPIENT: ' vaishu1996@gmail.com ' }).weeklyNoteRecipient).toBe(
      'vaishu1996@gmail.com',
    );
    expect(() => loadConfig({ WEEKLY_NOTE_RECIPIENT: 'Vaishu <vaishu1996@gmail.com>' })).toThrow(
      /WEEKLY_NOTE_RECIPIENT/,
    );
  });
});
