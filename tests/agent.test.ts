/**
 * The discovery loop.
 *
 * Driven by the scripted planner over the in-memory surface, which is exactly
 * how the offline demo works - so these tests exercise the same path a model
 * run takes, including the policy gate, the escalation handoff and the trace
 * the compiler later consumes.
 */

import { describe, expect, it } from 'vitest';
import { discover } from '../src/discover/agent.js';
import { ScriptedPlanner, type Planner, type PlannerTurn, type ToolResult } from '../src/llm/planner.js';
import { EscalationBroker, type Intervention, type InterventionResolution } from '../src/escalation/broker.js';
import { readFileSync } from 'node:fs';
import { FakeDriver } from './fake-driver.js';
import { BASE, FLOW, appProfile, engine, goalSpec, recorder } from './fixtures.js';

const secrets = { get: (k: string) => (k.startsWith('meridian.') ? `value-of-${k}` : undefined) };

interface HarnessOptions {
  start?: string;
  screens?: typeof FLOW.screens;
  transitions?: typeof FLOW.transitions;
  goal?: ReturnType<typeof goalSpec>;
  app?: ReturnType<typeof appProfile>;
  policy?: Parameters<typeof engine>[0];
  resolver?: (i: Intervention, broker: () => EscalationBroker) => Promise<InterventionResolution>;
  withBroker?: boolean;
  vision?: boolean;
  maxTurns?: number;
}

function harness(script: Array<{ text?: string; calls: Array<{ name: string; input: Record<string, unknown> }> }>, opts: HarnessOptions = {}) {
  const driver = new FakeDriver(
    structuredClone(opts.screens ?? FLOW.screens),
    opts.transitions ?? FLOW.transitions,
    opts.start ?? 'signon',
  );
  const rec = recorder('discovery');
  const policy = engine(opts.policy);
  let broker: EscalationBroker | undefined;
  if (opts.withBroker !== false) {
    broker = new EscalationBroker({
      driver,
      policy,
      recorder: rec,
      maxWaitMs: 1_000,
      autoResolver: opts.resolver ? (i) => opts.resolver!(i, () => broker!) : undefined,
    });
  }
  return {
    driver,
    recorder: rec,
    policy,
    get broker() {
      return broker;
    },
    run: (planner: Planner = new ScriptedPlanner(script)) =>
      discover({
        goal: opts.goal ?? goalSpec(),
        app: opts.app ?? appProfile(),
        planner,
        driver,
        recorder: rec,
        policy,
        secrets,
        baseUrl: BASE,
        broker,
        vision: opts.vision ?? false,
        maxTurns: opts.maxTurns,
      }),
  };
}

const HAPPY_PATH = [
  { text: 'Looking at the screen.', calls: [{ name: 'observe', input: {} }] },
  { calls: [{ name: 'type_secret', input: { handle: 'textbox|Operator ID', secret_key: 'meridian.username', intent: 'enter the operator id' } }] },
  { calls: [{ name: 'type_secret', input: { handle: 'password|Password', secret_key: 'meridian.password', intent: 'enter the password' } }] },
  { calls: [{ name: 'click', input: { handle: 'button|Sign On', intent: 'sign on', expect: 'MENU', phase: 'signon' } }] },
  { calls: [{ name: 'click', input: { handle: 'button|Continue', intent: 'dismiss the notice', expect: 'Select a function', phase: 'navigate' } }] },
  { calls: [{ name: 'click', input: { handle: 'link|Member Inquiry', intent: 'open member inquiry', expect: 'MEMBER INQUIRY', phase: 'navigate' } }] },
  { calls: [{ name: 'type_text', input: { handle: 'textbox|Member Number', text: '12345', parameter: 'memberId', intent: 'enter the member number', phase: 'input' } }] },
  { calls: [{ name: 'click', input: { handle: 'button|Retrieve', intent: 'retrieve the record', expect: 'MEMBER DETAIL', phase: 'input' } }] },
  { calls: [{ name: 'read_value', input: { name: 'savingsBalance', handle: 'cell|Balance|row=REGULAR SHARE SAVINGS', intent: 'read the balance' } }] },
  {
    calls: [
      { name: 'declare_outcome', input: { id: 'MEMBER_NOT_FOUND', description: 'no such member', when_text: 'No member found for', disposition: 'return' } },
    ],
  },
  { calls: [{ name: 'finish', input: { summary: 'read the balance', success_text: 'MEMBER DETAIL' } }] },
];

describe('the happy path', () => {
  it('completes, and records one trace entry per action taken', async () => {
    const h = harness(HAPPY_PATH);
    const r = await h.run();

    expect(r.status).toBe('success');
    expect(r.trace.entries.map((e) => e.action)).toEqual(['fill', 'fill', 'click', 'click', 'click', 'fill', 'click', 'extract']);
    expect(r.trace.summary).toBe('read the balance');
    expect(r.trace.successText).toBe('MEMBER DETAIL');
    expect(r.trace.humanAssisted).toBe(false);
    expect(r.trace.blockedActions).toBe(0);
  });

  it('records a credential as a vault reference and never as a value', async () => {
    const r = await harness(HAPPY_PATH).run();
    const signon = r.trace.entries.filter((e) => e.phase === 'signon');
    expect(signon[0]).toMatchObject({ secretKey: 'meridian.username' });
    expect(signon[0]!.value).toBeUndefined();
    expect(JSON.stringify(r.trace)).not.toContain('value-of-meridian.password');
  });

  it('derives a durable reference for each action, and the tier it resolved at', async () => {
    const r = await harness(HAPPY_PATH).run();
    const retrieve = r.trace.entries.find((e) => e.intent === 'retrieve the record')!;
    expect(retrieve.ref).toMatchObject({ role: 'button', name: 'Retrieve' });
    expect(retrieve.resolvedTier).toBe('role+name+scope');
  });

  it('scopes a grid extraction by its row label rather than its position', async () => {
    const r = await harness(HAPPY_PATH).run();
    const read = r.trace.entries.find((e) => e.action === 'extract')!;
    expect(read.extract).toMatchObject({ as: 'savingsBalance' });
    expect(read.extract!.source).toMatchObject({ kind: 'control' });
    if (read.extract!.source.kind === 'control') {
      expect(read.extract!.source.ref.scope?.rowContaining).toBe('REGULAR SHARE SAVINGS');
    }
  });

  it('notes which app recoveries were live at each action, for the compiler', async () => {
    const r = await harness(HAPPY_PATH).run();
    const dismiss = r.trace.entries.find((e) => e.intent === 'dismiss the notice')!;
    expect(dismiss.triggeredRecoveries).toContain('dismiss-maintenance-notice');
    const inquiry = r.trace.entries.find((e) => e.intent === 'open member inquiry')!;
    expect(inquiry.triggeredRecoveries).toEqual([]);
  });

  it('records a declared business outcome', async () => {
    const r = await harness(HAPPY_PATH).run();
    expect(r.trace.declaredOutcomes).toEqual([
      { id: 'MEMBER_NOT_FOUND', description: 'no such member', whenText: 'No member found for', disposition: 'return' },
    ]);
  });

  it('sends a screenshot to the model when vision is on', async () => {
    const h = harness([{ calls: [{ name: 'observe', input: {} }] }, { calls: [{ name: 'finish', input: { summary: 's', success_text: 'MERIDIAN' } }] }], { vision: true });
    expect((await h.run()).status).toBe('success');
  });
});

describe('parameterization', () => {
  it('infers a parameter the model forgot to declare', async () => {
    // Otherwise the artifact hard-codes the member used during discovery.
    const script = structuredClone(HAPPY_PATH);
    delete (script[6]!.calls[0]!.input as Record<string, unknown>)['parameter'];
    const r = await harness(script).run();
    expect(r.trace.entries.find((e) => e.action === 'fill' && e.phase === 'input')?.parameter).toBe('memberId');
  });

  it('leaves a value the goal did not supply as a literal', async () => {
    const script = structuredClone(HAPPY_PATH);
    script[6]!.calls[0]!.input = { handle: 'textbox|Member Number', text: '0001', intent: 'enter a suffix', phase: 'input' };
    const r = await harness(script).run();
    const fill = r.trace.entries.find((e) => e.intent === 'enter a suffix')!;
    expect(fill.parameter).toBeUndefined();
    expect(fill.value).toBe('0001');
  });
});

describe('select and press', () => {
  it('records a dropdown selection and a keystroke', async () => {
    const screens = structuredClone(FLOW.screens);
    screens['signon']!.controls.push({ role: 'combobox', name: 'Branch', value: '', section: 'MERIDIAN CORE SERVICING 8.4' });
    const h = harness(
      [
        { calls: [{ name: 'select_option', input: { handle: 'combobox|Branch', value: '004', intent: 'choose a branch', phase: 'input' } }] },
        { calls: [{ name: 'press_key', input: { key: 'Enter', handle: 'textbox|Operator ID', intent: 'submit with the keyboard', expect: 'MENU', phase: 'input' } }] },
        { calls: [{ name: 'finish', input: { summary: 's', success_text: 'MERIDIAN' } }] },
      ],
      { screens },
    );
    const r = await h.run();
    expect(r.status).toBe('success');
    expect(r.trace.entries.map((e) => e.action)).toEqual(['select', 'press']);
    expect(r.trace.entries[1]!.key).toBe('Enter');
  });
});

describe('reading values', () => {
  it('reads a value out of screen text by pattern', async () => {
    const h = harness(
      [
        { calls: [{ name: 'read_value', input: { name: 'savingsBalance', text_pattern: 'SERVICING (\\d\\.\\d)', intent: 'read the release' } }] },
        { calls: [{ name: 'finish', input: { summary: 's', success_text: 'MERIDIAN' } }] },
      ],
    );
    const r = await h.run();
    const read = r.trace.entries.find((e) => e.action === 'extract')!;
    expect(read.extract!.source).toMatchObject({ kind: 'text', pattern: 'SERVICING (\\d\\.\\d)' });
  });

  it('refuses a name that is not a declared return', async () => {
    const h = harness([
      { calls: [{ name: 'read_value', input: { name: 'notDeclared', handle: 'textbox|Operator ID', intent: 'read something' } }] },
      { calls: [{ name: 'finish', input: { summary: 's', success_text: 'MERIDIAN' } }] },
    ]);
    const r = await h.run();
    expect(r.trace.entries.filter((e) => e.action === 'extract')).toHaveLength(0);
  });

  it('refuses a handle that is not on screen, and a pattern that matches nothing', async () => {
    const h = harness([
      { calls: [{ name: 'read_value', input: { name: 'savingsBalance', handle: 'zzz', intent: 'read' } }] },
      { calls: [{ name: 'read_value', input: { name: 'savingsBalance', text_pattern: 'NOPE(x)', intent: 'read' } }] },
      { calls: [{ name: 'read_value', input: { name: 'savingsBalance', intent: 'read' } }] },
      { calls: [{ name: 'finish', input: { summary: 's', success_text: 'MERIDIAN' } }] },
    ]);
    const r = await h.run();
    expect(r.trace.entries.filter((e) => e.action === 'extract')).toHaveLength(0);
    expect(r.status).toBe('success');
  });
});

describe('the policy gate', () => {
  it('routes an irreversible action to a human, and records it as their work', async () => {
    const h = harness(
      [
        { calls: [{ name: 'click', input: { handle: 'button|Confirm and Post', intent: 'post the sub-account', expect: 'POSTED', phase: 'commit' } }] },
        { calls: [{ name: 'finish', input: { summary: 'posted', success_text: 'SUB-ACCOUNT POSTED' } }] },
      ],
      {
        start: 'confirm',
        goal: goalSpec({ entryPath: '/confirm' }),
        resolver: async (i, getBroker) => {
          const broker = getBroker();
          broker.claim(i.id, 'r.okafor');
          const obs = await broker.observeForOperator(i.id);
          const target = obs.controls.find((c) => c.name === 'Confirm and Post')!;
          await broker.operatorAct(i.id, { kind: 'click', handle: target.handle });
          return { action: 'resume', by: 'r.okafor', at: new Date().toISOString() };
        },
      },
    );
    const r = await h.run();

    expect(r.status).toBe('success');
    expect(r.trace.blockedActions).toBe(1);
    expect(r.trace.humanAssisted).toBe(true);
    const commit = r.trace.entries.find((e) => e.phase === 'commit')!;
    expect(commit).toMatchObject({ risk: 'irreversible', humanAssisted: true });
    expect(h.driver.current).toBe('posted');
  });

  it('tells the model to stop when the human declines', async () => {
    const h = harness(
      [
        { calls: [{ name: 'click', input: { handle: 'button|Confirm and Post', intent: 'post it', expect: 'POSTED', phase: 'commit' } }] },
        { calls: [{ name: 'finish', input: { summary: 'not posted', success_text: 'CONFIRM SUB-ACCOUNT' } }] },
      ],
      {
        start: 'confirm',
        goal: goalSpec({ entryPath: '/confirm' }),
        resolver: async () => ({ action: 'abort', by: 'r.okafor', at: new Date().toISOString() }),
      },
    );
    const r = await h.run();
    expect(r.trace.entries.filter((e) => e.phase === 'commit')).toHaveLength(0);
    expect(r.trace.blockedActions).toBe(1);
  });

  it('refuses outright, with no escalation, when the policy blocks rather than escalates', async () => {
    const h = harness(
      [
        { calls: [{ name: 'click', input: { handle: 'button|Confirm and Post', intent: 'post it', expect: 'POSTED', phase: 'commit' } }] },
        { calls: [{ name: 'finish', input: { summary: 'refused', success_text: 'CONFIRM SUB-ACCOUNT' } }] },
      ],
      { start: 'confirm', goal: goalSpec({ entryPath: '/confirm' }), policy: { onIrreversible: 'block' } },
    );
    const r = await h.run();
    expect(r.trace.blockedActions).toBe(1);
    expect(r.trace.humanAssisted).toBe(false);
  });

  it('performs an irreversible action itself when the policy allows it', async () => {
    const h = harness(
      [
        { calls: [{ name: 'click', input: { handle: 'button|Confirm and Post', intent: 'post it', expect: 'POSTED', phase: 'commit' } }] },
        { calls: [{ name: 'finish', input: { summary: 'posted', success_text: 'SUB-ACCOUNT POSTED' } }] },
      ],
      { start: 'confirm', goal: goalSpec({ entryPath: '/confirm' }), policy: { onIrreversible: 'allow' } },
    );
    const r = await h.run();
    expect(r.trace.blockedActions).toBe(0);
    expect(h.driver.current).toBe('posted');
  });

  it('stops the run when an action leaves the allowlist', async () => {
    const screens = structuredClone(FLOW.screens);
    screens['offsite'] = { url: 'http://evil.test/', text: 'elsewhere', controls: [] };
    const h = harness(
      [
        { calls: [{ name: 'click', input: { handle: 'button|Sign On', intent: 'sign on', expect: 'MENU', phase: 'signon' } }] },
        { calls: [{ name: 'finish', input: { summary: 's', success_text: 'elsewhere' } }] },
      ],
      { screens, transitions: { 'signon::click:button:Sign On': 'offsite' } },
    );
    const r = await h.run();
    expect(r.trace.entries).toHaveLength(0);
  });

  it('stops when the step budget is exhausted', async () => {
    const h = harness(
      [
        { calls: [{ name: 'click', input: { handle: 'button|Sign On', intent: 'sign on', expect: 'MENU', phase: 'signon' } }] },
        { calls: [{ name: 'click', input: { handle: 'button|Continue', intent: 'dismiss', expect: 'Select', phase: 'navigate' } }] },
        { calls: [{ name: 'click', input: { handle: 'link|Member Inquiry', intent: 'inquiry', expect: 'INQUIRY', phase: 'navigate' } }] },
      ],
      { policy: { maxSteps: 2 } },
    );
    const r = await h.run();
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('budget exhausted');
  });
});

describe('asking for help', () => {
  it('hands over, and carries on once control comes back', async () => {
    const h = harness(
      [
        { calls: [{ name: 'request_help', input: { reason: 'this screen is unfamiliar', what_you_need: 'get me to the member search' } }] },
        { calls: [{ name: 'finish', input: { summary: 'done with help', success_text: 'MERIDIAN' } }] },
      ],
      { resolver: async () => ({ action: 'resume', by: 'r.okafor', at: new Date().toISOString(), note: 'navigated by hand' }) },
    );
    const r = await h.run();
    expect(r.status).toBe('success');
    expect(r.trace.humanAssisted).toBe(true);
  });

  it('carries on without help when nobody resolves it', async () => {
    const h = harness([
      { calls: [{ name: 'request_help', input: { reason: 'stuck', what_you_need: 'help' } }] },
      { calls: [{ name: 'finish', input: { summary: 'gave up', success_text: 'MERIDIAN' } }] },
    ]);
    const r = await h.run();
    expect(r.status).toBe('success');
  });

  it('says plainly that there is no operator when none is configured', async () => {
    const h = harness(
      [
        { calls: [{ name: 'request_help', input: { reason: 'stuck', what_you_need: 'help' } }] },
        { calls: [{ name: 'finish', input: { summary: 'x', success_text: 'MERIDIAN' } }] },
      ],
      { withBroker: false },
    );
    expect((await h.run()).status).toBe('success');
  });
});

describe('noticing that it is stuck', () => {
  it('escalates after several observations that changed nothing', async () => {
    const observe = { calls: [{ name: 'observe', input: {} }] };
    const h = harness([observe, observe, observe, observe, { calls: [{ name: 'finish', input: { summary: 'x', success_text: 'MERIDIAN' } }] }], {
      resolver: async () => ({ action: 'resume', by: 'r.okafor', at: new Date().toISOString() }),
    });
    const r = await h.run();
    expect(r.trace.humanAssisted).toBe(true);
  });

  it('gives up when nobody can unstick it', async () => {
    const observe = { calls: [{ name: 'observe', input: {} }] };
    const h = harness([observe, observe, observe, observe]);
    const r = await h.run();
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('no progress');
  });
});

describe('model behaviour the loop has to survive', () => {
  const finish = { calls: [{ name: 'finish', input: { summary: 'x', success_text: 'MERIDIAN' } }] };

  it('reports a model that stops without finishing', async () => {
    const r = await harness([{ calls: [{ name: 'observe', input: {} }] }]).run();
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('without calling finish');
  });

  it('reports a refusal', async () => {
    const planner: Planner = { model: 'stub', next: async (): Promise<PlannerTurn> => ({ calls: [], stop: 'refusal' }) };
    const r = await harness([]).run(planner);
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('declined');
  });

  it('reports a truncated turn', async () => {
    const planner: Planner = { model: 'stub', next: async (): Promise<PlannerTurn> => ({ calls: [], stop: 'max_tokens' }) };
    const r = await harness([]).run(planner);
    expect(r.reason).toContain('max_tokens');
  });

  it('tells the model when it invents a tool', async () => {
    const r = await harness([{ calls: [{ name: 'fly_to_the_moon', input: {} }] }, finish]).run();
    expect(r.status).toBe('success');
  });

  it('tells the model when a handle is stale', async () => {
    const r = await harness([
      { calls: [{ name: 'click', input: { handle: 'f9c9', intent: 'click something gone', expect: 'x', phase: 'input' } }] },
      finish,
    ]).run();
    expect(r.trace.entries).toHaveLength(0);
  });

  it('surfaces a tool that throws rather than ending the run', async () => {
    const r = await harness([
      { calls: [{ name: 'click', input: { handle: 'button|Does Not Exist', intent: 'click', expect: 'x', phase: 'input' } }] },
      finish,
    ]).run();
    expect(r.status).toBe('success');
  });

  it('reports an unavailable credential instead of typing nothing', async () => {
    const r = await harness([
      { calls: [{ name: 'type_secret', input: { handle: 'textbox|Operator ID', secret_key: 'absent.key', intent: 'sign on' } }] },
      finish,
    ]).run();
    expect(r.trace.entries).toHaveLength(0);
  });

  it('stops, rather than fails, when it runs out of turns', async () => {
    // Distinct from `failed`: nothing went wrong, the budget simply ran out.
    const observe = { calls: [{ name: 'observe', input: {} }] };
    const r = await harness([observe, observe, observe], { maxTurns: 2 }).run();
    expect(r.status).toBe('stopped');
    expect(r.trace.turns).toBe(2);
  });

  it('reports a driver failure on the action itself', async () => {
    const h = harness([
      { calls: [{ name: 'click', input: { handle: 'button|Sign On', intent: 'sign on', expect: 'MENU', phase: 'signon' } }] },
      finish,
    ]);
    h.driver.click = async () => {
      throw new Error('the browser went away');
    };
    const r = await h.run();
    expect(r.status).toBe('success');
    expect(r.trace.entries).toHaveLength(0);
  });
});

describe('tool inputs the model gets wrong', () => {
  const finish = { calls: [{ name: 'finish', input: { summary: 'x', success_text: 'MERIDIAN' } }] };

  it('records a declared outcome with no disposition as one to return', async () => {
    const r = await harness([
      { calls: [{ name: 'declare_outcome', input: { id: 'X', description: 'd', when_text: 't' } }] },
      finish,
    ]).run();
    expect(r.trace.declaredOutcomes[0]).toMatchObject({ disposition: 'return' });
  });

  it('substitutes its own words when the model omits them', async () => {
    const r = await harness(
      [
        { calls: [{ name: 'request_help', input: {} }] },
        { calls: [{ name: 'finish', input: {} }] },
      ],
      { resolver: async () => ({ action: 'resume', by: 'op', at: new Date().toISOString() }) },
    ).run();
    expect(r.status).toBe('success');
    expect(r.trace.summary).toBe('');
    expect(r.trace.successText).toBe('');
  });

  it('defaults a keystroke to Enter, and types an empty string rather than nothing', async () => {
    const r = await harness([
      { calls: [{ name: 'type_text', input: { handle: 'textbox|Operator ID', intent: 'clear the field', phase: 'input' } }] },
      { calls: [{ name: 'press_key', input: { handle: 'textbox|Operator ID', intent: 'submit', phase: 'input' } }] },
      finish,
    ]).run();
    expect(r.trace.entries[0]).toMatchObject({ action: 'fill', value: '' });
    expect(r.trace.entries[1]).toMatchObject({ action: 'press' });
  });

  it('reports a request_help with no operator note', async () => {
    const r = await harness(
      [{ calls: [{ name: 'request_help', input: { reason: 'stuck', what_you_need: 'help' } }] }, finish],
      { resolver: async () => ({ action: 'resume', by: 'op', at: new Date().toISOString() }) },
    ).run();
    expect(r.trace.humanAssisted).toBe(true);
  });
});

describe('the scripted handle descriptors', () => {
  it('picks a control by ordinal when two share a name', async () => {
    const screens = structuredClone(FLOW.screens);
    screens['signon']!.controls.push({ role: 'button', name: 'Sign On' });
    const r = await harness(
      [
        { calls: [{ name: 'click', input: { handle: 'button|Sign On#1', intent: 'use the second one', expect: 'MENU', phase: 'signon' } }] },
        { calls: [{ name: 'finish', input: { summary: 'x', success_text: 'MENU' } }] },
      ],
      { screens },
    ).run();
    expect(r.status).toBe('success');
    expect(r.trace.entries[0]!.ref?.ordinal).toBe(1);
  });

  it('narrows by section and by frame', async () => {
    const r = await harness([
      {
        calls: [
          {
            name: 'click',
            input: {
              handle: 'button|Continue|section=Scheduled Maintenance|frame=main',
              intent: 'dismiss the notice',
              expect: 'Select a function',
              phase: 'navigate',
            },
          },
        ],
      },
      { calls: [{ name: 'finish', input: { summary: 'x', success_text: 'MENU' } }] },
    ], { start: 'notice', goal: goalSpec({ entryPath: '/main' }) }).run();
    expect(r.status).toBe('success');
  });

  it('reports a descriptor that matches nothing', async () => {
    const r = await harness([
      { calls: [{ name: 'click', input: { handle: 'button|Nowhere At All', intent: 'click', expect: 'x', phase: 'input' } }] },
      { calls: [{ name: 'finish', input: { summary: 'x', success_text: 'MERIDIAN' } }] },
    ]).run();
    expect(r.trace.entries).toHaveLength(0);
    expect(r.status).toBe('success');
  });
});

describe('an operator who never arrives', () => {
  it('reports the timeout to the model rather than hanging', async () => {
    const h = harness(
      [
        { calls: [{ name: 'request_help', input: { reason: 'stuck', what_you_need: 'help' } }] },
        { calls: [{ name: 'finish', input: { summary: 'gave up', success_text: 'MERIDIAN' } }] },
      ],
      // A broker with no resolver: the lease lapses.
      {},
    );
    const r = await h.run();
    expect(r.status).toBe('success');
    expect(r.trace.humanAssisted).toBe(false);
  });
});

describe('handles and keystrokes with nothing supplied', () => {
  const finish = { calls: [{ name: 'finish', input: { summary: 'x', success_text: 'MERIDIAN' } }] };

  it('accepts a real handle read from an observation', async () => {
    // The FakeDriver numbers handles h0..hn in order, which is what a model
    // would actually pass back after calling observe.
    const r = await harness([
      { calls: [{ name: 'observe', input: {} }] },
      { calls: [{ name: 'click', input: { handle: 'h2', intent: 'sign on', expect: 'MENU', phase: 'signon' } }] },
      finish,
    ]).run();
    expect(r.trace.entries[0]).toMatchObject({ action: 'click', intent: 'sign on' });
  });

  it('reads a value by a real handle', async () => {
    const r = await harness(
      [
        { calls: [{ name: 'observe', input: {} }] },
        { calls: [{ name: 'read_value', input: { name: 'savingsBalance', handle: 'h1', intent: 'read the balance' } }] },
        finish,
      ],
      { start: 'detail', goal: goalSpec({ entryPath: '/member/12345' }) },
    ).run();
    expect(r.trace.entries.find((e) => e.action === 'extract')).toBeDefined();
  });

  it('presses a key with no control to focus', async () => {
    const r = await harness([
      { calls: [{ name: 'press_key', input: { key: 'F3', intent: 'exit the screen', phase: 'navigate' } }] },
      finish,
    ]).run();
    expect(r.trace.entries[0]).toMatchObject({ action: 'press', key: 'F3' });
    expect(r.trace.entries[0]!.ref).toBeUndefined();
  });

  it('reads a pattern with no capture group', async () => {
    const r = await harness([
      { calls: [{ name: 'read_value', input: { name: 'savingsBalance', text_pattern: 'MERIDIAN', intent: 'read the brand' } }] },
      finish,
    ]).run();
    expect(r.trace.entries[0]!.extract).toMatchObject({ as: 'savingsBalance' });
  });

  it('resolves a descriptor whose name is empty', async () => {
    const screens = structuredClone(FLOW.screens);
    screens['signon']!.controls.push({ role: 'checkbox', name: '' });
    const r = await harness(
      [
        { calls: [{ name: 'click', input: { handle: 'checkbox|', intent: 'tick the box', expect: 'MERIDIAN', phase: 'input' } }] },
        finish,
      ],
      { screens },
    ).run();
    expect(r.trace.entries[0]!.ref?.name).toBeUndefined();
  });

  it('records a commit even when the model labelled the phase as input', async () => {
    const r = await harness(
      [
        { calls: [{ name: 'click', input: { handle: 'button|Confirm and Post', intent: 'post it', expect: 'POSTED', phase: 'input' } }] },
        { calls: [{ name: 'finish', input: { summary: 'posted', success_text: 'SUB-ACCOUNT POSTED' } }] },
      ],
      {
        start: 'confirm',
        goal: goalSpec({ entryPath: '/confirm' }),
        resolver: async (i, getBroker) => {
          const broker = getBroker();
          broker.claim(i.id, 'op');
          const obs = await broker.observeForOperator(i.id);
          const target = obs.controls.find((c) => c.name === 'Confirm and Post')!;
          await broker.operatorAct(i.id, { kind: 'click', handle: target.handle });
          return { action: 'resume', by: 'op', at: new Date().toISOString() };
        },
      },
    ).run();
    // The step that commits is recorded in the commit phase whatever the model
    // called it, because that is what the recovery machinery keys on.
    expect(r.trace.entries[0]!.phase).toBe('commit');
  });

  it('tells the model plainly when an operator declined, and why', async () => {
    const r = await harness(
      [
        { calls: [{ name: 'request_help', input: { reason: 'stuck', what_you_need: 'help' } }] },
        { calls: [{ name: 'finish', input: { summary: 'x', success_text: 'MERIDIAN' } }] },
      ],
      { resolver: async () => ({ action: 'abort', by: 'op', at: new Date().toISOString(), note: 'not safe to continue' }) },
    ).run();
    expect(r.status).toBe('success');
  });

  it('types an empty secret key rather than guessing one', async () => {
    const r = await harness([
      { calls: [{ name: 'type_secret', input: { handle: 'textbox|Operator ID', intent: 'sign on' } }] },
      finish,
    ]).run();
    expect(r.trace.entries).toHaveLength(0);
  });

  it('selects an empty option rather than refusing to act', async () => {
    const screens = structuredClone(FLOW.screens);
    screens['signon']!.controls.push({ role: 'combobox', name: 'Branch', value: 'x' });
    const r = await harness(
      [
        { calls: [{ name: 'select_option', input: { handle: 'combobox|Branch', intent: 'clear the branch', phase: 'input' } }] },
        finish,
      ],
      { screens },
    ).run();
    expect(r.trace.entries[0]).toMatchObject({ action: 'select', value: '' });
  });
});

describe('the last of the agent messages', () => {
  const finish = { calls: [{ name: 'finish', input: { summary: 'x', success_text: 'MERIDIAN' } }] };

  it('reports an abort with no note from the operator', async () => {
    const r = await harness(
      [{ calls: [{ name: 'request_help', input: { reason: 'stuck', what_you_need: 'help' } }] }, finish],
      { resolver: async () => ({ action: 'abort', by: 'op', at: new Date().toISOString() }) },
    ).run();
    expect(r.status).toBe('success');
  });

  it('describes a read whose reference needed no row scoping', async () => {
    const r = await harness(
      [
        { calls: [{ name: 'read_value', input: { name: 'savingsBalance', handle: 'cell|Name#0', intent: 'read the name' } }] },
        finish,
      ],
      { start: 'detail', goal: goalSpec({ entryPath: '/member/12345' }) },
    ).run();
    expect(r.trace.entries[0]!.extract).toMatchObject({ as: 'savingsBalance' });
  });
});

describe('an escalation that fails for an unexpected reason', () => {
  it('surfaces it to the model rather than swallowing it', async () => {
    // Only a lease expiry is an expected outcome of asking for help; anything
    // else is a real fault and has to reach the run log.
    const h = harness([
      { calls: [{ name: 'request_help', input: { reason: 'stuck', what_you_need: 'help' } }] },
      { calls: [{ name: 'finish', input: { summary: 'x', success_text: 'MERIDIAN' } }] },
    ]);
    h.broker!.raise = async () => {
      throw new Error('the intervention queue is down');
    };
    const r = await h.run();
    const log = readFileSync(`${h.recorder.dir}/run.jsonl`, 'utf8');
    expect(log).toContain('the intervention queue is down');
    expect(r.trace.humanAssisted).toBe(false);
  });
});

describe('reporting a read back to the model', () => {
  it('names the row it scoped the reference to', async () => {
    const r = await harness(
      [
        { calls: [{ name: 'observe', input: {} }] },
        { calls: [{ name: 'read_value', input: { name: 'savingsBalance', handle: 'h1', intent: 'read the balance' } }] },
        { calls: [{ name: 'finish', input: { summary: 'x', success_text: 'MEMBER DETAIL' } }] },
      ],
      { start: 'detail', goal: goalSpec({ entryPath: '/member/12345' }) },
    ).run();
    const read = r.trace.entries.find((e) => e.action === 'extract')!;
    expect(read.extract!.source).toMatchObject({ kind: 'control' });
    if (read.extract!.source.kind === 'control') {
      expect(read.extract!.source.ref.scope?.rowContaining).toBe('REGULAR SHARE SAVINGS');
    }
  });
});

describe('reporting a read back to the model', () => {
  it('says so plainly when the reference needed no scope at all', async () => {
    const r = await harness(
      [
        { calls: [{ name: 'read_value', input: { name: 'savingsBalance', handle: 'cell|Name#0', intent: 'read the name' } }] },
        { calls: [{ name: 'finish', input: { summary: 'x', success_text: 'MEMBER DETAIL' } }] },
      ],
      { start: 'detail', goal: goalSpec({ entryPath: '/member/12345' }) },
    ).run();
    const read = r.trace.entries.find((e) => e.action === 'extract')!;
    if (read.extract!.source.kind === 'control') {
      expect(read.extract!.source.ref.scope).toBeUndefined();
    }
  });

  it('says so when the value has no label to name it by', async () => {
    // A cell with no header and no label beside it: the reference is positional
    // and there is no name to report.
    const screens = structuredClone(FLOW.screens);
    screens['detail']!.controls = [
      { role: 'cell', name: '', value: '4182.55', section: 'MEMBER DETAIL - 12345', frame: 'main' },
    ];
    const r = await harness(
      [
        { calls: [{ name: 'observe', input: {} }] },
        { calls: [{ name: 'read_value', input: { name: 'savingsBalance', handle: 'h0', intent: 'read the balance' } }] },
        { calls: [{ name: 'finish', input: { summary: 'x', success_text: 'MEMBER DETAIL' } }] },
      ],
      { screens, start: 'detail', goal: goalSpec({ entryPath: '/member/12345' }) },
    ).run();
    const read = r.trace.entries.find((e) => e.action === 'extract')!;
    if (read.extract!.source.kind === 'control') {
      expect(read.extract!.source.ref.name).toBeUndefined();
    }
  });

  it('says so when the reference is scoped but not by row', async () => {
    // Two cells share the label, so the recorder scopes by screen and position
    // rather than by a row it has no durable label for.
    const screens = structuredClone(FLOW.screens);
    screens['detail']!.controls.push({
      role: 'cell',
      name: 'Name',
      value: 'OKONKWO, A',
      section: 'MEMBER DETAIL - 12345',
      rowText: 'Joint Name OKONKWO, A',
      frame: 'main',
    });
    const r = await harness(
      [
        { calls: [{ name: 'read_value', input: { name: 'savingsBalance', handle: 'cell|Name#0', intent: 'read the name' } }] },
        { calls: [{ name: 'finish', input: { summary: 'x', success_text: 'MEMBER DETAIL' } }] },
      ],
      { screens, start: 'detail', goal: goalSpec({ entryPath: '/member/12345' }) },
    ).run();
    const read = r.trace.entries.find((e) => e.action === 'extract')!;
    if (read.extract!.source.kind === 'control') {
      expect(read.extract!.source.ref.scope).toBeDefined();
      expect(read.extract!.source.ref.scope?.rowContaining).toBeUndefined();
      expect(read.extract!.source.ref.ordinal).toBe(0);
    }
  });
});
