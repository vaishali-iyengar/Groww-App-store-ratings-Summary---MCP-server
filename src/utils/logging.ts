import { createHash } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/**
 * Field names whose values are never written to logs (§27): credentials and
 * user content. Matching is case-insensitive on the key name.
 */
const SENSITIVE_KEY =
  /(token|secret|password|authorization|credential|cookie|api[_-]?key|^body$|^content$|^raw$|html|custom_separator|heading)/i;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[DEPTH]';
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value instanceof Error) {
    // Stack traces stay in internal logs only; message is kept, never the cause chain's request config.
    return { name: value.name, message: value.message };
  }
  if (value && typeof value === 'object') {
    const out: Fields = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Logs structured JSON lines to stderr. stdout is reserved for the stdio MCP
 * transport, so nothing in this server may write there.
 */
export function createLogger(
  level: LogLevel | 'silent' = 'info',
  base: Fields = {},
  sink: (line: string) => void = (line) => process.stderr.write(line + '\n'),
): Logger {
  const threshold = LEVEL_ORDER[level];
  const write = (lvl: LogLevel, msg: string, fields?: Fields) => {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const record = { level: lvl, timestamp: new Date().toISOString(), msg, ...base, ...(fields ?? {}) };
    sink(JSON.stringify(redactValue(record)));
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }, sink),
  };
}

/** Privacy-preserving representation of an email address for logs and audit records (§27). */
export function redactEmail(email: string, mode: 'hash' | 'mask' | 'plain'): string {
  if (mode === 'plain') return email;
  const at = email.lastIndexOf('@');
  const local = at >= 0 ? email.slice(0, at) : email;
  const domain = at >= 0 ? email.slice(at + 1) : '';
  if (mode === 'mask') return `${local.slice(0, 1)}***@${domain}`;
  const digest = createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12);
  return `sha256:${digest}@${domain}`;
}
