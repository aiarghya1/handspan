/**
 * Control transfer.
 *
 * The invariants under test are the ones that make a handoff safe: exactly one
 * actor holds the session, an operator's actions go through the same policy
 * gate as the agent's, a lease that lapses does not wedge the run, and what the
 * human did is recorded.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EscalationBroker, EscalationTimeout, NotControllerError, SessionControl } from '../src/escalation/broker.js';
import { DEFAULT_POLICY, PolicyEngine } from '../src/policy/policy.js';
import { RunRecorder } from '../src/obs/recorder.js';
import { FakeDriver } from './fake-driver.js';

function harness(opts: { operatorMayCommit?: boolean; maxWaitMs?: number } = {}) {
  const driver = new FakeDriver(
    {
      confirm: {
        url: 'http://app.test/confirm',
        text: 'CONFIRM SUB-ACCOUNT',
        controls: [
          { role: 'button', name: 'Confirm and Post', section: 'CONFIRM SUB-ACCOUNT' },
          { role: 'link', name: 'Cancel', section: 'CONFIRM SUB-ACCOUNT' },
        ],
      },
      posted: { url: 'http://app.test/posted', text: 'SUB-ACCOUNT POSTED Confirmation 8831-2001', controls: [] },
    },
    { 'confirm::click:button:Confirm and Post': 'posted' },
    'confirm',
  );
  const recorder = new RunRecorder({ kind: 'replay', root: mkdtempSync(`${tmpdir()}/handspan-`) });
  const policy = new PolicyEngine({
    ...DEFAULT_POLICY,
    allowedOrigins: ['http://app.test'],
    operatorMayCommit: opts.operatorMayCommit ?? true,
  });
  const broker = new EscalationBroker({ driver, policy, recorder, maxWaitMs: opts.maxWaitMs ?? 1_000 });
  return { driver, recorder, policy, broker };
}

const context = {
  runId: 'r1',
  askedToDo: 'post the sub-account',
  intendedAction: { kind: 'click' as const, ref: { role: 'button' as const, name: 'Confirm and Post' } },
};

describe('SessionControl', () => {
  it('hands the token to exactly one actor at a time', () => {
    const c = new SessionControl();
    expect(c.current).toBe('automation');
    c.assert('automation');
    expect(() => c.assert('operator')).toThrow(NotControllerError);

    c.cedeToOperator('int-1');
    expect(c.current).toBe('operator');
    expect(c.interventionId).toBe('int-1');
    // This is what stops the agent retrying a step while a person is mid-fix.
    expect(() => c.assert('automation')).toThrow(NotControllerError);

    c.returnToAutomation();
    expect(c.current).toBe('automation');
    expect(c.interventionId).toBeUndefined();
  });
});

describe('raise and resolve', () => {
  it('cedes control the moment the request exists, and takes it back on resolve', async () => {
    const h = harness();
    const pending = h.broker.raise('irreversible-approval', 'needs approval', context);
    expect(h.broker.control.current).toBe('operator');

    const id = h.broker.list()[0]!.id;
    h.broker.claim(id, 'r.okafor');
    h.broker.resolve(id, { action: 'resume', by: 'r.okafor', at: new Date().toISOString() });

    await expect(pending).resolves.toMatchObject({ action: 'resume', by: 'r.okafor' });
    expect(h.broker.control.current).toBe('automation');
  });

  it('carries enough context for a person to act without watching the run', async () => {
    const h = harness();
    const pending = h.broker.raise('checkpoint-failed', 'the detail screen never appeared', {
      runId: 'r1',
      capabilityId: 'meridian.member.balance',
      stepId: 's2',
      stepIntent: 'retrieve the member record',
      expected: 'the screen shows "MEMBER DETAIL"',
      observed: 'did not find "MEMBER DETAIL" on screen',
      askedToDo: 'get the session to the member detail screen',
    });
    const i = h.broker.list()[0]!;
    expect(i.context).toMatchObject({ stepId: 's2', expected: 'the screen shows "MEMBER DETAIL"' });
    expect(i.context.askedToDo).toBeTruthy();

    h.broker.claim(i.id, 'op');
    h.broker.resolve(i.id, { action: 'abort', by: 'op', at: new Date().toISOString() });
    await pending;
  });

  it('does not wedge the session when nobody arrives', async () => {
    const h = harness({ maxWaitMs: 300 });
    await expect(h.broker.raise('no-progress', 'stuck', context)).rejects.toThrow(EscalationTimeout);
    expect(h.broker.control.current).toBe('automation');
  });
});

describe('operator actions', () => {
  it('refuses to act before the intervention is claimed', async () => {
    const h = harness();
    const pending = h.broker.raise('irreversible-approval', 'needs approval', context).catch(() => undefined);
    const id = h.broker.list()[0]!.id;
    await expect(h.broker.operatorAct(id, { kind: 'click', handle: 'h0' })).rejects.toThrow(/must be claimed/);
    await pending;
  });

  it('drives the same live session through the same policy gate', async () => {
    const h = harness();
    const pending = h.broker.raise('irreversible-approval', 'needs approval', context);
    const id = h.broker.list()[0]!.id;
    h.broker.claim(id, 'r.okafor');

    const obs = await h.broker.observeForOperator(id);
    const post = obs.controls.find((c) => c.name === 'Confirm and Post')!;
    const done = await h.broker.operatorAct(id, { kind: 'click', handle: post.handle });

    expect(done.ok).toBe(true);
    // The operator moved the actual session the automation was using.
    expect(h.driver.current).toBe('posted');

    h.broker.resolve(id, { action: 'resume', by: 'r.okafor', at: new Date().toISOString() });
    await pending;
  });

  it('records what the human did, without recording what they typed', async () => {
    const h = harness();
    const pending = h.broker.raise('irreversible-approval', 'needs approval', context);
    const id = h.broker.list()[0]!.id;
    h.broker.claim(id, 'r.okafor');
    const obs = await h.broker.observeForOperator(id);
    await h.broker.operatorAct(id, { kind: 'click', handle: obs.controls[0]!.handle, value: 'secret-typed-value' });

    const actions = h.broker.get(id)!.operatorActions;
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'click', allowed: true });
    expect(actions[0]!.valueShape).toBe('18 chars');
    expect(JSON.stringify(actions)).not.toContain('secret-typed-value');

    h.broker.resolve(id, { action: 'resume', by: 'r.okafor', at: new Date().toISOString() });
    await pending;
  });

  it('still holds the operator to the policy when the deployment forbids commits', async () => {
    // Authority differs between actors; the boundary does not.
    const h = harness({ operatorMayCommit: false });
    const pending = h.broker.raise('irreversible-approval', 'needs approval', context);
    const id = h.broker.list()[0]!.id;
    h.broker.claim(id, 'r.okafor');
    const obs = await h.broker.observeForOperator(id);
    const post = obs.controls.find((c) => c.name === 'Confirm and Post')!;

    const done = await h.broker.operatorAct(id, { kind: 'click', handle: post.handle });
    expect(done.ok).toBe(false);
    expect(h.driver.current).toBe('confirm');
    expect(h.broker.get(id)!.operatorActions[0]!.allowed).toBe(false);

    h.broker.resolve(id, { action: 'abort', by: 'r.okafor', at: new Date().toISOString() });
    await pending;
  });

  it('refuses an operator navigation outside the allowlist', async () => {
    const h = harness();
    const pending = h.broker.raise('model-requested-help', 'stuck', { runId: 'r1', askedToDo: 'help' });
    const id = h.broker.list()[0]!.id;
    h.broker.claim(id, 'op');
    const done = await h.broker.operatorAct(id, { kind: 'navigate', url: 'http://evil.test/' });
    expect(done.ok).toBe(false);
    h.broker.resolve(id, { action: 'abort', by: 'op', at: new Date().toISOString() });
    await pending;
  });

  it('refuses to act on a lapsed lease', async () => {
    const h = harness();
    const b = new EscalationBroker({
      driver: h.driver,
      policy: h.policy,
      recorder: h.recorder,
      leaseMs: 1,
      maxWaitMs: 1_000,
    });
    const pending = b.raise('model-requested-help', 'stuck', { runId: 'r1', askedToDo: 'help' }).catch(() => undefined);
    const id = b.list()[0]!.id;
    b.claim(id, 'op');
    await new Promise((r) => setTimeout(r, 20));
    await expect(b.operatorAct(id, { kind: 'navigate', url: 'http://app.test/' })).rejects.toThrow(/lease/);
    expect(b.control.current).toBe('automation');
    await pending;
  });
});

describe('run log', () => {
  it('labels an operator action as an operator action', async () => {
    // Regression: the action's own `kind` field was overwriting the event kind,
    // so every manual step appeared in the log as a bare "click".
    const h = harness();
    const pending = h.broker.raise('irreversible-approval', 'needs approval', context);
    const id = h.broker.list()[0]!.id;
    h.broker.claim(id, 'r.okafor');
    const obs = await h.broker.observeForOperator(id);
    await h.broker.operatorAct(id, { kind: 'click', handle: obs.controls[0]!.handle });
    h.broker.resolve(id, { action: 'resume', by: 'r.okafor', at: new Date().toISOString() });
    await pending;

    const log = readFileSync(`${h.recorder.dir}/run.jsonl`, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; action?: string });
    const acts = log.filter((e) => e.kind === 'operator.action');
    expect(acts).toHaveLength(1);
    expect(acts[0]!.action).toBe('click');
  });
});

describe('every kind of operator action', () => {
  async function claimed(start = 'search') {
    const h = harness();
    const driver = new FakeDriver(
      {
        search: {
          url: 'http://app.test/member/search',
          text: 'MEMBER INQUIRY',
          controls: [
            { role: 'textbox', name: 'Member Number', value: '' },
            { role: 'combobox', name: 'Branch', value: '' },
            { role: 'button', name: 'Retrieve' },
          ],
        },
        detail: { url: 'http://app.test/member/1', text: 'MEMBER DETAIL', controls: [] },
      },
      { 'search::click:button:Retrieve': 'detail' },
      start,
    );
    const recorder = new RunRecorder({ kind: 'replay', root: mkdtempSync(`${tmpdir()}/handspan-`) });
    const policy = new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: ['http://app.test'] });
    const broker = new EscalationBroker({ driver, policy, recorder, maxWaitMs: 1_000 });
    const pending = broker.raise('model-requested-help', 'stuck', { runId: 'r', askedToDo: 'help' });
    const id = broker.list()[0]!.id;
    broker.claim(id, 'r.okafor');
    void h;
    return { broker, driver, id, pending, recorder };
  }

  it('fills a field on the live session', async () => {
    const c = await claimed();
    const obs = await c.broker.observeForOperator(c.id);
    const field = obs.controls.find((x) => x.name === 'Member Number')!;
    expect(await c.broker.operatorAct(c.id, { kind: 'fill', handle: field.handle, value: '12345' })).toEqual({ ok: true });
    expect(c.driver.actions).toContain('search::fill:Member Number');
    c.broker.resolve(c.id, { action: 'abort', by: 'r.okafor', at: new Date().toISOString() });
    await c.pending;
  });

  it('selects an option on the live session', async () => {
    const c = await claimed();
    const obs = await c.broker.observeForOperator(c.id);
    const select = obs.controls.find((x) => x.role === 'combobox')!;
    expect(await c.broker.operatorAct(c.id, { kind: 'select', handle: select.handle, value: '004' })).toEqual({ ok: true });
    c.broker.resolve(c.id, { action: 'abort', by: 'r.okafor', at: new Date().toISOString() });
    await c.pending;
  });

  it('presses a key, with and without a focused control', async () => {
    const c = await claimed();
    const obs = await c.broker.observeForOperator(c.id);
    const field = obs.controls.find((x) => x.name === 'Member Number')!;
    expect(await c.broker.operatorAct(c.id, { kind: 'press', handle: field.handle, key: 'Enter' })).toEqual({ ok: true });
    expect(await c.broker.operatorAct(c.id, { kind: 'press', key: 'F3' })).toEqual({ ok: true });
    expect(c.driver.actions.filter((a) => a.includes('press'))).toHaveLength(2);
    c.broker.resolve(c.id, { action: 'abort', by: 'r.okafor', at: new Date().toISOString() });
    await c.pending;
  });

  it('navigates within the allowlist', async () => {
    const c = await claimed();
    expect(await c.broker.operatorAct(c.id, { kind: 'navigate', url: 'http://app.test/member/1' })).toEqual({ ok: true });
    expect(c.driver.current).toBe('detail');
    c.broker.resolve(c.id, { action: 'abort', by: 'r.okafor', at: new Date().toISOString() });
    await c.pending;
  });

  it('reports a stale handle rather than acting on the wrong control', async () => {
    const c = await claimed();
    const res = await c.broker.operatorAct(c.id, { kind: 'click', handle: 'h99' });
    expect(res).toMatchObject({ ok: false });
    expect(res.reason).toContain('no longer on screen');
    c.broker.resolve(c.id, { action: 'abort', by: 'r.okafor', at: new Date().toISOString() });
    await c.pending;
  });

  it('reports a driver failure without ending the intervention', async () => {
    const c = await claimed();
    const obs = await c.broker.observeForOperator(c.id);
    const button = obs.controls.find((x) => x.role === 'button')!;
    c.driver.click = async () => {
      throw new Error('the element detached');
    };
    const res = await c.broker.operatorAct(c.id, { kind: 'click', handle: button.handle });
    expect(res).toMatchObject({ ok: false });
    expect(res.reason).toContain('detached');
    expect(c.broker.get(c.id)!.state).toBe('claimed');
    c.broker.resolve(c.id, { action: 'abort', by: 'r.okafor', at: new Date().toISOString() });
    await c.pending;
  });
});

describe('the queue', () => {
  it('lists newest first and looks one up by id', () => {
    const h = harness({ maxWaitMs: 300 });
    void h.broker.raise('model-requested-help', 'first', { runId: 'r', askedToDo: 'a' }).catch(() => undefined);
    const id = h.broker.list()[0]!.id;
    expect(h.broker.get(id)!.detail).toBe('first');
    expect(h.broker.get('absent')).toBeUndefined();
  });

  it('refuses to claim an intervention that is already finished', async () => {
    const h = harness({ maxWaitMs: 300 });
    const pending = h.broker.raise('model-requested-help', 'stuck', { runId: 'r', askedToDo: 'a' });
    const id = h.broker.list()[0]!.id;
    h.broker.claim(id, 'first');
    h.broker.resolve(id, { action: 'abort', by: 'first', at: new Date().toISOString() });
    await pending;
    expect(() => h.broker.claim(id, 'second')).toThrow(/is resolved/);
  });

  it('exposes the live session url when the session was launched with one', () => {
    const driver = new FakeDriver({ a: { url: 'http://app.test/', controls: [] } }, {}, 'a');
    const recorder = new RunRecorder({ kind: 'replay', root: mkdtempSync(`${tmpdir()}/handspan-`) });
    const policy = new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: ['http://app.test'] });
    expect(new EscalationBroker({ driver, policy, recorder }).liveSessionUrl).toBeUndefined();
    expect(
      new EscalationBroker({ driver, policy, recorder, liveSessionUrl: 'http://localhost:9222' }).liveSessionUrl,
    ).toBe('http://localhost:9222');
  });
});

describe('operator actions with fields omitted', () => {
  it('defaults a navigation, a keystroke, a fill and a selection', async () => {
    const driver = new FakeDriver(
      {
        a: {
          url: 'http://app.test/',
          text: 'HOME',
          controls: [
            { role: 'textbox', name: 'Member Number', value: '' },
            { role: 'combobox', name: 'Branch', value: '' },
          ],
        },
      },
      {},
      'a',
    );
    const recorder = new RunRecorder({ kind: 'replay', root: mkdtempSync(`${tmpdir()}/handspan-`) });
    const policy = new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: ['http://app.test'] });
    const broker = new EscalationBroker({ driver, policy, recorder, maxWaitMs: 1_000 });
    const pending = broker.raise('model-requested-help', 'stuck', { runId: 'r', askedToDo: 'help' });
    const id = broker.list()[0]!.id;
    broker.claim(id, 'op');

    const obs = await broker.observeForOperator(id);
    const field = obs.controls.find((c) => c.role === 'textbox')!;
    const select = obs.controls.find((c) => c.role === 'combobox')!;

    // A console that omits a field must not crash the session.
    expect(await broker.operatorAct(id, { kind: 'navigate' })).toMatchObject({ ok: false });
    expect(await broker.operatorAct(id, { kind: 'press' })).toEqual({ ok: true });
    expect(await broker.operatorAct(id, { kind: 'fill', handle: field.handle })).toEqual({ ok: true });
    expect(await broker.operatorAct(id, { kind: 'select', handle: select.handle })).toEqual({ ok: true });

    broker.resolve(id, { action: 'abort', by: 'op', at: new Date().toISOString() });
    await pending;
  });
});
