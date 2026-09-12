/**
 * The run recorder.
 *
 * Redaction happens here rather than at the call sites, so the tests that
 * matter are the ones proving a credential cannot reach disk however it is
 * passed in, and that a caller cannot accidentally relabel an event.
 */

import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunRecorder } from '../src/obs/recorder.js';
import { FakeDriver } from './fake-driver.js';

const root = () => mkdtempSync(`${tmpdir()}/handspan-rec-`);
const events = (r: RunRecorder) =>
  readFileSync(join(r.dir, 'run.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('the run directory', () => {
  it('creates its own directory tree, named after the run', () => {
    const r = new RunRecorder({ kind: 'discovery', root: root() });
    expect(r.runId).toMatch(/^discovery-/);
    expect(existsSync(join(r.dir, 'screenshots'))).toBe(true);
    expect(existsSync(join(r.dir, 'snapshots'))).toBe(true);
  });

  it('honours a run id the caller supplies', () => {
    const r = new RunRecorder({ kind: 'replay', root: root(), runId: 'fixed-id' });
    expect(r.runId).toBe('fixed-id');
    expect(r.dir.endsWith('fixed-id')).toBe(true);
  });

  it('defaults to evidence/runs when no root is given', () => {
    // Constructed but not written to, so the default path is only derived.
    const r = new RunRecorder({ kind: 'replay', runId: `unit-${Date.now()}` });
    expect(r.dir.startsWith('evidence/runs/')).toBe(true);
  });
});

describe('events', () => {
  it('numbers them in order and stamps the run', () => {
    const r = new RunRecorder({ kind: 'replay', root: root() });
    r.event('run.start', { mode: 'replay' });
    r.event('note', { note: 'second' });
    const log = events(r);
    expect(log.map((e) => e.seq)).toEqual([0, 1]);
    expect(log[0]).toMatchObject({ kind: 'run.start', runId: r.runId, mode: 'replay' });
  });

  it('will not let a field called kind relabel the event', () => {
    // A regression: an operator action carried its own `kind`, which overwrote
    // the event kind and made every manual step look like a bare click.
    const r = new RunRecorder({ kind: 'replay', root: root() });
    r.event('operator.action', { kind: 'click', seq: 99, runId: 'spoofed' });
    expect(events(r)[0]).toMatchObject({ kind: 'operator.action', seq: 0, runId: r.runId });
  });

  it('scrubs a registered credential wherever it appears', () => {
    const r = new RunRecorder({ kind: 'discovery', root: root() });
    r.secrets.register('meridian.password', 'demo-pass-not-real');
    r.event('note', { typed: 'demo-pass-not-real', nested: { also: ['demo-pass-not-real'] } });
    const raw = readFileSync(join(r.dir, 'run.jsonl'), 'utf8');
    expect(raw).not.toContain('demo-pass-not-real');
    expect(raw).toContain('«secret:meridian.password»');
  });

  it('scrubs pattern-matched data too', () => {
    const r = new RunRecorder({ kind: 'replay', root: root() });
    r.event('note', { text: 'Tax ID 412-88-0031' });
    expect(readFileSync(join(r.dir, 'run.jsonl'), 'utf8')).toContain('«tax-id»');
  });

  it('echoes to stderr only when asked to', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      new RunRecorder({ kind: 'replay', root: root() }).event('note', { note: 'quiet' });
      expect(write).not.toHaveBeenCalled();
      new RunRecorder({ kind: 'replay', root: root(), verbose: true }).event('note', { note: 'loud', n: 1 });
      expect(write).toHaveBeenCalledOnce();
      expect(String(write.mock.calls[0]![0])).toContain('note note=loud n=1');
    } finally {
      write.mockRestore();
    }
  });
});

describe('summarizing an observation', () => {
  it('keeps what is diagnostic and drops the rest', async () => {
    const r = new RunRecorder({ kind: 'replay', root: root() });
    const driver = new FakeDriver(
      {
        a: {
          url: 'http://app.test/',
          title: 'Home',
          alerts: ['No member found for 99999.'],
          controls: [
            { role: 'button', name: 'Retrieve' },
            { role: 'cell', name: 'Balance', value: '4182.55' },
          ],
        },
      },
      {},
      'a',
    );
    const summary = r.summarizeObservation(await driver.observe());
    expect(summary).toMatchObject({ url: 'http://app.test/', title: 'Home', controlCount: 2 });
    expect(summary['controls']).toEqual(['button:"Retrieve"', 'cell:"Balance"=4182.55']);
    expect((summary['frames'] as Array<{ path: string; alerts: string[] }>)[0]).toMatchObject({ path: 'top' });
  });

  it('caps how many controls it records', async () => {
    const r = new RunRecorder({ kind: 'replay', root: root() });
    const controls = Array.from({ length: 90 }, (_, i) => ({ role: 'cell' as const, name: `c${i}`, value: String(i) }));
    const driver = new FakeDriver({ a: { url: 'u', controls } }, {}, 'a');
    const summary = r.summarizeObservation(await driver.observe());
    expect((summary['controls'] as string[]).length).toBe(60);
    expect(summary['controlCount']).toBe(90);
  });
});

describe('evidence capture', () => {
  const driver = () => new FakeDriver({ a: { url: 'http://app.test/', controls: [] } }, {}, 'a');

  it('writes a screenshot, and a snapshot only when asked', async () => {
    const r = new RunRecorder({ kind: 'replay', root: root() });
    const shot = await r.captureEvidence(driver(), 'step one');
    expect(shot.screenshot).toContain('step_one.png');
    expect(shot.snapshot).toBeUndefined();

    const both = await r.captureEvidence(driver(), 'fail/s012', { snapshot: true });
    expect(both.snapshot).toContain('fail_s012.html');
    expect(existsSync(both.snapshot!)).toBe(true);
  });

  it('redacts the snapshot it writes', async () => {
    const r = new RunRecorder({ kind: 'replay', root: root() });
    const d = driver();
    d.structureSnapshot = async () => '<td>412-88-0031</td>';
    const out = await r.captureEvidence(d, 'detail', { snapshot: true });
    expect(readFileSync(out.snapshot!, 'utf8')).toBe('<td>«tax-id»</td>');
  });

  it('records the failure and carries on when a screenshot cannot be taken', async () => {
    const r = new RunRecorder({ kind: 'replay', root: root() });
    const d = driver();
    d.screenshot = async () => {
      throw new Error('the page is gone');
    };
    d.structureSnapshot = async () => {
      throw new Error('no frames');
    };
    const out = await r.captureEvidence(d, 'broken', { snapshot: true });
    expect(out).toEqual({});
    const notes = events(r).filter((e) => e.kind === 'note');
    expect(notes.map((n) => n['note'])).toEqual(['screenshot failed', 'snapshot failed']);
  });
});

describe('files written beside the log', () => {
  it('writes a redacted summary and an arbitrary file', () => {
    const r = new RunRecorder({ kind: 'replay', root: root() });
    r.secrets.register('meridian.password', 'demo-pass-not-real');
    const summary = r.writeSummary({ status: 'success', note: 'used demo-pass-not-real' });
    expect(readFileSync(summary, 'utf8')).toContain('«secret:meridian.password»');

    const trace = r.writeFile('trace.json', '{"entries":[]}');
    expect(readFileSync(trace, 'utf8')).toBe('{"entries":[]}');
  });
});
