/**
 * Tenant specialization.
 *
 * The property worth guarding: one artifact serves a second tenant through
 * label aliases rather than being re-recorded, and the aliases reach every
 * reference in the file, not just the step targets.
 */

import { describe, expect, it } from 'vitest';
import { mapAllRefs, specializeForTenant, TenantNotSupportedError } from '../src/artifact/tenant.js';
import { capability } from './capability-fixture.js';

describe('tenant specialization', () => {
  const withOverride = () =>
    capability({
      tenantOverrides: [
        {
          tenant: 'tenant-b',
          appVersion: '9.1',
          nameAliases: { Retrieve: 'Search', 'REGULAR SHARE SAVINGS': 'REGULAR SAVINGS' },
          refPatches: [],
          disabledSteps: [],
          extraRecoveries: [],
          entryUrlTemplate: 'http://b.test/',
          allowedOrigins: ['http://b.test'],
        },
      ],
    });

  it('returns the artifact unchanged for the tenant it was recorded against', () => {
    const cap = capability();
    expect(specializeForTenant(cap, 'tenant-a').capability).toBe(cap);
  });

  it('rewrites a relabelled control everywhere it appears', () => {
    const { capability: out } = specializeForTenant(withOverride(), 'tenant-b');
    expect(out.steps.find((s) => s.id === 's2')!.ref!.name).toBe('Search');
  });

  it('also rewrites labels used as scope, not just control names', () => {
    // The savings product is renamed in this tenant's build, and it appears as
    // a row label rather than as a control name. Aliasing only names would
    // leave the extraction pointing at a row that no longer exists.
    const { capability: out } = specializeForTenant(withOverride(), 'tenant-b');
    const extract = out.steps.find((s) => s.id === 's3')!.extract!;
    expect(extract.source.kind).toBe('control');
    if (extract.source.kind === 'control') {
      expect(extract.source.ref.scope?.rowContaining).toBe('REGULAR SAVINGS');
    }
  });

  it('narrows the origin allowlist to the tenant it is running against', () => {
    const { capability: out } = specializeForTenant(withOverride(), 'tenant-b');
    expect(out.policy.allowedOrigins).toEqual(['http://b.test']);
  });

  it('refuses an unknown tenant rather than pointing a recording at the wrong institution', () => {
    expect(() => specializeForTenant(capability(), 'tenant-z')).toThrow(TenantNotSupportedError);
  });

  it('can be relaxed to qualify a new tenant by observing which steps degrade', () => {
    expect(specializeForTenant(capability(), 'tenant-z', { strict: false }).capability.id).toBe('meridian.member.balance');
  });
});
describe('rewriting every reference in an artifact', () => {
  it('reaches step refs, checkpoints, preconditions, extractions, outcomes and recoveries', () => {
    const cap = capability({
      steps: [
        {
          id: 's1',
          intent: 'click it',
          action: 'click',
          ref: { role: 'button', name: 'Retrieve' },
          waitFor: { kind: 'controlPresent', ref: { role: 'button', name: 'Retrieve' } },
          checkpoint: {
            kind: 'allOf',
            of: [
              { kind: 'controlAbsent', ref: { role: 'button', name: 'Retrieve' } },
              { kind: 'not', of: { kind: 'valueMatches', ref: { role: 'textbox', name: 'Retrieve' }, pattern: '.' } },
              { kind: 'anyOf', of: [{ kind: 'textPresent', text: 'x' }] },
              { kind: 'urlMatches', pattern: '/x' },
            ],
          },
        },
        {
          id: 's2',
          intent: 'read it',
          action: 'extract',
          extract: {
            as: 'savingsBalance',
            source: { kind: 'control', ref: { role: 'cell', name: 'Retrieve' } },
            transform: 'money',
          },
        },
        {
          id: 's3',
          intent: 'read text',
          action: 'extract',
          extract: { as: 'other', source: { kind: 'text', pattern: 'x(y)' }, transform: 'trim' },
        },
      ],
      returns: { savingsBalance: { type: 'money', description: 'b' }, other: { type: 'string', description: 'o' } },
      outcomes: [
        {
          id: 'SOMETHING',
          description: 'd',
          detect: { kind: 'controlPresent', ref: { role: 'alert', name: 'Retrieve' } },
          extract: [
            { as: 'a', source: { kind: 'control', ref: { role: 'cell', name: 'Retrieve' } }, transform: 'trim' },
            { as: 'b', source: { kind: 'text', pattern: 'z(1)' }, transform: 'trim' },
          ],
        },
      ],
      recoveries: [
        {
          id: 'r1',
          description: 'd',
          when: { kind: 'controlPresent', ref: { role: 'dialog', name: 'Retrieve' } },
          do: [
            { kind: 'click', ref: { role: 'button', name: 'Retrieve' } },
            { kind: 'fill', ref: { role: 'textbox', name: 'Retrieve' }, value: 'x' },
            { kind: 'navigate', url: '{{baseUrl}}/' },
            { kind: 'wait', ms: 10 },
            { kind: 'replayFrom', phase: 'signon' },
          ],
        },
      ],
    });

    const renamed = mapAllRefs(cap, (r) => (r.name === 'Retrieve' ? { ...r, name: 'Search' } : r));
    // Every occurrence, and nothing else.
    expect(JSON.stringify(renamed)).not.toContain('Retrieve');
    // One per rewritten reference: the step ref, its precondition, two inside
    // the checkpoint, the extraction, the outcome detector and its extraction,
    // and the two the recovery acts on.
    expect(JSON.stringify(renamed).match(/Search/g)!.length).toBe(10);
    // A text-source extraction has no ref to rewrite and must survive intact.
    expect(JSON.stringify(renamed)).toContain('x(y)');
    expect(JSON.stringify(renamed)).toContain('z(1)');
  });
});
describe('tenant specialization, the remaining shapes', () => {
  const base = () =>
    capability({
      steps: [
        { id: 's1', intent: 'a', action: 'click', ref: { role: 'button', name: 'Retrieve' } },
        { id: 's2', intent: 'b', action: 'click', ref: { role: 'link', name: 'Skip me' } },
        { id: 's3', intent: 'c', action: 'assert' },
      ],
      returns: {},
    });

  it('patches the reference of one step without touching the others', () => {
    const cap = base();
    cap.tenantOverrides = [
      {
        tenant: 't',
        nameAliases: {},
        refPatches: [
          { stepId: 's1', ref: { name: 'Find' } },
          // A patch for a step that has no ref at all is ignored rather than fatal.
          { stepId: 's3', ref: { name: 'Nothing' } },
        ],
        disabledSteps: [],
        extraRecoveries: [],
      },
    ];
    const out = specializeForTenant(cap, 't').capability;
    expect(out.steps.find((s) => s.id === 's1')!.ref!.name).toBe('Find');
    expect(out.steps.find((s) => s.id === 's2')!.ref!.name).toBe('Skip me');
  });

  it('drops steps a tenant does not have', () => {
    const cap = base();
    cap.tenantOverrides = [
      { tenant: 't', nameAliases: {}, refPatches: [], disabledSteps: ['s2'], extraRecoveries: [] },
    ];
    expect(specializeForTenant(cap, 't').capability.steps.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('adds a recovery only this tenant needs', () => {
    const cap = base();
    cap.tenantOverrides = [
      {
        tenant: 't',
        nameAliases: {},
        refPatches: [],
        disabledSteps: [],
        extraRecoveries: [
          {
            id: 'tenant-only-notice',
            description: 'only this institution shows it',
            when: { kind: 'textPresent', text: 'Regional notice' },
            do: [{ kind: 'click', ref: { role: 'button', name: 'OK' } }],
            maxPerRun: 1,
            retryStep: true,
          },
        ],
      },
    ];
    const out = specializeForTenant(cap, 't').capability;
    expect(out.recoveries.map((r) => r.id)).toContain('tenant-only-notice');
  });

  it('overrides the entry point, and returns the override it used', () => {
    const cap = base();
    cap.tenantOverrides = [
      {
        tenant: 't',
        nameAliases: {},
        refPatches: [],
        disabledSteps: [],
        extraRecoveries: [],
        entryUrlTemplate: 'http://t.test/start',
      },
    ];
    const { capability: out, override } = specializeForTenant(cap, 't');
    expect(out.entryUrlTemplate).toBe('http://t.test/start');
    expect(override!.tenant).toBe('t');
  });

  it('leaves an alias map alone when nothing matches', () => {
    const cap = base();
    cap.tenantOverrides = [
      { tenant: 't', nameAliases: { Absent: 'Other' }, refPatches: [], disabledSteps: [], extraRecoveries: [] },
    ];
    expect(specializeForTenant(cap, 't').capability.steps[0]!.ref!.name).toBe('Retrieve');
  });

  it('needs no tenant at all when none is given', () => {
    const cap = base();
    expect(specializeForTenant(cap, undefined).capability).toBe(cap);
  });

  it('accepts any tenant for an artifact that names none, since there is no claim to break', () => {
    const anonymous = capability({ app: { id: 'meridian-core-servicing' }, returns: {} });
    expect(specializeForTenant(anonymous, 'anyone').capability).toBe(anonymous);
  });
});
