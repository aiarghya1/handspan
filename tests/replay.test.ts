/**
 * The replay engine's result contract and error taxonomy.
 *
 * Run against the in-memory surface, so each of the four statuses and the
 * recovery paths are exercised deterministically. This is where the central
 * design claim is checked: "no such member" comes back as an answer, a
 * dismissable interstitial comes back as a success, and a genuinely broken
 * screen comes back as a debuggable failure.
 */

import { describe, expect, it } from 'vitest';
import { replay } from '../src/replay/engine.js';
import { API_VERSION, zCapability, type Capability } from '../src/artifact/schema.js';
import { DEFAULT_POLICY } from '../src/policy/policy.js';
import { RunRecorder } from '../src/obs/recorder.js';
import { EscalationBroker } from '../src/escalation/broker.js';
import { PolicyEngine } from '../src/policy/policy.js';
import { describeResult } from '../src/replay/result.js';
import { FakeDriver, type FakeScreen, type Transitions } from './fake-driver.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SEARCH: FakeScreen = {
  url: 'http://app.test/member/search',
  text: 'MEMBER INQUIRY',
  controls: [
    { role: 'textbox', name: 'Member Number', value: '', section: 'MEMBER INQUIRY' },
    { role: 'button', name: 'Retrieve', section: 'MEMBER INQUIRY' },
  ],
};

const DETAIL: FakeScreen = {
  url: 'http://app.test/member/detail',
  text: 'MEMBER DETAIL - 12345',
  controls: [
    {
      role: 'cell',
      name: 'Balance',
      value: '4182.55',
      section: 'MEMBER DETAIL - 12345',
      rowText: '0001 REGULAR SHARE SAVINGS 4182.55',
    },
  ],
};

const NOT_FOUND: FakeScreen = {
  url: 'http://app.test/member/search',
  text: 'MEMBER INQUIRY',
  alerts: ['No member found for 99999.'],
  controls: [
    { role: 'textbox', name: 'Member Number', value: '', section: 'MEMBER INQUIRY' },
    { role: 'button', name: 'Retrieve', section: 'MEMBER INQUIRY' },
  ],
};

const NOTICE: FakeScreen = {
  url: 'http://app.test/member/search',
  text: 'MEMBER INQUIRY',
  controls: [
    { role: 'dialog', name: 'Scheduled Maintenance', section: 'Scheduled Maintenance' },
    { role: 'button', name: 'Continue', section: 'Scheduled Maintenance' },
    { role: 'textbox', name: 'Member Number', value: '', section: 'MEMBER INQUIRY' },
    { role: 'button', name: 'Retrieve', section: 'MEMBER INQUIRY' },
  ],
};

const ABEND: FakeScreen = {
  url: 'http://app.test/member/search',
  text: 'CICS ABEND ASRA TRAN=MBRI REF=8A31CC02',
  alerts: ['CICS ABEND ASRA TRAN=MBRI REF=8A31CC02'],
  controls: [],
};

function capability(over: Record<string, unknown> = {}): Capability {
  return zCapability.parse({
    apiVersion: API_VERSION,
    id: 'meridian.member.balance',
    version: '1.0.0',
    title: 'Read a balance',
    summary: 'Look up a member and read their savings balance.',
    surface: 'web-legacy',
    app: { id: 'meridian-core-servicing', recordedForTenant: 'tenant-a' },
    entryUrlTemplate: '{{baseUrl}}/member/search',
    params: { memberId: { type: 'string', description: 'member number', pattern: '^\\d{5}$', sensitivity: 'pii-id' } },
    returns: { savingsBalance: { type: 'money', description: 'ledger balance', sensitivity: 'account' } },
    steps: [
      {
        id: 's1',
        intent: 'enter the member number',
        action: 'fill',
        phase: 'input',
        ref: { role: 'textbox', name: 'Member Number' },
        value: '{{memberId}}',
        recordedTier: 'role+name+scope',
      },
      {
        id: 's2',
        intent: 'retrieve the member record',
        action: 'click',
        phase: 'input',
        ref: { role: 'button', name: 'Retrieve' },
        checkpoint: { kind: 'textPresent', text: 'MEMBER DETAIL' },
        recordedTier: 'role+name+scope',
      },
      {
        id: 's3',
        intent: 'read the savings balance',
        action: 'extract',
        phase: 'read',
        extract: {
          as: 'savingsBalance',
          source: { kind: 'control', ref: { role: 'cell', name: 'Balance', scope: { rowContaining: 'REGULAR SHARE SAVINGS' } } },
          transform: 'money',
        },
      },
    ],
    outcomes: [
      {
        id: 'MEMBER_NOT_FOUND',
        description: 'The member number does not exist on this core.',
        detect: { kind: 'textPresent', text: 'No member found for' },
        disposition: 'return',
        extract: [{ as: 'searchedFor', source: { kind: 'text', pattern: 'No member found for (\\d+)' }, transform: 'trim' }],
      },
      {
        id: 'APP_ERROR',
        description: 'The application itself failed.',
        detect: { kind: 'textPresent', text: 'ABEND' },
        disposition: 'escalate',
      },
    ],
    recoveries: [
      {
        id: 'dismiss-maintenance-notice',
        description: 'dismiss the nightly batch notice',
        when: { kind: 'controlPresent', ref: { role: 'dialog', name: 'Scheduled Maintenance', nameMatch: 'contains' } },
        do: [{ kind: 'click', ref: { role: 'button', name: 'Continue', scope: { section: 'Scheduled Maintenance' } } }],
        maxPerRun: 2,
      },
    ],
    policy: { riskTier: 'read_only', allowedOrigins: ['http://app.test'] },
    provenance: { discoveredBy: { model: 'test', runId: 'r1', at: '2026-01-01T00:00:00Z', goal: 'g' } },
    ...over,
  }) as Capability;
}

function harness(screens: Record<string, FakeScreen>, transitions: Transitions, start: string, opts: { autoResolve?: 'resume' | 'abort' } = {}) {
  const driver = new FakeDriver(structuredClone(screens), transitions, start);
  const recorder = new RunRecorder({ kind: 'replay', root: mkdtempSync(`${tmpdir()}/handspan-`) });
  const policy = new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: ['http://app.test'] });
  const broker = new EscalationBroker({
    driver,
    policy,
    recorder,
    maxWaitMs: 2_000,
    autoResolver: opts.autoResolve
      ? async () => ({ action: opts.autoResolve!, by: 'test-operator', at: new Date().toISOString(), note: 'handled in test' })
      : undefined,
  });
  return { driver, recorder, broker, policy };
}

const base = (h: ReturnType<typeof harness>) => ({
  driver: h.driver,
  recorder: h.recorder,
  broker: h.broker,
  basePolicy: { ...DEFAULT_POLICY, allowedOrigins: ['http://app.test'] },
  baseUrl: 'http://app.test',
  tenant: 'tenant-a',
  secrets: { get: () => undefined },
});

describe('success', () => {
  it('returns typed outputs and reports the tier each step resolved at', async () => {
    const h = harness({ search: SEARCH, detail: DETAIL }, { 'search::click:button:Retrieve': 'detail' }, 'search');
    const r = await replay({ capability: capability(), inputs: { memberId: '12345' }, ...base(h) });

    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.outputs).toEqual({ savingsBalance: 4182.55 });
    expect(r.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok']);
    expect(r.degradedSteps).toEqual([]);
    expect(r.steps[1]!.checkpoint).toMatchObject({ ok: true, expected: 'the screen shows "MEMBER DETAIL"' });
  });

  it('substitutes the input parameter rather than the recorded value', async () => {
    const h = harness({ search: SEARCH, detail: DETAIL }, { 'search::click:button:Retrieve': 'detail' }, 'search');
    await replay({ capability: capability(), inputs: { memberId: '23456' }, ...base(h) });
    expect(h.driver.actions).toContain('search::fill:Member Number');
  });
});

describe('business outcomes', () => {
  it('reports "no such member" as an answer, not a failure', async () => {
    // The single most important behaviour in the contract: the caller needs to
    // tell this apart from the automation being broken.
    const h = harness({ search: SEARCH, missing: NOT_FOUND }, { 'search::click:button:Retrieve': 'missing' }, 'search');
    const r = await replay({ capability: capability(), inputs: { memberId: '99999' }, ...base(h) });

    expect(r.status).toBe('business_outcome');
    if (r.status !== 'business_outcome') return;
    expect(r.outcome.id).toBe('MEMBER_NOT_FOUND');
    expect(r.outcome.data).toEqual({ searchedFor: '99999' });
  });

  it('checks outcomes before checkpoints, so the caller gets the better answer', async () => {
    // On the not-found screen the checkpoint is also false. Whichever is
    // evaluated first decides whether the caller learns a fact about the member
    // or a fact about the automation.
    const h = harness({ search: SEARCH, missing: NOT_FOUND }, { 'search::click:button:Retrieve': 'missing' }, 'search');
    const r = await replay({ capability: capability(), inputs: { memberId: '99999' }, ...base(h) });
    expect(r.status).not.toBe('failed');
  });

  it('routes an escalate-disposition outcome to a human', async () => {
    const h = harness({ search: SEARCH, abend: ABEND }, { 'search::click:button:Retrieve': 'abend' }, 'search', {
      autoResolve: 'abort',
    });
    const r = await replay({ capability: capability(), inputs: { memberId: '12345' }, ...base(h) });
    expect(r.status).toBe('escalated');
  });
});

describe('recoverable conditions', () => {
  it('dismisses a known interstitial and still succeeds', async () => {
    // A recovered run is a successful run. The interstitial appears in
    // `recoveries` for observability and changes nothing for the caller.
    const h = harness(
      { notice: NOTICE, search: SEARCH, detail: DETAIL },
      { 'notice::click:button:Continue': 'search', 'search::click:button:Retrieve': 'detail' },
      'notice',
    );
    const r = await replay({ capability: capability(), inputs: { memberId: '12345' }, ...base(h) });

    expect(r.status).toBe('success');
    expect(r.recoveries.map((x) => x.recoveryId)).toContain('dismiss-maintenance-notice');
  });

  it('does not apply a recovery more times than it is allowed to', async () => {
    // The notice never goes away, so an uncapped recovery would loop forever.
    const h = harness({ notice: NOTICE }, {}, 'notice');
    const cap = capability();
    for (const s of cap.steps) s.timeoutMs = 200;
    const r = await replay({ capability: cap, inputs: { memberId: '12345' }, ...base(h) });
    expect(r.recoveries.filter((x) => x.recoveryId === 'dismiss-maintenance-notice').length).toBeLessThanOrEqual(2);
    expect(r.status).toBe('failed');
  });
});

describe('hard failures', () => {
  it('reports a checkpoint that never held, with what it expected and saw', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability();
    cap.steps[1]!.timeoutMs = 300;
    const r = await replay({ capability: cap, inputs: { memberId: '12345' }, ...base(h) });

    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.class).toBe('checkpoint_failed');
    expect(r.failure.stepId).toBe('s2');
    expect(r.failure.expected).toBe('the screen shows "MEMBER DETAIL"');
    expect(r.failure.observed).toContain('did not find');
  });

  it('escalates an unresolvable target rather than failing silently', async () => {
    const h = harness({ blank: { url: 'http://app.test/member/search', text: 'nothing', controls: [] } }, {}, 'blank', {
      autoResolve: 'abort',
    });
    const r = await replay({ capability: capability(), inputs: { memberId: '12345' }, ...base(h) });
    expect(r.status).toBe('escalated');
    if (r.status !== 'escalated') return;
    expect(r.escalation.reason).toBe('control-not-found');
  });

  it('rejects invalid inputs before opening anything', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const r = await replay({ capability: capability(), inputs: { memberId: 'abc' }, ...base(h) });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.class).toBe('invalid_input');
    expect(h.driver.actions).toHaveLength(0);
  });

  it('refuses unattended replay of an artifact that needs approval it lacks', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability();
    cap.policy.requiresApproval = true;
    const r = await replay({ capability: cap, inputs: { memberId: '12345' }, ...base(h) });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.class).toBe('not_approved');
  });

  it('refuses an artifact that does not pass static validation', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability();
    cap.steps[0]!.value = '{{undeclared}}';
    const r = await replay({ capability: cap, inputs: { memberId: '12345' }, ...base(h) });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.class).toBe('invalid_artifact');
  });
});

describe('escalation and handoff', () => {
  it('resumes the run from the next step when an operator hands control back', async () => {
    const screens = { search: SEARCH, detail: DETAIL };
    const h = harness(screens, {}, 'search', { autoResolve: 'resume' });
    // The click leads nowhere, so the checkpoint fails and the step escalates.
    const cap = capability();
    cap.steps[1]!.onCheckpointFail = 'escalate';
    cap.steps[1]!.timeoutMs = 300;
    // The operator "fixes" it by moving the session to the detail screen.
    h.broker = new EscalationBroker({
      driver: h.driver,
      policy: h.policy,
      recorder: h.recorder,
      maxWaitMs: 2_000,
      autoResolver: async (i) => {
        h.broker.claim(i.id, 'test-operator');
        h.driver.current = 'detail';
        return { action: 'resume', by: 'test-operator', at: new Date().toISOString(), note: 'navigated by hand' };
      },
    });

    const r = await replay({ capability: cap, inputs: { memberId: '12345' }, ...base(h) });
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.outputs).toEqual({ savingsBalance: 4182.55 });
  });

  it('lets an operator declare the run a business outcome instead', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability();
    cap.steps[1]!.onCheckpointFail = 'escalate';
    cap.steps[1]!.timeoutMs = 300;
    h.broker = new EscalationBroker({
      driver: h.driver,
      policy: h.policy,
      recorder: h.recorder,
      maxWaitMs: 2_000,
      autoResolver: async (i) => {
        h.broker.claim(i.id, 'test-operator');
        return {
          action: 'outcome',
          outcomeId: 'MEMBER_NOT_FOUND',
          by: 'test-operator',
          at: new Date().toISOString(),
          note: 'the record is closed on the core',
        };
      },
    });

    const r = await replay({ capability: cap, inputs: { memberId: '12345' }, ...base(h) });
    expect(r.status).toBe('business_outcome');
    if (r.status !== 'business_outcome') return;
    expect(r.outcome.id).toBe('MEMBER_NOT_FOUND');
  });

  it('fails with a clear reason when no operator arrives', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability();
    cap.steps[1]!.onCheckpointFail = 'escalate';
    cap.steps[1]!.timeoutMs = 300;
    const r = await replay({ capability: cap, inputs: { memberId: '12345' }, ...base(h) });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.class).toBe('escalation_timeout');
  });
});

describe('locator drift', () => {
  it('flags a step that resolved less confidently than when it was recorded', async () => {
    // The section heading has changed, so the ref now resolves one tier lower.
    // The run still succeeds; the artifact is flagged for re-review.
    const drifted: FakeScreen = {
      ...SEARCH,
      controls: SEARCH.controls.map((c) => ({ ...c, section: 'MEMBER SELECTION' })),
    };
    const h = harness({ search: drifted, detail: DETAIL }, { 'search::click:button:Retrieve': 'detail' }, 'search');
    const cap = capability();
    cap.steps[0]!.ref = { role: 'textbox', name: 'Member Number', scope: { section: 'MEMBER INQUIRY' } };
    cap.steps[0]!.recordedTier = 'role+name+scope';

    const r = await replay({ capability: cap, inputs: { memberId: '12345' }, ...base(h) });
    expect(r.status).toBe('success');
    expect(r.degradedSteps).toContain('s1');
    expect(r.steps[0]!.resolvedTier).toBe('role+name+frame');
  });
});

describe('optional steps', () => {
  it('does not spend a step budget waiting for an interstitial that is absent', async () => {
    // Regression: an optional step polled its full timeout before skipping, so
    // every run paid that cost for every interstitial that did not appear.
    const h = harness({ search: SEARCH, detail: DETAIL }, { 'search::click:button:Retrieve': 'detail' }, 'search');
    const cap = capability();
    cap.steps.unshift({
      ...cap.steps[0]!,
      id: 's0',
      intent: 'dismiss a notice if one is up',
      action: 'click',
      ref: { role: 'button', name: 'Continue' },
      value: undefined,
      checkpoint: undefined,
      optional: true,
      timeoutMs: 30_000,
      waitFor: { kind: 'controlPresent', ref: { role: 'dialog', name: 'Scheduled Maintenance' } },
    });

    const started = Date.now();
    const r = await replay({ capability: cap, inputs: { memberId: '12345' }, ...base(h) });
    expect(r.status).toBe('success');
    expect(r.steps[0]!.status).toBe('skipped');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('describeResult', () => {
  it('renders each status in one line', () => {
    const base = {
      capabilityId: 'a.b',
      capabilityVersion: '1.0.0',
      startedAt: 'now',
      finishedAt: 'now',
      durationMs: 12,
      steps: [],
      recoveries: [],
      degradedSteps: [],
      evidence: { runId: 'r', directory: 'd', log: 'l', screenshots: [] },
    };
    expect(describeResult({ ...base, status: 'success', outputs: { a: 1, b: 2 } })).toBe('success: 2 output(s) in 12ms');
    expect(
      describeResult({
        ...base,
        status: 'business_outcome',
        outcome: { id: 'MEMBER_NOT_FOUND', description: 'd', detail: 'no such member', data: {} },
      }),
    ).toBe('business outcome MEMBER_NOT_FOUND: no such member');
    expect(
      describeResult({ ...base, status: 'escalated', escalation: { interventionId: 'i', reason: 'app-error', resolution: 'abort' } }),
    ).toBe('escalated (app-error) -> abort');
    expect(describeResult({ ...base, status: 'escalated', escalation: { interventionId: 'i', reason: 'app-error' } })).toContain(
      'unresolved',
    );
    expect(
      describeResult({ ...base, status: 'failed', failure: { class: 'checkpoint_failed', message: 'did not hold', stepId: 's2' } }),
    ).toBe('failed [checkpoint_failed] at s2: did not hold');
    expect(describeResult({ ...base, status: 'failed', failure: { class: 'invalid_input', message: 'bad' } })).toContain('at setup');
  });
});
