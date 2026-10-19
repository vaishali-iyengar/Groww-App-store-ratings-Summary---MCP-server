type Labels = Record<string, string>;

function key(name: string, labels: Labels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]!.replace(/["\\\n]/g, '_')}"`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
}

/**
 * Minimal in-process metrics registry rendering Prometheus text format (§28).
 * Latencies are exported as `_sum` / `_count` pairs (average = sum / count).
 */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly summaries = new Map<string, { sum: number; count: number }>();
  private readonly help = new Map<string, string>();

  constructor() {
    this.describe('mcp_tool_calls_total', 'Tool calls by tool and outcome');
    this.describe('mcp_tool_errors_total', 'Tool errors by tool and error code');
    this.describe('mcp_tool_latency_ms', 'Tool call latency in milliseconds');
    this.describe('google_api_latency_ms', 'Google API call latency in milliseconds');
    this.describe('google_api_retries_total', 'Retries of Google API calls');
    this.describe('idempotency_events_total', 'Duplicate / replay events');
    this.describe('gmail_emails_sent_total', 'Emails sent');
    this.describe('docs_appends_total', 'Document append operations');
    this.describe('docs_creates_total', 'Documents created');
  }

  private describe(name: string, text: string): void {
    this.help.set(name, text);
  }

  inc(name: string, labels: Labels = {}, by = 1): void {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const k = key(name, labels);
    const s = this.summaries.get(k) ?? { sum: 0, count: 0 };
    s.sum += value;
    s.count += 1;
    this.summaries.set(k, s);
  }

  /** Times an async operation into `name`. */
  async time<T>(name: string, labels: Labels, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.observe(name, performance.now() - start, labels);
    }
  }

  get(name: string, labels: Labels = {}): number {
    return this.counters.get(key(name, labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    const typed = new Set<string>();
    const header = (name: string, type: string) => {
      if (typed.has(name)) return;
      typed.add(name);
      const h = this.help.get(name);
      if (h) lines.push(`# HELP ${name} ${h}`);
      lines.push(`# TYPE ${name} ${type}`);
    };
    for (const [k, v] of [...this.counters].sort()) {
      header(k.split('{')[0]!, 'counter');
      lines.push(`${k} ${v}`);
    }
    for (const [k, s] of [...this.summaries].sort()) {
      const [name, rest] = k.includes('{') ? [k.slice(0, k.indexOf('{')), k.slice(k.indexOf('{'))] : [k, ''];
      header(name, 'summary');
      lines.push(`${name}_sum${rest} ${s.sum.toFixed(3)}`, `${name}_count${rest} ${s.count}`);
    }
    return lines.join('\n') + '\n';
  }
}
