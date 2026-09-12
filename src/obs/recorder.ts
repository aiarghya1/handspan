/**
 * Run evidence.
 *
 * Every run - discovery, replay, or a human takeover - writes one directory:
 *
 *   evidence/runs/<runId>/
 *     run.jsonl        ordered, structured events
 *     summary.json     the result contract, as returned to the caller
 *     screenshots/     one per step in discovery; on failure always
 *     snapshots/       frame HTML, captured on failure
 *
 * Redaction happens here rather than at the call sites. Every string that
 * reaches `event()` is scrubbed on the way to disk, so a new log statement
 * added later cannot leak a credential by forgetting to. That is the whole
 * reason the redactor is a property of the recorder and not a helper people
 * are expected to remember to call.
 *
 * Screenshots are a harder problem than text, because a member's tax id is
 * simply visible on the screen. The driver masks controls the policy flagged
 * as sensitive before encoding, which handles the fields we can identify; it
 * does not handle sensitive data rendered as free text. That limit is real and
 * is called out in the report rather than papered over.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Redactor } from '../policy/redact.js';
import { createRedactor, SecretRegistry } from '../policy/redact.js';
import type { Observation, SurfaceDriver } from '../surface/types.js';

export type EventKind =
  | 'run.start'
  | 'run.end'
  | 'observe'
  | 'model.decision'
  | 'action.request'
  | 'action.blocked'
  | 'action.done'
  | 'action.failed'
  | 'checkpoint.pass'
  | 'checkpoint.fail'
  | 'outcome.detected'
  | 'recovery.applied'
  | 'escalation.raised'
  | 'escalation.granted'
  | 'escalation.resumed'
  | 'operator.action'
  | 'policy.violation'
  | 'evidence.captured'
  | 'artifact.written'
  | 'note';

export interface RunEvent {
  seq: number;
  at: string;
  runId: string;
  kind: EventKind;
  [key: string]: unknown;
}

export interface RecorderOptions {
  runId?: string;
  root?: string;
  kind: 'discovery' | 'replay' | 'operator';
  /** Echoed to stderr as it happens; useful when watching a run. */
  verbose?: boolean;
}

export class RunRecorder {
  readonly runId: string;
  readonly dir: string;
  readonly secrets = new SecretRegistry();
  readonly redactor: Redactor;
  private seq = 0;
  private readonly logPath: string;
  private readonly verbose: boolean;

  constructor(opts: RecorderOptions) {
    this.runId = opts.runId ?? `${opts.kind}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
    this.dir = join(opts.root ?? 'evidence/runs', this.runId);
    this.verbose = opts.verbose ?? false;
    mkdirSync(join(this.dir, 'screenshots'), { recursive: true });
    mkdirSync(join(this.dir, 'snapshots'), { recursive: true });
    this.logPath = join(this.dir, 'run.jsonl');
    this.redactor = createRedactor(this.secrets);
  }

  event(kind: EventKind, fields: Record<string, unknown> = {}): RunEvent {
    // The envelope is written last on purpose. A caller that happens to pass a
    // field called `kind` must not be able to relabel the event, which is how
    // every operator action once ended up in the log labelled as a click.
    const e: RunEvent = {
      ...this.redactor.value(fields),
      seq: this.seq++,
      at: new Date().toISOString(),
      runId: this.runId,
      kind,
    };
    appendFileSync(this.logPath, `${JSON.stringify(e)}\n`, 'utf8');
    if (this.verbose) {
      const detail = Object.entries(e)
        .filter(([k]) => !['seq', 'at', 'runId', 'kind'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      process.stderr.write(`  [${String(e.seq).padStart(3, '0')}] ${kind} ${detail.slice(0, 400)}\n`);
    }
    return e;
  }

  /** Compact view of an observation: what was on screen, minus the noise. */
  summarizeObservation(obs: Observation): Record<string, unknown> {
    return {
      url: obs.url,
      title: obs.title,
      frames: obs.frames.map((f) => ({
        path: f.framePath.map((p) => p.name ?? `#${p.index}`).join('/') || 'top',
        url: f.url,
        alerts: f.alerts,
      })),
      controlCount: obs.controls.length,
      controls: obs.controls
        .slice(0, 60)
        .map((c) => `${c.role}:"${c.name}"${c.value !== undefined && c.value !== '' ? `=${c.value}` : ''}`),
    };
  }

  async captureEvidence(
    driver: SurfaceDriver,
    label: string,
    opts: { snapshot?: boolean } = {},
  ): Promise<{ screenshot?: string; snapshot?: string }> {
    const safe = label.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 60);
    const out: { screenshot?: string; snapshot?: string } = {};
    try {
      const png = await driver.screenshot({ maskSensitive: true });
      const p = join(this.dir, 'screenshots', `${String(this.seq).padStart(3, '0')}-${safe}.png`);
      writeFileSync(p, png);
      out.screenshot = p;
    } catch (err) {
      this.event('note', { note: 'screenshot failed', error: String(err) });
    }
    if (opts.snapshot) {
      try {
        const html = await driver.structureSnapshot();
        const p = join(this.dir, 'snapshots', `${String(this.seq).padStart(3, '0')}-${safe}.html`);
        writeFileSync(p, this.redactor.text(html), 'utf8');
        out.snapshot = p;
      } catch (err) {
        this.event('note', { note: 'snapshot failed', error: String(err) });
      }
    }
    this.event('evidence.captured', { label, ...out });
    return out;
  }

  writeSummary(summary: unknown): string {
    const p = join(this.dir, 'summary.json');
    writeFileSync(p, JSON.stringify(this.redactor.value(summary), null, 2), 'utf8');
    return p;
  }

  writeFile(name: string, contents: string): string {
    const p = join(this.dir, name);
    writeFileSync(p, contents, 'utf8');
    return p;
  }
}
