/**
 * Output and exit, as injected dependencies.
 *
 * The commands in this directory are functions that take arguments and return
 * an exit code. They never touch `process` directly, which is what makes them
 * testable at all - and, less obviously, what keeps `--json` output separable
 * from the human-readable progress narration.
 *
 * The one place that does read `process.argv` and call `process.exit` is
 * `bin/handspan.ts`, which contains no logic.
 */

export interface Io {
  /** Machine-readable result. One JSON document per invocation. */
  out(text: string): void;
  /** Human-readable progress and diagnostics. */
  err(text: string): void;
}

export const consoleIo: Io = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

/** Collects output instead of writing it, for tests. */
export function captureIo(): Io & { stdout: string; stderr: string } {
  const sink = {
    stdout: '',
    stderr: '',
    out(text: string) {
      sink.stdout += text;
    },
    err(text: string) {
      sink.stderr += text;
    },
  };
  return sink;
}

/** Exit codes the commands agree on, so a caller can branch without parsing. */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  escalated: 3,
} as const;
