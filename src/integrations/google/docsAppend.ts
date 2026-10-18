import type { docs_v1 } from '@googleapis/docs';
import { AppError } from '../../errors/appError.js';

export type Separator = 'none' | 'newline' | 'double_newline' | 'custom';

export interface TabInfo {
  tab_id: string;
  title: string;
  index: number;
  nesting_level: number;
  parent_tab_id?: string;
}

/** Flattens the (possibly nested) tab tree in document order. */
export function flattenTabs(doc: docs_v1.Schema$Document): TabInfo[] {
  const out: TabInfo[] = [];
  const walk = (tabs: docs_v1.Schema$Tab[] | undefined) => {
    for (const tab of tabs ?? []) {
      const p = tab.tabProperties ?? {};
      if (p.tabId) {
        out.push({
          tab_id: p.tabId,
          title: p.title ?? '',
          index: p.index ?? 0,
          nesting_level: p.nestingLevel ?? 0,
          ...(p.parentTabId ? { parent_tab_id: p.parentTabId } : {}),
        });
      }
      walk(tab.childTabs ?? undefined);
    }
  };
  walk(doc.tabs ?? undefined);
  return out;
}

function findTab(tabs: docs_v1.Schema$Tab[] | undefined, tabId: string): docs_v1.Schema$Tab | undefined {
  for (const tab of tabs ?? []) {
    if (tab.tabProperties?.tabId === tabId) return tab;
    const child = findTab(tab.childTabs ?? undefined, tabId);
    if (child) return child;
  }
  return undefined;
}

export interface AppendLocation {
  /** The tab that will receive the text; undefined for legacy single-body documents. */
  tabId: string | undefined;
  /** Location for an `insertText` request: the end of the tab's body segment. */
  endOfSegmentLocation: docs_v1.Schema$EndOfSegmentLocation;
  /** Body of the target segment (used to detect empty documents and verify ambiguous retries). */
  body: docs_v1.Schema$Body | undefined;
}

/**
 * Determines where an append goes (§20). Never guesses: an unknown tab_id is
 * an error rather than a silent fallback to another tab.
 * - tab_id given: that tab (searching nested child tabs).
 * - no tab_id: the first tab, or the legacy `body` for documents fetched without tabs.
 */
export function resolveAppendLocation(doc: docs_v1.Schema$Document, tabId?: string): AppendLocation {
  const tabs = doc.tabs ?? undefined;
  if (tabs && tabs.length > 0) {
    const tab = tabId ? findTab(tabs, tabId) : tabs[0];
    if (!tab) {
      throw new AppError('INVALID_DOCUMENT', `Tab "${tabId}" does not exist in this document.`, {
        details: { available_tab_ids: flattenTabs(doc).map((t) => t.tab_id) },
      });
    }
    const resolvedId = tab.tabProperties?.tabId ?? undefined;
    if (!tab.documentTab) {
      throw new AppError(
        'INVALID_DOCUMENT',
        `Tab "${resolvedId}" is not a document tab and cannot receive text.`,
      );
    }
    return {
      tabId: resolvedId,
      endOfSegmentLocation: resolvedId ? { tabId: resolvedId } : {},
      body: tab.documentTab.body ?? undefined,
    };
  }
  if (tabId) {
    throw new AppError('INVALID_DOCUMENT', `Tab "${tabId}" does not exist in this document.`);
  }
  return { tabId: undefined, endOfSegmentLocation: {}, body: doc.body ?? undefined };
}

/** Plain text of a body segment (paragraph text runs; tables and other structures are skipped). */
export function segmentText(body: docs_v1.Schema$Body | undefined): string {
  let text = '';
  for (const el of body?.content ?? []) {
    for (const pe of el.paragraph?.elements ?? []) text += pe.textRun?.content ?? '';
  }
  return text;
}

export interface AppendTextInput {
  content: string;
  heading?: string | undefined;
  separator?: Separator | undefined;
  customSeparator?: string | undefined;
  timestamp?: boolean | undefined;
  /** Skip the leading separator when the target segment is empty. */
  segmentIsEmpty?: boolean;
  now?: Date;
  timeZone?: string;
}

/** Removes control characters the Docs API rejects; keeps \n and \t. Normalizes CRLF. */
export function sanitizeDocText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''); // eslint-disable-line no-control-regex
}

export function formatTimestamp(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')} (${timeZone})`;
}

/**
 * Builds the text inserted at the end of the document (§21):
 *
 *   [separator][timestamp line][heading line][content]
 *
 * The separator precedes the block so it never runs into the document's
 * existing last paragraph. `custom` separators are inserted verbatim.
 */
export function buildAppendText(input: AppendTextInput): string {
  const separator = input.separator ?? 'newline';
  let sep = '';
  if (!input.segmentIsEmpty) {
    if (separator === 'newline') sep = '\n';
    else if (separator === 'double_newline') sep = '\n\n';
    else if (separator === 'custom') sep = input.customSeparator ?? '';
  }

  const lines: string[] = [];
  const heading = input.heading?.trim();
  if (input.timestamp) {
    const ts = formatTimestamp(input.now ?? new Date(), input.timeZone ?? 'UTC');
    lines.push(heading ? `${heading} — ${ts}` : ts);
  } else if (heading) {
    lines.push(heading);
  }
  const header = lines.length ? lines.join('\n') + '\n' : '';
  return sanitizeDocText(sep + header + input.content);
}
