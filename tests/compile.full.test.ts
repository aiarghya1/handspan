/**
 * The compiler, end to end.
 *
 * A trace goes in and an artifact comes out, and every rule that matters is
 * checked against the artifact rather than against intermediate state: values
 * become templates, credentials become vault references, checkpoints are
 * generalized, app-level conditions are merged in, the risk tier is derived,
 * and a step that does a recovery's job becomes conditional on that recovery.
 */

import { describe, expect, it } from 'vitest';
import { compileCapability } from '../src/discover/compile.js';
import { lintCapability, lintErrors } from '../src/artifact/lint.js';
import { newTrace, type DiscoveryTrace, type TraceEntry } from '../src/discover/trace.js';
import { appProfile, goalSpec, BASE } from './fixtures.js';

function trace(entries: Array<Partial<TraceEntry>>, over: Partial<DiscoveryTrace> = {}): DiscoveryTrace {
  const t = newTrace({ goalId: 'meridian.member.savings_balance', goal: 'read the balance', model: 'scripted', runId: 'run-1' });
  t.entries = entries.map((e, i) => ({
    seq: i,
    at: '2026-09-12T00:00:00.000Z',
    action: 'click',
    intent: 'do a thing',
    phase: 'input',
    risk: 'read_only',
    ...e,
  })) as TraceEntry[];
  t.successText = 'MEMBER DETAIL';
  t.summary = 'read it';
  return { ...t, ...over };
}

const compile = (t: DiscoveryTrace, goal = goalSpec(), app = appProfile(), version?: string) =>
  compileCapability({ trace: t, goal, app, baseUrl: BASE, version });

const SIGNON: Partial<TraceEntry> = {
  action: 'fill',
  phase: 'signon',
  intent: 'enter the operator id',
  secretKey: 'meridian.username',
  ref: { role: 'textbox', name: 'Operator ID' },
  resolvedTier: 'role+name+scope',
};

const READ: Partial<TraceEntry> = {
  action: 'extract',
  phase: 'read',
  intent: 'read the balance',
  extract: {
    as: 'savingsBalance',
    source: { kind: 'control', ref: { role: 'cell', name: 'Balance', scope: { rowContaining: 'REGULAR SHARE SAVINGS' } } },
  },
};

describe('the artifact the compiler produces', () => {
  it('opens with an entry step whose checkpoint is the first control touched', () => {
    const cap = compile(trace([SIGNON, READ]));
    const entry = cap.steps[0]!;
    expect(entry).toMatchObject({ id: 's000', action: 'navigate', url: '{{baseUrl}}/' });
    expect(entry.checkpoint).toMatchObject({ kind: 'controlPresent' });
  });

  it('falls back to a url checkpoint when no step targets a control', () => {
    const cap = compile(trace([{ action: 'extract', phase: 'read', extract: { as: 'savingsBalance', source: { kind: 'text', pattern: '(\\d+)' } } }]));
    expect(cap.steps[0]!.checkpoint).toMatchObject({ kind: 'urlMatches' });
  });

  it('records a credential as a vault reference and declares the key', () => {
    const cap = compile(trace([SIGNON, READ]));
    expect(cap.steps[1]!.value).toBe('{{secret:meridian.username}}');
    expect(cap.secrets).toEqual(['meridian.username']);
    expect(JSON.stringify(cap)).not.toContain('value-of-');
  });

  it('templates a parameter and keeps a literal literal', () => {
    const cap = compile(
      trace([
        { action: 'fill', intent: 'member number', ref: { role: 'textbox', name: 'Member Number' }, value: '12345', parameter: 'memberId' },
        { action: 'fill', intent: 'suffix', ref: { role: 'textbox', name: 'Suffix' }, value: '0001' },
        READ,
      ]),
    );
    expect(cap.steps[1]!.value).toBe('{{memberId}}');
    expect(cap.steps[2]!.value).toBe('0001');
  });

  it('verifies a parameterized fill against the pattern the parameter declares', () => {
    const cap = compile(
      trace([
        { action: 'fill', intent: 'member number', ref: { role: 'textbox', name: 'Member Number' }, value: '12345', parameter: 'memberId' },
        READ,
      ]),
    );
    expect(cap.steps[1]!.checkpoint).toMatchObject({ kind: 'valueMatches', pattern: '^\\d{5}$' });
  });

  it('falls back to "not empty" when the parameter declares no pattern', () => {
    const goal = goalSpec({
      params: { note: { type: 'string', description: 'a note', required: true, sensitivity: 'none', value: 'audit' } },
      returns: {},
    });
    const cap = compile(
      trace([{ action: 'fill', intent: 'note', ref: { role: 'textbox', name: 'Note' }, value: 'audit', parameter: 'note' }]),
      goal,
    );
    expect(cap.steps[1]!.checkpoint).toMatchObject({ kind: 'valueMatches', pattern: '\\S' });
  });

  it('generalizes a checkpoint that contains the parameter value', () => {
    const cap = compile(
      trace([{ action: 'click', intent: 'retrieve', ref: { role: 'button', name: 'Retrieve' }, expect: 'MEMBER DETAIL - 12345' }, READ]),
    );
    expect(cap.steps[1]!.checkpoint).toMatchObject({ kind: 'textPresent', text: 'MEMBER DETAIL - \\S+', regex: true });
  });

  it('strips the parameter value out of a recorded scope', () => {
    const cap = compile(
      trace([
        {
          action: 'extract',
          phase: 'read',
          intent: 'read the name',
          extract: {
            as: 'savingsBalance',
            source: { kind: 'control', ref: { role: 'cell', name: 'Name', scope: { section: 'MEMBER DETAIL - 12345' } } },
          },
        },
      ]),
    );
    const source = cap.steps[1]!.extract!.source;
    expect(source.kind).toBe('control');
    if (source.kind === 'control') expect(source.ref.scope?.section).toBe('MEMBER DETAIL');
  });

  it('keeps a text-pattern extraction as it was recorded', () => {
    const cap = compile(
      trace([
        {
          action: 'extract',
          phase: 'read',
          intent: 'read the reference',
          extract: { as: 'savingsBalance', source: { kind: 'text', pattern: 'Confirmation (\\d+-\\d+)' } },
        },
      ]),
    );
    expect(cap.steps[1]!.extract!.source).toEqual({ kind: 'text', pattern: 'Confirmation (\\d+-\\d+)' });
  });

  it('chooses the transform from the declared return type', () => {
    const goal = goalSpec({
      returns: {
        m: { type: 'money', description: 'm' },
        i: { type: 'integer', description: 'i' },
        n: { type: 'number', description: 'n' },
        s: { type: 'string', description: 's' },
      },
    });
    const cap = compile(
      trace(
        (['m', 'i', 'n', 's'] as const).map((as) => ({
          action: 'extract' as const,
          phase: 'read' as const,
          intent: `read ${as}`,
          extract: { as, source: { kind: 'text' as const, pattern: '(x)' } },
        })),
      ),
      goal,
    );
    expect(cap.steps.slice(1, 5).map((s) => s.extract!.transform)).toEqual(['money', 'integer', 'number', 'trim']);
  });

  it('closes with an assert that states what success means', () => {
    const cap = compile(trace([SIGNON, READ]));
    const last = cap.steps[cap.steps.length - 1]!;
    expect(last).toMatchObject({ id: 's999', action: 'assert' });
    expect(last.checkpoint).toMatchObject({ kind: 'textPresent', text: 'MEMBER DETAIL' });
  });

  it('omits the closing assert when the run declared no success text', () => {
    const t = trace([SIGNON, READ]);
    t.successText = undefined;
    expect(compile(t).steps.some((s) => s.id === 's999')).toBe(false);
  });
});

describe('risk and approval', () => {
  it('derives the tier from the steps, and gates an irreversible flow', () => {
    const cap = compile(
      trace([
        { action: 'click', intent: 'post it', phase: 'commit', risk: 'irreversible', ref: { role: 'button', name: 'Confirm and Post' }, humanAssisted: true },
        READ,
      ]),
    );
    expect(cap.policy.riskTier).toBe('irreversible');
    expect(cap.policy.requiresApproval).toBe(true);
    // The step a human had to perform escalates rather than failing.
    expect(cap.steps[1]!.onCheckpointFail).toBe('escalate');
  });

  it('leaves a read-only flow ungated', () => {
    const cap = compile(trace([SIGNON, READ]));
    expect(cap.policy.riskTier).toBe('read_only');
    expect(cap.policy.requiresApproval).toBe(false);
  });

  it('records what discovery had to escalate, and whether a human was involved', () => {
    const t = trace([SIGNON, READ], { blockedActions: 2, humanAssisted: true });
    expect(compile(t).provenance.discoveredBy).toMatchObject({ blockedActions: 2, humanAssisted: true, model: 'scripted' });
  });

  it('starts as a draft at version 1.0.0, or the version it is told', () => {
    expect(compile(trace([READ])).version).toBe('1.0.0');
    expect(compile(trace([READ]), goalSpec(), appProfile(), '2.4.0').version).toBe('2.4.0');
    expect(compile(trace([READ])).provenance.approval.state).toBe('draft');
  });

  it('permits only the origin it was recorded against, and only the actions it used', () => {
    const cap = compile(trace([SIGNON, READ]));
    expect(cap.policy.allowedOrigins).toEqual([BASE]);
    expect(cap.policy.allowedActions.sort()).toEqual(['assert', 'extract', 'fill', 'navigate']);
  });

  it('takes the action allowlist from the app profile when it sets one', () => {
    const cap = compile(trace([SIGNON, READ]), goalSpec(), appProfile({ policy: { allowedPathPrefixes: [], sensitivePatterns: [], allowedActions: ['navigate', 'click'] } }));
    expect(cap.policy.allowedActions).toEqual(['navigate', 'click']);
  });
});

describe('outcomes and recoveries', () => {
  it('merges the app profile conditions in', () => {
    const cap = compile(trace([SIGNON, READ]));
    expect(cap.outcomes.map((o) => o.id)).toContain('MEMBER_NOT_FOUND');
    expect(cap.recoveries.map((r) => r.id)).toContain('dismiss-maintenance-notice');
  });

  it('records what the model declared, generalized the same way', () => {
    const t = trace([SIGNON, READ]);
    t.declaredOutcomes = [
      { id: 'PRODUCT_NOT_PERMITTED', description: 'not valid for this class', whenText: 'not valid for 12345', disposition: 'return' },
    ];
    const cap = compile(t);
    const declared = cap.outcomes.find((o) => o.id === 'PRODUCT_NOT_PERMITTED')!;
    expect(declared.detect).toMatchObject({ text: 'not valid for \\S+', regex: true });
  });

  it('lets the app profile win over the model on the same id', () => {
    // Written deliberately by someone who has seen the app fail, rather than
    // inferred from one run.
    const t = trace([SIGNON, READ]);
    t.declaredOutcomes = [
      { id: 'MEMBER_NOT_FOUND', description: 'the model guess', whenText: 'nothing found', disposition: 'escalate' },
    ];
    const found = compile(t).outcomes.find((o) => o.id === 'MEMBER_NOT_FOUND')!;
    expect(found.description).toContain('does not exist on this core');
    expect(found.disposition).toBe('return');
  });

  it('makes a step conditional when it is doing the work of a recovery', () => {
    const t = trace([
      {
        action: 'click',
        intent: 'dismiss the notice',
        ref: { role: 'button', name: 'Continue' },
        triggeredRecoveries: ['dismiss-maintenance-notice'],
      },
      READ,
    ]);
    const step = compile(t).steps[1]!;
    expect(step.optional).toBe(true);
    expect(step.waitFor).toMatchObject({ kind: 'controlPresent' });
    expect(step.intent).toContain('also handled by recovery');
  });

  it('leaves an identically named control alone when the recovery was not live', () => {
    // The sub-account form is also continued with a button called Continue.
    const t = trace([
      { action: 'click', intent: 'continue to the confirmation screen', ref: { role: 'button', name: 'Continue' }, triggeredRecoveries: [] },
      READ,
    ]);
    expect(compile(t).steps[1]!.optional).toBe(false);
  });

  it('leaves a step alone when the live recovery targets a different control', () => {
    const t = trace([
      { action: 'click', intent: 'retrieve', ref: { role: 'button', name: 'Retrieve' }, triggeredRecoveries: ['dismiss-maintenance-notice'] },
      READ,
    ]);
    expect(compile(t).steps[1]!.optional).toBe(false);
  });

  it('leaves an unnamed control alone, since it cannot be matched to a recovery', () => {
    const t = trace([{ action: 'click', intent: 'click something', ref: { role: 'button' }, triggeredRecoveries: ['dismiss-maintenance-notice'] }, READ]);
    expect(compile(t).steps[1]!.optional).toBe(false);
  });
});

describe('tenant overrides', () => {
  it('seeds an override for every other tenant the app profile knows', () => {
    const cap = compile(trace([SIGNON, READ]));
    const override = cap.tenantOverrides.find((t) => t.tenant === 'cu-northstar')!;
    expect(override).toMatchObject({ appVersion: '9.1', nameAliases: { Retrieve: 'Search' } });
    expect(override.allowedOrigins).toEqual(['http://other.test']);
    expect(override.entryUrlTemplate).toBe('http://other.test/');
    expect(cap.tenantOverrides.map((t) => t.tenant)).not.toContain('meridian-demo');
  });

  it('carries a note the profile supplies, or explains that it is unqualified', () => {
    const withNote = appProfile({
      tenants: {
        'meridian-demo': { baseUrl: BASE, nameAliases: {} },
        other: { baseUrl: 'http://o.test', note: 'migrated last quarter', nameAliases: {} },
      },
    });
    expect(compile(trace([READ]), goalSpec(), withNote).tenantOverrides[0]!.note).toBe('migrated last quarter');
    expect(compile(trace([READ])).tenantOverrides[0]!.note).toContain('not yet qualified');
  });
});

describe('what the compiler produces is valid', () => {
  it('passes its own linter', () => {
    const cap = compile(
      trace([
        SIGNON,
        { action: 'click', intent: 'sign on', phase: 'signon', ref: { role: 'button', name: 'Sign On' }, expect: 'MENU' },
        { action: 'fill', intent: 'member number', ref: { role: 'textbox', name: 'Member Number' }, value: '12345', parameter: 'memberId' },
        { action: 'click', intent: 'retrieve', ref: { role: 'button', name: 'Retrieve' }, expect: 'MEMBER DETAIL' },
        READ,
      ]),
    );
    expect(lintErrors(lintCapability(cap))).toEqual([]);
  });

  it('is deterministic: the same trace compiles to the same artifact', () => {
    const t = trace([SIGNON, READ]);
    expect(compile(t).contentHash ?? '').toBe('');
    // The hash is computed on serialization, so compare the bodies instead.
    const a = JSON.stringify({ ...compile(t), provenance: null });
    const b = JSON.stringify({ ...compile(t), provenance: null });
    expect(a).toBe(b);
  });
});

describe('parameter values that appear in a control name', () => {
  it('cuts them out of the name as well as the scope', () => {
    const cap = compile(
      trace([
        {
          action: 'click',
          intent: 'open the member',
          ref: { role: 'link', name: 'Member 12345 detail' },
          expect: 'MEMBER DETAIL',
        },
      ]),
    );
    expect(cap.steps[1]!.ref!.name).toBe('Member');
  });

  it('drops a name that was nothing but the parameter value', () => {
    const cap = compile(trace([{ action: 'click', intent: 'click it', ref: { role: 'link', name: '12345' }, expect: 'DONE' }]));
    expect(cap.steps[1]!.ref!.name).toBeUndefined();
  });
});

describe('a recovery that touches no control', () => {
  it('cannot shadow a step, whatever was on screen', () => {
    const app = appProfile({
      recoveries: [
        {
          id: 'just-wait',
          description: 'wait for the batch to clear',
          when: { kind: 'textPresent', text: 'please wait' },
          do: [{ kind: 'wait', ms: 100 }],
          maxPerRun: 1,
          retryStep: true,
        },
      ],
    });
    const t = trace([
      { action: 'click', intent: 'continue', ref: { role: 'button', name: 'Continue' }, triggeredRecoveries: ['just-wait'] },
    ]);
    expect(compile(t, goalSpec(), app).steps[1]!.optional).toBe(false);
  });
});

describe('a recovery whose action has no control name', () => {
  it('cannot shadow a step', () => {
    const app = appProfile({
      recoveries: [
        {
          id: 'click-something-unnamed',
          description: 'press whatever is there',
          when: { kind: 'textPresent', text: 'please confirm' },
          do: [{ kind: 'click', ref: { role: 'button' } }],
          maxPerRun: 1,
          retryStep: true,
        },
      ],
    });
    const t = trace([
      { action: 'click', intent: 'continue', ref: { role: 'button', name: 'Continue' }, triggeredRecoveries: ['click-something-unnamed'] },
    ]);
    expect(compile(t, goalSpec(), app).steps[1]!.optional).toBe(false);
  });
});
