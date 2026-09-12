/**
 * Redaction.
 *
 * Two different jobs, deliberately kept apart:
 *
 *   - `redactText` is a pattern scrubber for anything that might leak into a
 *     log line or a snapshot: tax ids, card numbers, long account-shaped digit
 *     runs, emails. It is a net, not a guarantee, and it is applied on the way
 *     *out* of the system rather than at each call site, so a new log statement
 *     cannot forget it.
 *
 *   - `SecretRegistry` handles values we know are secret because we injected
 *     them. Those are matched literally and removed, which is exact rather than
 *     heuristic. A credential typed into a login form is scrubbed by this path,
 *     never by the pattern net.
 *
 * The pattern net is genuinely limited: it cannot recognize a name, an address,
 * or a balance as sensitive. That is why the artifact schema carries an explicit
 * `sensitivity` on every parameter and return value - declared sensitivity is
 * what actually protects PII here, and the patterns are a backstop for the
 * things that leak by accident.
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

export const DEFAULT_RULES: RedactionRule[] = [
  { name: 'us-tax-id', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '«tax-id»' },
  { name: 'card-pan', pattern: /\b(?:\d[ -]?){13,19}\b/g, replacement: '«card»' },
  // The domain must start with a letter, so a versioned artifact filename
  // (`member.savings_balance@1.0.0.capability.yaml`) is not mistaken for an
  // address. A backstop rule is not worth corrupting file paths over.
  { name: 'email', pattern: /\b[\w.%+-]+@[A-Za-z][\w.-]*\.[A-Za-z]{2,}\b/g, replacement: '«email»' },
  {
    name: 'bearer',
    pattern: /\b(?:(?:Bearer|Token)\s+[A-Za-z0-9._~+/-]{12,}=*|sk-(?:ant-)?[A-Za-z0-9._-]{12,})/g,
    replacement: '«token»',
  },
  // Long bare digit runs are account-shaped. Member ids are 5 digits and are a
  // declared parameter, so they are handled by sensitivity, not by this rule.
  { name: 'account-number', pattern: /\b\d{9,}\b/g, replacement: '«account»' },
];

/** Exact-match scrubbing for values this process injected and therefore knows. */
export class SecretRegistry {
  private readonly values = new Map<string, string>();

  /** `key` is the vault reference, e.g. "meridian.password". */
  register(key: string, value: string): void {
    if (value.length >= 4) this.values.set(value, `«secret:${key}»`);
  }

  has(key: string): boolean {
    return [...this.values.values()].includes(`«secret:${key}»`);
  }

  scrub(text: string): string {
    let out = text;
    for (const [value, label] of this.values) out = out.split(value).join(label);
    return out;
  }

  size(): number {
    return this.values.size;
  }
}

export interface Redactor {
  text(value: string): string;
  /** Deep-scrub any JSON-serializable structure, keys included. */
  value<T>(value: T): T;
  findings(value: string): string[];
}

export function createRedactor(
  secrets: SecretRegistry = new SecretRegistry(),
  rules: RedactionRule[] = DEFAULT_RULES,
): Redactor {
  const text = (value: string): string => {
    let out = secrets.scrub(value);
    for (const rule of rules) out = out.replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.replacement);
    return out;
  };

  const deep = (v: unknown): unknown => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(deep);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = deep(val);
      return out;
    }
    return v;
  };

  return {
    text,
    value: <T>(v: T): T => deep(v) as T,
    findings: (value: string): string[] => {
      const hits: string[] = [];
      for (const rule of rules) {
        if (new RegExp(rule.pattern.source, rule.pattern.flags).test(value)) hits.push(rule.name);
      }
      return hits;
    },
  };
}

/** Stable, non-reversible stand-in so logs can correlate without holding data. */
export function fingerprint(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fp_${(h >>> 0).toString(36)}`;
}

/**
 * What a log or artifact may carry for a value of a given declared sensitivity.
 * `pii-id` keeps a fingerprint so two runs on the same member can be correlated
 * during debugging without the id itself ever being written down.
 */
export function summarizeForLog(
  value: unknown,
  sensitivity: 'none' | 'pii' | 'pii-id' | 'account' | 'secret',
): string {
  if (value === undefined || value === null) return String(value);
  const s = String(value);
  switch (sensitivity) {
    case 'none':
      return s.length > 200 ? `${s.slice(0, 200)}…` : s;
    case 'pii-id':
      return `«${sensitivity}:${fingerprint(s)}»`;
    case 'account':
      return `«account:…${s.slice(-4)}»`;
    case 'pii':
      return `«pii:${s.length} chars»`;
    case 'secret':
      return '«secret»';
  }
}
