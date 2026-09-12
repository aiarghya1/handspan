/**
 * The operator console's HTTP surface.
 *
 * The console has no authority of its own: every route is a thin translation of
 * a broker call, and the broker enforces who holds the session. These tests
 * check that translation, including the refusals - a console that let an
 * operator act on an unclaimed intervention would defeat the control-transfer
 * model entirely.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { buildConsoleApp, startOperatorConsole } from '../src/escalation/console.js';
import { EscalationBroker, type InterventionResolution } from '../src/escalation/broker.js';
import { PolicyEngine } from '../src/policy/policy.js';
import { RunRecorder } from '../src/obs/recorder.js';
import { FakeDriver } from './fake-driver.js';
import { FLOW, policyConfig } from './fixtures.js';

function harness(opts: { start?: string; debugUrl?: string } = {}) {
  const driver = new FakeDriver(structuredClone(FLOW.screens), FLOW.transitions, opts.start ?? 'confirm');
  const recorder = new RunRecorder({ kind: 'replay', root: mkdtempSync(`${tmpdir()}/handspan-`) });
  const policy = new PolicyEngine(policyConfig());
  const broker = new EscalationBroker({
    driver,
    policy,
    recorder,
    maxWaitMs: 1_500,
    liveSessionUrl: opts.debugUrl,
  });
  return { driver, recorder, broker, app: buildConsoleApp(broker) };
}

const CONTEXT = {
  runId: 'r1',
  capabilityId: 'meridian.member.subaccount_open',
  stepId: 's012',
  stepIntent: 'post the new sub-account',
  expected: 'the screen shows "SUB-ACCOUNT POSTED"',
  observed: 'still on the confirmation screen',
  askedToDo: 'post it, or abort',
  intendedAction: { kind: 'click' as const, ref: { role: 'button' as const, name: 'Confirm and Post' } },
};

describe('the page', () => {
  it('serves a self-contained page with no external dependencies', async () => {
    const h = harness();
    const res = await request(h.app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('html');
    expect(res.text).toContain('Handspan');
    // Nothing off-host: an operator console for a bank cannot depend on a CDN.
    expect(res.text).not.toMatch(/src="https?:\/\//);
  });
});

describe('the queue', () => {
  it('is empty while automation holds the session', async () => {
    const h = harness();
    const res = await request(h.app).get('/api/state');
    expect(res.body).toMatchObject({ controller: 'automation', interventions: [] });
  });

  it('shows a raised intervention with the context a person needs', async () => {
    const h = harness({ debugUrl: 'http://localhost:9222' });
    const pending = h.broker.raise('irreversible-approval', 'needs a decision', CONTEXT).catch(() => undefined);

    const res = await request(h.app).get('/api/state');
    expect(res.body.controller).toBe('operator');
    expect(res.body.liveSessionUrl).toBe('http://localhost:9222');
    expect(res.body.interventions[0]).toMatchObject({
      reason: 'irreversible-approval',
      state: 'pending',
      context: { stepId: 's012', expected: 'the screen shows "SUB-ACCOUNT POSTED"' },
    });
    await pending;
  });
});

describe('taking control', () => {
  it('claims, shows the live session, and performs the action', async () => {
    const h = harness();
    const pending = h.broker.raise('irreversible-approval', 'needs a decision', CONTEXT);
    const id = h.broker.list()[0]!.id;

    const claimed = await request(h.app).post(`/api/interventions/${id}/claim`).send({ by: 'r.okafor' });
    expect(claimed.body).toMatchObject({ state: 'claimed', claimedBy: 'r.okafor' });

    const live = await request(h.app).get(`/api/interventions/${id}/live`);
    expect(live.body.url).toBe('http://app.test/confirm');
    const target = live.body.controls.find((c: { name: string }) => c.name === 'Confirm and Post');
    expect(target).toBeTruthy();

    const shot = await request(h.app).get(`/api/interventions/${id}/screen`);
    expect(shot.headers['content-type']).toContain('png');

    const acted = await request(h.app).post(`/api/interventions/${id}/act`).send({ kind: 'click', handle: target.handle });
    expect(acted.body).toEqual({ ok: true });
    expect(h.driver.current).toBe('posted');

    const resolved = await request(h.app)
      .post(`/api/interventions/${id}/resolve`)
      .send({ action: 'resume', by: 'r.okafor', note: 'posted by hand' });
    expect(resolved.body.resolution).toMatchObject({ action: 'resume', by: 'r.okafor' });
    await expect(pending).resolves.toMatchObject({ action: 'resume' });
  });

  it('extends the lease on a heartbeat', async () => {
    const h = harness();
    const pending = h.broker.raise('model-requested-help', 'stuck', { runId: 'r', askedToDo: 'help' });
    const id = h.broker.list()[0]!.id;
    await request(h.app).post(`/api/interventions/${id}/claim`).send({ by: 'op' });
    const before = h.broker.get(id)!.leaseExpiresAt!;
    await new Promise((r) => setTimeout(r, 5));
    const beat = await request(h.app).post(`/api/interventions/${id}/heartbeat`).send({});
    expect(Date.parse(beat.body.leaseExpiresAt)).toBeGreaterThanOrEqual(Date.parse(before));
    await request(h.app).post(`/api/interventions/${id}/resolve`).send({ action: 'abort', by: 'op' });
    await pending;
  });

  it('defaults the operator name when the client does not send one', async () => {
    const h = harness();
    const pending = h.broker.raise('model-requested-help', 'stuck', { runId: 'r', askedToDo: 'help' });
    const id = h.broker.list()[0]!.id;
    const res = await request(h.app).post(`/api/interventions/${id}/claim`).send({});
    expect(res.body.claimedBy).toBe('operator');
    await request(h.app).post(`/api/interventions/${id}/resolve`).send({ action: 'abort' });
    await pending;
  });

  it('records the operator declaring a business outcome', async () => {
    const h = harness();
    // The run's own await is kept alive alongside the operator's requests, so
    // the assertion covers both sides of the handoff.
    const pending: Promise<InterventionResolution> = h.broker.raise('permission-denied', 'entitlement missing', {
      runId: 'r',
      askedToDo: 'decide',
    });
    const id = h.broker.list()[0]!.id;

    const [resolution] = await Promise.all([
      pending,
      (async () => {
        await request(h.app).post(`/api/interventions/${id}/claim`).send({ by: 'op' });
        await request(h.app)
          .post(`/api/interventions/${id}/resolve`)
          .send({ action: 'outcome', outcomeId: 'PERMISSION_DENIED', by: 'op', note: 'no entitlement' });
      })(),
    ]);

    expect(resolution).toMatchObject({ action: 'outcome', outcomeId: 'PERMISSION_DENIED', by: 'op' });
    expect(h.broker.get(id)!.state).toBe('resolved');
  });
});

describe('refusals', () => {
  it('will not act on, view, or screenshot an unclaimed intervention', async () => {
    const h = harness();
    const pending = h.broker.raise('model-requested-help', 'stuck', { runId: 'r', askedToDo: 'help' }).catch(() => undefined);
    const id = h.broker.list()[0]!.id;

    for (const res of [
      await request(h.app).get(`/api/interventions/${id}/live`),
      await request(h.app).get(`/api/interventions/${id}/screen`),
      await request(h.app).post(`/api/interventions/${id}/act`).send({ kind: 'click', handle: 'h0' }),
    ]) {
      expect(res.status).toBe(409);
    }
    await pending;
  });

  it('reports an unknown intervention rather than failing opaquely', async () => {
    const h = harness();
    const routes: Array<[string, () => Promise<{ status: number; body: Record<string, string> }>]> = [
      ['claim', () => request(h.app).post('/api/interventions/nope/claim').send({ by: 'op' })],
      ['heartbeat', () => request(h.app).post('/api/interventions/nope/heartbeat').send({})],
      ['live', () => request(h.app).get('/api/interventions/nope/live')],
      ['screen', () => request(h.app).get('/api/interventions/nope/screen')],
      ['act', () => request(h.app).post('/api/interventions/nope/act').send({ kind: 'click', handle: 'h0' })],
      ['resolve', () => request(h.app).post('/api/interventions/nope/resolve').send({ action: 'abort', by: 'op' })],
    ];
    for (const [name, call] of routes) {
      const res = await call();
      expect(res.status, name).toBe(409);
      expect(`${res.body.error ?? ''}${res.body.reason ?? ''}`, name).toContain('nope');
    }
  });

  it('passes a policy refusal back to the operator verbatim', async () => {
    const h = harness();
    const pending = h.broker.raise('model-requested-help', 'stuck', { runId: 'r', askedToDo: 'help' });
    const id = h.broker.list()[0]!.id;
    await request(h.app).post(`/api/interventions/${id}/claim`).send({ by: 'op' });
    const res = await request(h.app).post(`/api/interventions/${id}/act`).send({ kind: 'navigate', url: 'http://evil.test/' });
    expect(res.body).toMatchObject({ ok: false });
    expect(res.body.reason).toContain('not allowlisted');
    await request(h.app).post(`/api/interventions/${id}/resolve`).send({ action: 'abort', by: 'op' });
    await pending;
  });
});

describe('binding a port', () => {
  it('starts and stops cleanly', async () => {
    const h = harness();
    const handle = await startOperatorConsole(h.broker, 0);
    expect(handle.url).toMatch(/^http:\/\/localhost:\d+$/);
    await handle.close();
  });
});

describe('the live control list', () => {
  it('labels each control with the frame it is in, or with the top document', async () => {
    const framed = structuredClone(FLOW.screens);
    framed['confirm']!.controls = [
      { role: 'button', name: 'Confirm and Post', frame: 'main' },
      { role: 'link', name: 'Cancel' },
    ];
    const driver = new FakeDriver(framed, FLOW.transitions, 'confirm');
    const recorder = new RunRecorder({ kind: 'replay', root: mkdtempSync(`${tmpdir()}/handspan-`) });
    const policy = new PolicyEngine(policyConfig());
    const broker = new EscalationBroker({ driver, policy, recorder, maxWaitMs: 1_000 });
    const app = buildConsoleApp(broker);

    const pending = broker.raise('irreversible-approval', 'needs a decision', CONTEXT);
    const id = broker.list()[0]!.id;
    await request(app).post(`/api/interventions/${id}/claim`).send({ by: 'op' });

    const live = await request(app).get(`/api/interventions/${id}/live`);
    const frames = (live.body.controls as Array<{ frame: string }>).map((c) => c.frame);
    expect(frames).toEqual(['main', 'top']);

    await request(app).post(`/api/interventions/${id}/resolve`).send({ action: 'abort', by: 'op' });
    await pending;
  });
});

describe('a control in an unnamed frame', () => {
  it('is labelled by its index', async () => {
    const indexed = structuredClone(FLOW.screens);
    indexed['confirm']!.controls = [{ role: 'button', name: 'Confirm and Post', frame: undefined }];
    const driver = new FakeDriver(indexed, FLOW.transitions, 'confirm');
    // The fake reports the top document for a control with no frame name, so
    // force an indexed path to exercise the other branch.
    const original = driver.observe.bind(driver);
    driver.observe = async () => {
      const obs = await original();
      return { ...obs, controls: obs.controls.map((c) => ({ ...c, framePath: [{ index: 2 }] })) };
    };
    const recorder = new RunRecorder({ kind: 'replay', root: mkdtempSync(`${tmpdir()}/handspan-`) });
    const policy = new PolicyEngine(policyConfig());
    const broker = new EscalationBroker({ driver, policy, recorder, maxWaitMs: 1_000 });
    const app = buildConsoleApp(broker);

    const pending = broker.raise('irreversible-approval', 'needs a decision', CONTEXT);
    const id = broker.list()[0]!.id;
    await request(app).post(`/api/interventions/${id}/claim`).send({ by: 'op' });
    const live = await request(app).get(`/api/interventions/${id}/live`);
    expect(live.body.controls[0].frame).toBe('#2');

    await request(app).post(`/api/interventions/${id}/resolve`).send({ action: 'abort', by: 'op' });
    await pending;
  });
});
