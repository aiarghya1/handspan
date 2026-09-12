/**
 * Argument parsing.
 *
 * Deliberately tiny and dependency-free. It supports `--flag`, `--flag value`
 * and `--flag=value`, and - because `--input k=v` may legitimately repeat -
 * `repeated()` reads every occurrence of a flag rather than the last.
 */

export interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
  /** The raw argv, so repeated flags can be recovered. */
  argv: string[];
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[a.slice(2)] = next;
      i++;
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return { positional, flags, argv };
}

export const str = (a: Args, k: string, d?: string): string | undefined =>
  typeof a.flags[k] === 'string' ? (a.flags[k] as string) : d;

export const num = (a: Args, k: string, d?: number): number | undefined => {
  const v = a.flags[k];
  return typeof v === 'string' ? Number(v) : d;
};

export const bool = (a: Args, k: string): boolean => a.flags[k] === true || a.flags[k] === 'true';

/** Every `--k=v` / `--k v` occurrence of one flag, collected into a map. */
export function repeatedPairs(a: Args, flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const long = `--${flag}=`;
  for (let i = 0; i < a.argv.length; i++) {
    const token = a.argv[i]!;
    const pair = token.startsWith(long) ? token.slice(long.length) : token === `--${flag}` ? a.argv[++i] : undefined;
    if (pair === undefined) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}
