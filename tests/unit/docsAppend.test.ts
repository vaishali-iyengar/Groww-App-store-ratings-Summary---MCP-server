import type { docs_v1 } from '@googleapis/docs';
import { describe, expect, it } from 'vitest';
import {
  buildAppendText,
  flattenTabs,
  formatTimestamp,
  resolveAppendLocation,
  sanitizeDocText,
  segmentText,
} from '../../src/integrations/google/docsAppend.js';

const body = (text: string): docs_v1.Schema$Body => ({
  content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }],
});

const tabbedDoc: docs_v1.Schema$Document = {
  title: 'T',
  tabs: [
    { tabProperties: { tabId: 't.0', title: 'First', index: 0 }, documentTab: { body: body('one\n') } },
    {
      tabProperties: { tabId: 't.1', title: 'Second', index: 1 },
      documentTab: { body: body('two\n') },
      childTabs: [
        {
          tabProperties: { tabId: 't.2', title: 'Child', index: 0, nestingLevel: 1, parentTabId: 't.1' },
          documentTab: { body: body('child\n') },
        },
      ],
    },
  ],
};

describe('resolveAppendLocation', () => {
  it('defaults to the first tab', () => {
    const loc = resolveAppendLocation(tabbedDoc);
    expect(loc.tabId).toBe('t.0');
    expect(loc.endOfSegmentLocation).toEqual({ tabId: 't.0' });
    expect(segmentText(loc.body)).toBe('one\n');
  });

  it('targets a nested child tab', () => {
    const loc = resolveAppendLocation(tabbedDoc, 't.2');
    expect(loc.endOfSegmentLocation).toEqual({ tabId: 't.2' });
    expect(segmentText(loc.body)).toBe('child\n');
  });

  it('rejects an unknown tab instead of guessing, listing valid tabs', () => {
    expect(() => resolveAppendLocation(tabbedDoc, 't.9')).toThrowError(
      expect.objectContaining({
        code: 'INVALID_DOCUMENT',
        details: { available_tab_ids: ['t.0', 't.1', 't.2'] },
      }),
    );
  });

  it('uses the legacy body for documents without tabs', () => {
    const loc = resolveAppendLocation({ body: body('legacy\n') });
    expect(loc.tabId).toBeUndefined();
    expect(loc.endOfSegmentLocation).toEqual({});
    expect(() => resolveAppendLocation({ body: body('x\n') }, 't.0')).toThrowError(
      expect.objectContaining({ code: 'INVALID_DOCUMENT' }),
    );
  });

  it('rejects tabs that are not document tabs', () => {
    expect(() => resolveAppendLocation({ tabs: [{ tabProperties: { tabId: 'x' } }] })).toThrowError(
      expect.objectContaining({ code: 'INVALID_DOCUMENT' }),
    );
  });
});

describe('flattenTabs', () => {
  it('lists nested tabs in document order', () => {
    expect(flattenTabs(tabbedDoc)).toEqual([
      { tab_id: 't.0', title: 'First', index: 0, nesting_level: 0 },
      { tab_id: 't.1', title: 'Second', index: 1, nesting_level: 0 },
      { tab_id: 't.2', title: 'Child', index: 0, nesting_level: 1, parent_tab_id: 't.1' },
    ]);
  });
});

describe('buildAppendText', () => {
  it.each([
    ['none', '', 'Body'],
    ['newline', '\n', '\nBody'],
    ['double_newline', '\n\n', '\n\nBody'],
  ] as const)('separator %s', (separator, _sep, expected) => {
    expect(buildAppendText({ content: 'Body', separator })).toBe(expected);
  });

  it('defaults to a newline separator', () => expect(buildAppendText({ content: 'Body' })).toBe('\nBody'));

  it('inserts custom separators verbatim', () => {
    expect(buildAppendText({ content: 'Body', separator: 'custom', customSeparator: '\n---\n' })).toBe(
      '\n---\nBody',
    );
  });

  it('places the heading on its own line after the separator', () => {
    expect(
      buildAppendText({ content: 'Discussed Q4.', heading: 'Meeting Notes', separator: 'double_newline' }),
    ).toBe('\n\nMeeting Notes\nDiscussed Q4.');
  });

  it('adds a timestamp to the heading line, or on its own line', () => {
    const now = new Date('2026-10-04T10:05:00Z');
    expect(buildAppendText({ content: 'C', heading: 'H', timestamp: true, now, timeZone: 'UTC' })).toBe(
      '\nH — 2026-10-04 10:05 (UTC)\nC',
    );
    expect(
      buildAppendText({ content: 'C', timestamp: true, now, timeZone: 'Asia/Kolkata', separator: 'none' }),
    ).toBe('2026-10-04 15:35 (Asia/Kolkata)\nC');
  });

  it('skips the separator for an empty document', () => {
    expect(buildAppendText({ content: 'First', separator: 'double_newline', segmentIsEmpty: true })).toBe(
      'First',
    );
  });

  it('normalizes CRLF and strips control characters', () => {
    expect(sanitizeDocText('a\r\nb\u0000c\u0007d\te')).toBe('a\nbcd\te');
  });
});

describe('formatTimestamp', () => {
  it('formats midnight as 00, not 24', () => {
    expect(formatTimestamp(new Date('2026-10-04T00:00:00Z'), 'UTC')).toBe('2026-10-04 00:00 (UTC)');
  });
});
