/**
 * The replay engine's less-travelled paths.
 *
 * Every branch here is one the happy path never reaches and production will:
 * an artifact that names an unsupported tenant, a recovery that re-navigates
 * and re-types, a precondition that never holds, a checkpoint that needs a
 * retry, a policy refusal mid-flow, and an extraction that finds nothing.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { precheckCapability, replay } from '../src/replay/engine.js';
import { API_VERSION, zCapability, zStep, type Capability, type Step } from '../src/artifact/schema.js';
import { computeContentHash } from '../src/artifact/store.js';
import { DEFAULT_POLICY, PolicyEngine } from '../src/policy/policy.js';
import { RunRecorder } from '../src/obs/recorder.js';
import { EscalationBroker, type InterventionResolution } from '../src/escalation/broker.js';
import { FakeDriver, type FakeScreen, type Transitions } from './fake-driver.js';

const BASE = 'http://app.test';

const screen = (over: Partial<FakeScreen> & Pick<FakeScreen, 'url'>): FakeScreen => ({ controls: [], ...over });

const SEARCH = screen({
  url: `${BASE}/member/search`,
  text: 'MEMBER INQUIRY',
  controls: [
    { role: 'textbox', name: 'Member Number', value: '' },
    { role: 'combobox', name: 'Product', value: '' },
    { role: 'button', name: 'Retrieve' },
  ],
});
const DETAIL = screen({
  url: `${BASE}/member/detail`,
  text: 'MEMBER DETAIL',
  controls: [
    { role: 'cell', name: 'Balance', value: '4182.55', nameSource: 'column-header', rowText: '0001 REGULAR SHARE SAVINGS 4182.55' },
  ],
});
const EXPIRED = screen({ url: `${BASE}/member/search`, text: 'Your session has expired due to inactivity.' });
const SIGNON = screen({
  url: `${BASE}/`,
  text: 'MERIDIAN CORE SERVICING',
  controls: [
    { role: 'textbox', name: 'Operator ID', value: '' },
    { role: 'button', name: 'Sign On' },
  ],
});

function step(over: Record<string, unknown>): Step {
  return zStep.parse({ intent: 'do a thing', action: 'assert', ...over }) as Step;
}

function capability(over: Record<string, unknown> = {}): Capability {
  return zCapability.parse({
    apiVersion: API_VERSION,
    id: 'meridian.member.balance',
    version: '1.0.0',
    title: 'Read a balance',
    summary: 'Look up a member and read the balance.',
    surface: 'web-legacy',
    app: { id: 'meridian-core-servicing', recordedForTenant: 'tenant-a' },
    entryUrlTemplate: '{{baseUrl}}/member/search',
    params: { memberId: { type: 'string', description: 'member number', pattern: '^\\d{5}$', sensitivity: 'pii-id' } },
    returns: {},
    steps: [step({ id: 's1', action: 'assert', checkpoint: { kind: 'textPresent', text: 'MEMBER INQUIRY' } })],
    policy: { riskTier: 'read_only', allowedOrigins: [BASE] },
    provenance: { discoveredBy: { model: 'test', runId: 'r', at: 'now', goal: 'g' } },
    ...over,
  }) as Capability;
}

function harness(
  screens: Record<string, FakeScreen>,
  transitions: Transitions,
  start: string,
  opts: { resolver?: (b: () => EscalationBroker) => (i: unknown) => Promise<InterventionResolution>; policy?: Partial<typeof DEFAULT_POLICY>; noBroker?: boolean } = {},
) {
  const driver = new FakeDriver(structuredClone(screens), transitions, start);
  const recorder = new RunRecorder({ kind: 'replay', root: mkdtempSync(`${tmpdir()}/handspan-`) });
  const basePolicy = { ...DEFAULT_POLICY, allowedOrigins: [BASE], ...opts.policy };
  const policy = new PolicyEngine(basePolicy);
  let broker: EscalationBroker | undefined;
  if (!opts.noBroker) {
    broker = new EscalationBroker({
      driver,
      policy,
      recorder,
      maxWaitMs: 500,
      autoResolver: opts.resolver ? (opts.resolver(() => broker!) as never) : undefined,
    });
  }
  const run = (capability: Capability, inputs: Record<string, string> = { memberId: '12345' }) =>
    replay({
      capability,
      inputs,
      driver,
      recorder,
      basePolicy,
      baseUrl: BASE,
      tenant: 'tenant-a',
      secrets: { get: (k) => `value-of-${k}` },
      broker,
      attended: true,
    });
  return { driver, recorder, policy, run, get broker() { return broker; } };
}

describe('precheck', () => {
  it('refuses a tenant the artifact does not support', () => {
    const pre = precheckCapability(capability(), { memberId: '12345' }, { tenant: 'tenant-z', attended: true });
    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.failure.class).toBe('invalid_artifact');
  });

  it('accepts an unsupported tenant when asked to be lenient', () => {
    const pre = precheckCapability(capability(), { memberId: '12345' }, { tenant: 'tenant-z', attended: true, lenientTenant: true });
    expect(pre.ok).toBe(true);
  });

  it('accepts an unattended run once the approval matches the artifact', () => {
    const cap = capability();
    cap.policy.requiresApproval = true;
    cap.provenance.approval = { state: 'approved', by: 'R', at: 'now', contentHash: computeContentHash(cap) };
    expect(precheckCapability(cap, { memberId: '12345' }, {}).ok).toBe(true);
  });
});

describe('the actions a step can take', () => {
  it('navigates, waits, selects and presses', async () => {
    const h = harness({ search: SEARCH, detail: DETAIL }, { 'search::click:button:Retrieve': 'detail' }, 'search');
    const cap = capability({
      steps: [
        step({ id: 's1', action: 'navigate', url: '{{baseUrl}}/member/search', checkpoint: { kind: 'textPresent', text: 'MEMBER INQUIRY' } }),
        step({ id: 's2', action: 'wait', timeoutMs: 10 }),
        step({ id: 's3', action: 'select', ref: { role: 'combobox', name: 'Product' }, value: 'VC01' }),
        step({ id: 's4', action: 'press', ref: { role: 'textbox', name: 'Member Number' }, key: 'Tab' }),
        step({ id: 's5', action: 'press', key: 'F3' }),
        step({ id: 's6', action: 'click', ref: { role: 'button', name: 'Retrieve' }, checkpoint: { kind: 'textPresent', text: 'MEMBER DETAIL' } }),
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('success');
    expect(h.driver.actions).toContain('search::fill:Product');
    expect(h.driver.actions.filter((a) => a.includes('press'))).toHaveLength(2);
  });

  it('reports an extraction that finds nothing', async () => {
    const h = harness({ detail: DETAIL }, {}, 'detail');
    const cap = capability({
      returns: { note: { type: 'string', description: 'a note' } },
      steps: [
        step({
          id: 's1',
          action: 'extract',
          extract: { as: 'note', source: { kind: 'text', pattern: 'NOWHERE (x)' }, transform: 'trim' },
        }),
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.class).toBe('checkpoint_failed');
    expect(r.failure.observed).toContain('matched nothing');
  });

  it('reads a value out of one named frame', async () => {
    const h = harness({ detail: DETAIL }, {}, 'detail');
    const cap = capability({
      returns: { balance: { type: 'money', description: 'b', sensitivity: 'account' } },
      steps: [
        step({
          id: 's1',
          action: 'extract',
          extract: { as: 'balance', source: { kind: 'text', frame: {}, pattern: '(\\d+\\.\\d\\d)' }, transform: 'money' },
        }),
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('success');
    if (r.status !== 'success') return;
    expect(r.outputs).toEqual({ balance: 4182.55 });
  });

  it('narrows an extracted value with a second pattern, and reports when it cannot', async () => {
    const h = harness({ detail: DETAIL }, {}, 'detail');
    const ok = capability({
      returns: { suffix: { type: 'string', description: 's' } },
      steps: [
        step({
          id: 's1',
          action: 'extract',
          extract: {
            as: 'suffix',
            source: { kind: 'control', ref: { role: 'cell', name: 'Balance' } },
            pattern: '^(\\d+)',
            transform: 'trim',
          },
        }),
      ],
    });
    const r = await h.run(ok);
    expect(r.status).toBe('success');
    if (r.status === 'success') expect(r.outputs).toEqual({ suffix: '4182' });

    const bad = structuredClone(ok);
    bad.steps[0]!.extract!.pattern = 'ZZZ(1)';
    const r2 = await harness({ detail: DETAIL }, {}, 'detail').run(bad);
    expect(r2.status).toBe('failed');
  });

  it('logs an extracted value only as its declared sensitivity', async () => {
    const h = harness({ detail: DETAIL }, {}, 'detail');
    const cap = capability({
      returns: { balance: { type: 'money', description: 'b', sensitivity: 'account' } },
      steps: [
        step({
          id: 's1',
          action: 'extract',
          extract: { as: 'balance', source: { kind: 'control', ref: { role: 'cell', name: 'Balance' } }, transform: 'money' },
        }),
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('success');
    // Returned to the caller, but not written into the log.
    if (r.status === 'success') expect(r.outputs).toEqual({ balance: 4182.55 });
    const log = await import('node:fs').then((fs) => fs.readFileSync(`${h.recorder.dir}/run.jsonl`, 'utf8'));
    expect(log).toContain('«account»');
    expect(log).not.toContain('4182.55');
  });

  it('reports a declared output that a skipped step would have produced', async () => {
    // The linter catches an output no step produces. The runtime check exists
    // for the case it cannot see: the step that produces it was optional, its
    // precondition did not hold, and the caller is owed an explanation.
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability({
      returns: { balance: { type: 'money', description: 'b' } },
      steps: [
        step({
          id: 's1',
          action: 'extract',
          optional: true,
          waitFor: { kind: 'textPresent', text: 'MEMBER DETAIL' },
          timeoutMs: 150,
          extract: { as: 'balance', source: { kind: 'control', ref: { role: 'cell', name: 'Balance' } }, transform: 'money' },
        }),
      ],
    });
    const r = await h.run(cap);
    expect(r.steps[0]!.status).toBe('skipped');
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failure.message).toContain('outputs are incomplete');
  });
});

describe('preconditions', () => {
  it('fails a required step whose precondition never holds', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability({
      steps: [
        step({
          id: 's1',
          action: 'click',
          ref: { role: 'button', name: 'Retrieve' },
          waitFor: { kind: 'textPresent', text: 'NEVER APPEARS' },
          timeoutMs: 200,
        }),
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.class).toBe('precondition_failed');
    expect(r.failure.expected).toContain('NEVER APPEARS');
  });
});

describe('recoveries with every action kind', () => {
  it('waits, re-navigates, re-types and rebuilds the flow after a session expiry', async () => {
    // The interesting case: the session dies after sign-on and after the member
    // number was typed, so recovering means rebuilding all of it.
    const screens = { signon: SIGNON, search: SEARCH, expired: EXPIRED, detail: DETAIL };
    const transitions: Transitions = {
      'signon::click:button:Sign On': 'search',
      'search::click:button:Retrieve': 'detail',
      'expired::navigate:http://app.test/': 'signon',
    };
    const h = harness(screens, transitions, 'signon');
    const cap = capability({
      // The flow starts at sign-on, so that is where the entry navigation goes.
      entryUrlTemplate: '{{baseUrl}}/',
      secrets: ['meridian.username'],
      steps: [
        step({ id: 's1', phase: 'signon', action: 'fill', ref: { role: 'textbox', name: 'Operator ID' }, value: '{{secret:meridian.username}}' }),
        step({ id: 's2', phase: 'signon', action: 'click', ref: { role: 'button', name: 'Sign On' }, checkpoint: { kind: 'textPresent', text: 'MEMBER INQUIRY' } }),
        step({ id: 's3', phase: 'input', action: 'fill', ref: { role: 'textbox', name: 'Member Number' }, value: '{{memberId}}' }),
        step({ id: 's4', phase: 'input', action: 'click', ref: { role: 'button', name: 'Retrieve' }, checkpoint: { kind: 'textPresent', text: 'MEMBER DETAIL' }, timeoutMs: 400 }),
      ],
      recoveries: [
        {
          id: 'reauthenticate',
          description: 'sign on again and rebuild the flow',
          when: { kind: 'textPresent', text: 'session has expired' },
          do: [
            { kind: 'wait', ms: 5 },
            { kind: 'navigate', url: '{{baseUrl}}/' },
            { kind: 'replayFrom', phase: 'signon' },
          ],
          maxPerRun: 2,
          retryStep: true,
        },
      ],
    });

    // The session expires when the search is submitted, once.
    let expired = false;
    const realClick = h.driver.click.bind(h.driver);
    h.driver.click = async (res) => {
      if (!expired && res.control.name === 'Retrieve') {
        expired = true;
        h.driver.current = 'expired';
        return;
      }
      await realClick(res);
    };

    const r = await h.run(cap);
    expect(r.status).toBe('success');
    expect(r.recoveries.map((x) => x.recoveryId)).toContain('reauthenticate');
    // The sign-on and the input were both re-done.
    expect(h.driver.actions.filter((a) => a.includes('fill:Operator ID')).length).toBeGreaterThan(1);
    expect(h.driver.actions.filter((a) => a.includes('fill:Member Number')).length).toBeGreaterThan(1);
  });

  it('fills a field as part of a recovery', async () => {
    const screens = { blocked: screen({ url: `${BASE}/member/search`, text: 'Enter a reason to continue', controls: SEARCH.controls }), search: SEARCH };
    const h = harness(screens, { 'blocked::fill:Member Number': 'search' }, 'blocked');
    const cap = capability({
      steps: [step({ id: 's1', action: 'assert', checkpoint: { kind: 'textPresent', text: 'MEMBER INQUIRY' }, timeoutMs: 300 })],
      recoveries: [
        {
          id: 'supply-a-reason',
          description: 'the screen wants a reason first',
          when: { kind: 'textPresent', text: 'Enter a reason' },
          do: [{ kind: 'fill', ref: { role: 'textbox', name: 'Member Number' }, value: 'audit' }],
          maxPerRun: 1,
          retryStep: true,
        },
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('success');
    expect(h.driver.actions).toContain('blocked::fill:Member Number');
  });

  it('ignores a replayFrom whose phase is not in the flow', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability({
      steps: [step({ id: 's1', phase: 'read', action: 'assert', checkpoint: { kind: 'textPresent', text: 'MEMBER DETAIL' }, timeoutMs: 200 })],
      recoveries: [
        {
          id: 'reauth',
          description: 'sign on again',
          when: { kind: 'textPresent', text: 'MEMBER INQUIRY' },
          do: [{ kind: 'replayFrom', phase: 'signon' }],
          maxPerRun: 1,
          retryStep: false,
        },
      ],
    });
    const r = await h.run(cap);
    // The recovery ran and changed nothing, so the checkpoint still fails.
    expect(r.recoveries.map((x) => x.recoveryId)).toContain('reauth');
    expect(r.status).toBe('failed');
  });

  it('retries the step itself when the artifact says to', async () => {
    const screens = { search: SEARCH, detail: DETAIL };
    const h = harness(screens, {}, 'search');
    const cap = capability({
      steps: [
        step({
          id: 's1',
          action: 'click',
          ref: { role: 'button', name: 'Retrieve' },
          checkpoint: { kind: 'textPresent', text: 'MEMBER DETAIL' },
          onCheckpointFail: 'retry_step',
          timeoutMs: 200,
        }),
      ],
    });
    let clicks = 0;
    h.driver.click = async () => {
      clicks += 1;
      if (clicks > 1) h.driver.current = 'detail';
    };
    const r = await h.run(cap);
    expect(r.status).toBe('success');
    expect(clicks).toBe(2);
    expect(r.steps[0]!.status).toBe('recovered');
  });

  it('fails when a retry does not help either', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability({
      steps: [
        step({
          id: 's1',
          action: 'click',
          ref: { role: 'button', name: 'Retrieve' },
          checkpoint: { kind: 'textPresent', text: 'MEMBER DETAIL' },
          onCheckpointFail: 'retry_step',
          timeoutMs: 150,
        }),
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failure.message).toContain('after retry');
  });

  it('fails when the checkpoint still does not hold after a recovery', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability({
      steps: [step({ id: 's1', action: 'assert', checkpoint: { kind: 'textPresent', text: 'MEMBER DETAIL' }, timeoutMs: 150 })],
      recoveries: [
        {
          id: 'useless',
          description: 'does nothing useful',
          when: { kind: 'textPresent', text: 'MEMBER INQUIRY' },
          do: [{ kind: 'wait', ms: 1 }],
          // Two allowed: one is spent on the proactive check before the step,
          // leaving one for the checkpoint-failure path under test.
          maxPerRun: 2,
          retryStep: false,
        },
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failure.message).toContain('after recovery');
  });
});

describe('escalation from a checkpoint', () => {
  const escalating = () =>
    capability({
      steps: [
        step({
          id: 's1',
          action: 'assert',
          checkpoint: { kind: 'textPresent', text: 'MEMBER DETAIL' },
          onCheckpointFail: 'escalate',
          timeoutMs: 150,
        }),
      ],
      recoveries: [
        {
          id: 'useless',
          description: 'does nothing useful',
          when: { kind: 'textPresent', text: 'MEMBER INQUIRY' },
          do: [{ kind: 'wait', ms: 1 }],
          maxPerRun: 1,
          retryStep: false,
        },
      ],
    });

  it('escalates after a recovery has been tried and failed', async () => {
    const h = harness({ search: SEARCH, detail: DETAIL }, {}, 'search', {
      resolver: (getBroker) => async (i) => {
        getBroker().claim((i as { id: string }).id, 'r.okafor');
        h.driver.current = 'detail';
        return { action: 'resume', by: 'r.okafor', at: new Date().toISOString() };
      },
    });
    const r = await h.run(escalating());
    expect(r.status).toBe('success');
  });

  it('reports the right failure class when no operator is configured', async () => {
    const h = harness({ search: SEARCH }, {}, 'search', { noBroker: true });
    const r = await h.run(escalating());
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.class).toBe('checkpoint_failed');
    expect(r.failure.message).toContain('no operator is configured');
  });

  it('lets the operator declare an outcome the artifact never named', async () => {
    const h = harness({ search: SEARCH }, {}, 'search', {
      resolver: (getBroker) => async (i) => {
        getBroker().claim((i as { id: string }).id, 'r.okafor');
        return { action: 'outcome', outcomeId: 'SOMETHING_ELSE', by: 'r.okafor', at: new Date().toISOString(), note: 'judged by hand' };
      },
    });
    const r = await h.run(escalating());
    expect(r.status).toBe('business_outcome');
    if (r.status !== 'business_outcome') return;
    expect(r.outcome.id).toBe('SOMETHING_ELSE');
    expect(r.outcome.description).toContain('declared by the operator');
  });

  it('reports an escalation the operator aborted, with the intervention id', async () => {
    const h = harness({ search: SEARCH }, {}, 'search', {
      resolver: (getBroker) => async (i) => {
        getBroker().claim((i as { id: string }).id, 'r.okafor');
        return { action: 'abort', by: 'r.okafor', at: new Date().toISOString(), note: 'not safe to continue' };
      },
    });
    const r = await h.run(escalating());
    expect(r.status).toBe('escalated');
    if (r.status !== 'escalated') return;
    expect(r.escalation.interventionId).toMatch(/^int-/);
    expect(r.escalation.note).toBe('not safe to continue');
  });
});

describe('policy refusal mid-flow', () => {
  it('stops the run when a step is not permitted', async () => {
    const h = harness({ search: SEARCH }, {}, 'search', { policy: { allowedActions: ['assert'] } });
    const cap = capability({
      policy: { riskTier: 'read_only', allowedOrigins: [BASE], allowedActions: ['click', 'assert'] },
      steps: [step({ id: 's1', action: 'click', ref: { role: 'button', name: 'Retrieve' } })],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failure.class).toBe('policy_blocked');
  });

  it('stops the run when an action lands outside the allowlist', async () => {
    const screens = { search: SEARCH, offsite: screen({ url: 'http://evil.test/', text: 'elsewhere' }) };
    const h = harness(screens, { 'search::click:button:Retrieve': 'offsite' }, 'search');
    const cap = capability({ steps: [step({ id: 's1', action: 'click', ref: { role: 'button', name: 'Retrieve' } })] });
    const r = await h.run(cap);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failure.class).toBe('policy_blocked');
  });
});

describe('an ambiguous target', () => {
  it('escalates rather than guessing between two matches', async () => {
    const twoButtons = screen({
      url: `${BASE}/member/search`,
      text: 'MEMBER INQUIRY',
      controls: [
        { role: 'button', name: 'Confirm' },
        { role: 'button', name: 'Confirm' },
      ],
    });
    const h = harness({ search: twoButtons }, {}, 'search', {
      resolver: (getBroker) => async (i) => {
        getBroker().claim((i as { id: string }).id, 'r.okafor');
        return { action: 'abort', by: 'r.okafor', at: new Date().toISOString() };
      },
    });
    const cap = capability({ steps: [step({ id: 's1', action: 'click', ref: { role: 'button', name: 'Confirm' } })] });
    const r = await h.run(cap);
    expect(r.status).toBe('escalated');
    if (r.status === 'escalated') expect(r.escalation.reason).toBe('ambiguous-control');
  });
});

describe('an escalating business outcome', () => {
  it('routes a permission denial to a human by that name', async () => {
    const denied = screen({ url: `${BASE}/member/search`, text: 'Access to member 77777 is restricted.' });
    const h = harness({ search: denied }, {}, 'search', {
      resolver: (getBroker) => async (i) => {
        getBroker().claim((i as { id: string }).id, 'r.okafor');
        return { action: 'abort', by: 'r.okafor', at: new Date().toISOString() };
      },
    });
    const cap = capability({
      steps: [step({ id: 's1', action: 'assert' })],
      outcomes: [
        {
          id: 'PERMISSION_DENIED',
          description: 'the operator lacks the entitlement',
          detect: { kind: 'textPresent', text: 'is restricted' },
          disposition: 'escalate',
        },
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('escalated');
    if (r.status === 'escalated') expect(r.escalation.reason).toBe('permission-denied');
  });

  it('continues the run when the operator clears the condition', async () => {
    const denied = screen({ url: `${BASE}/member/search`, text: 'Access to member 77777 is restricted.' });
    const h = harness({ search: denied, detail: DETAIL }, {}, 'search', {
      resolver: (getBroker) => async (i) => {
        getBroker().claim((i as { id: string }).id, 'r.okafor');
        h.driver.current = 'detail';
        return { action: 'resume', by: 'r.okafor', at: new Date().toISOString() };
      },
    });
    const cap = capability({
      steps: [step({ id: 's1', action: 'assert', checkpoint: { kind: 'textPresent', text: 'MEMBER DETAIL' }, timeoutMs: 200 })],
      outcomes: [
        {
          id: 'PERMISSION_DENIED',
          description: 'the operator lacks the entitlement',
          detect: { kind: 'textPresent', text: 'is restricted' },
          disposition: 'escalate',
        },
      ],
    });
    expect((await h.run(cap)).status).toBe('success');
  });

  it('checks an outcome only after the steps it is scoped to', async () => {
    const h = harness({ search: SEARCH, detail: DETAIL }, { 'search::click:button:Retrieve': 'detail' }, 'search');
    const cap = capability({
      steps: [
        step({ id: 's1', action: 'assert' }),
        step({ id: 's2', action: 'click', ref: { role: 'button', name: 'Retrieve' }, checkpoint: { kind: 'textPresent', text: 'MEMBER DETAIL' } }),
      ],
      outcomes: [
        {
          id: 'STILL_ON_SEARCH',
          description: 'never checked after the first step',
          detect: { kind: 'textPresent', text: 'MEMBER INQUIRY' },
          checkAfter: ['s2'],
        },
      ],
    });
    // The condition was true after s1 but is only checked after s2, by when it
    // is false - so the run succeeds.
    expect((await h.run(cap)).status).toBe('success');
  });

  it('returns the data an outcome declares', async () => {
    const missing = screen({ url: `${BASE}/member/search`, text: 'No member found for 99999.' });
    const h = harness({ search: missing }, {}, 'search');
    const cap = capability({
      steps: [step({ id: 's1', action: 'assert' })],
      outcomes: [
        {
          id: 'MEMBER_NOT_FOUND',
          description: 'no such member',
          detect: { kind: 'textPresent', text: 'No member found for' },
          extract: [
            { as: 'searchedFor', source: { kind: 'text', pattern: 'for (\\d+)' }, transform: 'trim' },
            { as: 'missing', source: { kind: 'text', pattern: 'NOWHERE (x)' }, transform: 'trim' },
          ],
        },
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('business_outcome');
    // What could be read is returned; what could not is simply absent.
    if (r.status === 'business_outcome') expect(r.outcome.data).toEqual({ searchedFor: '99999' });
  });
});

describe('failures that carry partial work', () => {
  it('returns whatever was extracted before the failure', async () => {
    const h = harness({ detail: DETAIL }, {}, 'detail');
    const cap = capability({
      returns: { balance: { type: 'money', description: 'b' } },
      steps: [
        step({
          id: 's1',
          action: 'extract',
          extract: { as: 'balance', source: { kind: 'control', ref: { role: 'cell', name: 'Balance' } }, transform: 'money' },
        }),
        step({ id: 's2', action: 'assert', checkpoint: { kind: 'textPresent', text: 'NEVER' }, timeoutMs: 150 }),
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.partialOutputs).toEqual({ balance: 4182.55 });
  });

  it('reports a template that cannot be resolved as a driver error, not a crash', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability({ steps: [step({ id: 's1', action: 'navigate', url: '{{baseUrl}}/x' })] });
    // Strip the base url so the template cannot resolve.
    const r = await replay({
      capability: cap,
      inputs: { memberId: '12345' },
      driver: h.driver,
      recorder: h.recorder,
      basePolicy: { ...DEFAULT_POLICY, allowedOrigins: [BASE] },
      baseUrl: undefined as unknown as string,
      tenant: 'tenant-a',
      secrets: { get: () => undefined },
      attended: true,
    });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failure.class).toBe('driver_error');
  });
});

describe('steps with nothing to name or nothing to type', () => {
  it('fills an empty value, presses the default key, and reports the target it had', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability({
      steps: [
        step({ id: 's1', action: 'fill', ref: { role: 'textbox', name: 'Member Number' } }),
        step({ id: 's2', action: 'select', ref: { role: 'combobox', name: 'Product' } }),
        step({ id: 's3', action: 'press', ref: { role: 'textbox', name: 'Member Number' } }),
        step({ id: 's4', action: 'navigate', url: '{{baseUrl}}/member/search' }),
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('success');
    expect(h.driver.actions).toContain('search::press:Enter');
  });

  it('resolves a step whose reference has no name at all', async () => {
    const twins = screen({
      url: `${BASE}/member/search`,
      text: 'MEMBER INQUIRY',
      controls: [
        { role: 'button', name: '' },
        { role: 'button', name: '' },
      ],
    });
    const h = harness({ search: twins }, {}, 'search');
    const cap = capability({ steps: [step({ id: 's1', action: 'click', ref: { role: 'button', ordinal: 1 } })] });
    expect((await h.run(cap)).status).toBe('success');
  });
});

describe('a driver that simply fails', () => {
  it('reports a driver error rather than a checkpoint problem', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    h.driver.click = async () => {
      throw new Error('the browser crashed');
    };
    const cap = capability({ steps: [step({ id: 's1', action: 'click', ref: { role: 'button', name: 'Retrieve' } })] });
    const r = await h.run(cap);
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.class).toBe('driver_error');
    expect(r.failure.message).toContain('the browser crashed');
  });

  it('reports a policy violation raised by the driver itself', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const { PolicyViolation } = await import('../src/policy/policy.js');
    h.driver.click = async () => {
      throw new PolicyViolation('origin-not-allowed', 'the driver refused');
    };
    const cap = capability({ steps: [step({ id: 's1', action: 'click', ref: { role: 'button', name: 'Retrieve' } })] });
    const r = await h.run(cap);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failure.class).toBe('policy_blocked');
  });
});

describe('extraction failures and frame scoping', () => {
  it('reports a control it cannot resolve', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability({
      returns: { note: { type: 'string', description: 'n' } },
      steps: [
        step({
          id: 's1',
          action: 'extract',
          extract: { as: 'note', source: { kind: 'control', ref: { role: 'cell', name: 'Nowhere' } }, transform: 'trim' },
        }),
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failure.observed).toContain('cannot read cell "Nowhere"');
  });

  it('reads from a frame addressed by name, by index, or not at all', async () => {
    const framed = { ...DETAIL, framePath: [{ name: 'main', index: 1 }] };
    const cases = [{}, { name: 'main' }, { index: 1 }] as const;
    for (const frame of cases) {
      const cap = capability({
        returns: { note: { type: 'string', description: 'n' } },
        steps: [
          step({
            id: 's1',
            action: 'extract',
            extract: { as: 'note', source: { kind: 'text', frame, pattern: '(MEMBER DETAIL)' }, transform: 'trim' },
          }),
        ],
      });
      const r = await harness({ detail: framed }, {}, 'detail').run(cap);
      expect(r.status, JSON.stringify(frame)).toBe('success');
    }
  });

  it('reads nothing from a frame that is not there', async () => {
    const cap = capability({
      returns: { note: { type: 'string', description: 'n' } },
      steps: [
        step({
          id: 's1',
          action: 'extract',
          extract: { as: 'note', source: { kind: 'text', frame: { name: 'absent' }, pattern: '(MEMBER DETAIL)' }, transform: 'trim' },
        }),
      ],
    });
    expect((await harness({ detail: DETAIL }, {}, 'detail').run(cap)).status).toBe('failed');
  });

  it('uses the whole match when the pattern has no capture group', async () => {
    const h = harness({ detail: DETAIL }, {}, 'detail');
    const cap = capability({
      returns: { note: { type: 'string', description: 'n' } },
      steps: [
        step({
          id: 's1',
          action: 'extract',
          extract: { as: 'note', source: { kind: 'text', pattern: 'MEMBER DETAIL' }, transform: 'trim' },
        }),
      ],
    });
    const r = await h.run(cap);
    if (r.status === 'success') expect(r.outputs).toEqual({ note: 'MEMBER DETAIL' });
  });

  it('narrows with a pattern that has no capture group either', async () => {
    const h = harness({ detail: DETAIL }, {}, 'detail');
    const cap = capability({
      returns: { note: { type: 'string', description: 'n' } },
      steps: [
        step({
          id: 's1',
          action: 'extract',
          extract: {
            as: 'note',
            source: { kind: 'control', ref: { role: 'cell', name: 'Balance' } },
            pattern: '\\d+',
            transform: 'trim',
          },
        }),
      ],
    });
    const r = await h.run(cap);
    if (r.status === 'success') expect(r.outputs).toEqual({ note: '4182' });
  });

  it('logs an undeclared extraction as an ordinary value', async () => {
    // The linter warns about this; it is not blocking, so the engine handles it.
    const h = harness({ detail: DETAIL }, {}, 'detail');
    const cap = capability({
      returns: {},
      steps: [
        step({
          id: 's1',
          action: 'extract',
          extract: { as: 'strayValue', source: { kind: 'control', ref: { role: 'cell', name: 'Balance' } }, transform: 'trim' },
        }),
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('success');
    const log = await import('node:fs').then((fs) => fs.readFileSync(`${h.recorder.dir}/run.jsonl`, 'utf8'));
    expect(log).toContain('4182.55');
  });
});

describe('recovery from a failed action', () => {
  it('recovers without retrying when the artifact says not to', async () => {
    const h = harness({ search: SEARCH, detail: DETAIL }, {}, 'search');
    const cap = capability({
      steps: [step({ id: 's1', action: 'click', ref: { role: 'button', name: 'Nowhere' } })],
      recoveries: [
        {
          id: 'move-on',
          description: 'the control is gone; carry on',
          // True on either screen, so the trigger still holds after the action
          // failed. One allowance is spent on the proactive check beforehand.
          when: { kind: 'textAbsent', text: 'NEVER APPEARS' },
          do: [{ kind: 'navigate', url: '{{baseUrl}}/member/detail' }],
          maxPerRun: 2,
          retryStep: false,
        },
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('success');
    expect(r.steps[0]!.status).toBe('recovered');
  });

  it('escalates a precondition failure when the step says to', async () => {
    const h = harness({ search: SEARCH, detail: DETAIL }, {}, 'search', {
      resolver: (getBroker) => async (i) => {
        getBroker().claim((i as { id: string }).id, 'op');
        h.driver.current = 'detail';
        return { action: 'resume', by: 'op', at: new Date().toISOString() };
      },
    });
    const cap = capability({
      steps: [
        step({
          id: 's1',
          action: 'assert',
          waitFor: { kind: 'textPresent', text: 'MEMBER DETAIL' },
          onCheckpointFail: 'escalate',
          timeoutMs: 150,
        }),
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('success');
    expect(r.steps[0]!.note).toContain('operator');
  });

  it('reports a step replayed during a recovery that then fails', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability({
      entryUrlTemplate: '{{baseUrl}}/member/search',
      steps: [
        step({ id: 's1', phase: 'signon', action: 'click', ref: { role: 'button', name: 'Retrieve' } }),
        step({ id: 's2', phase: 'input', action: 'assert', checkpoint: { kind: 'textPresent', text: 'MEMBER DETAIL' }, timeoutMs: 150 }),
      ],
      recoveries: [
        {
          id: 'rebuild',
          description: 'rebuild from sign-on',
          when: { kind: 'textPresent', text: 'MEMBER INQUIRY' },
          do: [{ kind: 'replayFrom', phase: 'signon' }],
          maxPerRun: 2,
          retryStep: true,
        },
      ],
    });
    // The replayed step cannot resolve its control the second time around.
    let clicks = 0;
    h.driver.click = async () => {
      clicks += 1;
      if (clicks > 1) throw new Error('the control vanished');
    };
    const r = await h.run(cap);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failure.class).toBe('driver_error');
  });
});

describe('an operator resolution with nothing filled in', () => {
  it('still returns a business outcome the caller can read', async () => {
    const h = harness({ search: SEARCH }, {}, 'search', {
      resolver: (getBroker) => async (i) => {
        getBroker().claim((i as { id: string }).id, 'op');
        return { action: 'outcome', by: 'op', at: new Date().toISOString() };
      },
    });
    const cap = capability({
      steps: [
        step({ id: 's1', action: 'assert', checkpoint: { kind: 'textPresent', text: 'NEVER' }, onCheckpointFail: 'escalate', timeoutMs: 150 }),
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('business_outcome');
    if (r.status !== 'business_outcome') return;
    expect(r.outcome.id).toBe('OPERATOR_DECLARED');
    expect(r.outcome.detail).toContain('did not hold');
  });
});

describe('a step that is refused with no reason given', () => {
  it('still reports a policy block', async () => {
    const h = harness({ search: SEARCH }, {}, 'search', { policy: { maxSteps: 0 } });
    const cap = capability({ steps: [step({ id: 's1', action: 'click', ref: { role: 'button', name: 'Retrieve' } })] });
    const r = await h.run(cap);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failure.class).toBe('policy_blocked');
  });
});

describe('the environment secret resolver', () => {
  it('is used when the caller supplies none', async () => {
    process.env['MERIDIAN_TESTONLY'] = 'from-the-environment';
    try {
      const driver = new FakeDriver(structuredClone({ search: SEARCH }), {}, 'search');
      const recorder = new RunRecorder({ kind: 'replay', root: mkdtempSync(`${tmpdir()}/handspan-`) });
      const cap = capability({
        secrets: ['meridian.testonly'],
        steps: [step({ id: 's1', action: 'fill', ref: { role: 'textbox', name: 'Member Number' }, value: '{{secret:meridian.testonly}}' })],
      });
      const r = await replay({
        capability: cap,
        inputs: { memberId: '12345' },
        driver,
        recorder,
        basePolicy: { ...DEFAULT_POLICY, allowedOrigins: [BASE] },
        baseUrl: BASE,
        tenant: 'tenant-a',
        attended: true,
      });
      expect(r.status).toBe('success');
    } finally {
      delete process.env['MERIDIAN_TESTONLY'];
    }
  });
});

describe('the last of the recovery paths', () => {
  it('retries the step after a recovery in the action path', async () => {
    const h = harness({ search: SEARCH, detail: DETAIL }, {}, 'search');
    let clicks = 0;
    h.driver.click = async () => {
      clicks += 1;
      if (clicks === 1) throw new Error('transient');
    };
    const cap = capability({
      steps: [step({ id: 's1', action: 'click', ref: { role: 'button', name: 'Retrieve' } })],
      recoveries: [
        {
          id: 'retry-after-a-blip',
          description: 'the first attempt fails on a transient',
          when: { kind: 'textAbsent', text: 'NEVER APPEARS' },
          do: [{ kind: 'wait', ms: 1 }],
          maxPerRun: 3,
          retryStep: true,
        },
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('success');
    expect(clicks).toBeGreaterThan(1);
    expect(r.steps[0]!.status).toBe('recovered');
  });

  it('escalates when the checkpoint still fails after a recovery', async () => {
    const h = harness({ search: SEARCH }, {}, 'search', {
      resolver: (getBroker) => async (i) => {
        getBroker().claim((i as { id: string }).id, 'op');
        return { action: 'abort', by: 'op', at: new Date().toISOString() };
      },
    });
    const cap = capability({
      steps: [
        step({
          id: 's1',
          action: 'assert',
          checkpoint: { kind: 'textPresent', text: 'MEMBER DETAIL' },
          onCheckpointFail: 'escalate',
          timeoutMs: 150,
        }),
      ],
      recoveries: [
        {
          id: 'useless',
          description: 'changes nothing',
          when: { kind: 'textAbsent', text: 'NEVER APPEARS' },
          do: [{ kind: 'wait', ms: 1 }],
          maxPerRun: 3,
          retryStep: false,
        },
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('escalated');
  });

  it('reports an extraction reference with no name', async () => {
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability({
      returns: { note: { type: 'string', description: 'n' } },
      steps: [
        step({
          id: 's1',
          action: 'extract',
          extract: { as: 'note', source: { kind: 'control', ref: { role: 'cell' } }, transform: 'trim' },
        }),
      ],
    });
    const r = await h.run(cap);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failure.observed).toContain('cannot read cell ""');
  });
});

describe('faults in the machinery itself', () => {
  it('does not mistake a broken parameter pattern for a bad input', async () => {
    // The schema does not check that a pattern compiles, so a malformed
    // artifact reaches validation and must not be reported as the caller's fault.
    const cap = capability({
      params: { memberId: { type: 'string', description: 'm', pattern: '([', sensitivity: 'none' } },
    });
    expect(() => precheckCapability(cap, { memberId: '12345' }, { attended: true })).toThrow(SyntaxError);
  });

  it('does not swallow an unexpected failure while escalating', async () => {
    const h = harness({ search: SEARCH }, {}, 'search', {
      resolver: () => async () => {
        throw new Error('the intervention queue is down');
      },
    });
    const cap = capability({
      steps: [
        step({
          id: 's1',
          action: 'assert',
          checkpoint: { kind: 'textPresent', text: 'NEVER' },
          onCheckpointFail: 'escalate',
          timeoutMs: 150,
        }),
      ],
    });
    // It surfaces as a run failure naming the real fault, rather than being
    // reported as a checkpoint problem or swallowed.
    const r = await h.run(cap);
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.failure.class).toBe('driver_error');
    expect(r.failure.message).toContain('queue is down');
  });

  it('reports a step that aborted while a recovery was rebuilding the flow', async () => {
    // The replay happens outside the step's own try, so the abort unwinds to
    // the run's handler and must still be classified.
    const h = harness({ search: SEARCH }, {}, 'search');
    const cap = capability({
      entryUrlTemplate: '{{baseUrl}}/member/search',
      steps: [
        step({ id: 's1', phase: 'signon', action: 'click', ref: { role: 'button', name: 'Retrieve' } }),
        step({
          id: 's2',
          phase: 'input',
          action: 'assert',
          checkpoint: { kind: 'textPresent', text: 'MEMBER DETAIL' },
          timeoutMs: 150,
        }),
      ],
      recoveries: [
        {
          id: 'rebuild',
          description: 'rebuild from sign-on',
          when: { kind: 'textAbsent', text: 'NEVER APPEARS' },
          do: [{ kind: 'replayFrom', phase: 'signon' }],
          maxPerRun: 3,
          retryStep: false,
        },
      ],
    });
    let clicks = 0;
    h.driver.click = async () => {
      clicks += 1;
      if (clicks > 1) throw new Error('the control vanished mid-rebuild');
    };
    const r = await h.run(cap);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.failure.class).toBe('driver_error');
  });
});
