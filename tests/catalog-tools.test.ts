/**
 * The agent-facing projection of an artifact.
 *
 * A tool definition is derived from the capability's public contract, never
 * written by hand, so these tests are really about what a calling agent is told:
 * the typed arguments, the values it gets back, and - the part that matters most -
 * the business outcomes it should branch on rather than treat as errors.
 */

import { describe, expect, it } from 'vitest';
import { toolForCapability } from '../src/catalog/tools.js';
import { computeContentHash } from '../src/artifact/store.js';
import { API_VERSION, zCapability, type Capability } from '../src/artifact/schema.js';

function capability(over: Record<string, unknown> = {}): Capability {
  return zCapability.parse({
    apiVersion: API_VERSION,
    id: 'meridian.member.subaccount_open',
    version: '2.1.0',
    title: 'Open a sub-account',
    summary: 'Open a new share sub-account and return the confirmation reference.',
    surface: 'web-legacy',
    app: { id: 'meridian-core-servicing', recordedForTenant: 'meridian-demo' },
    entryUrlTemplate: '{{baseUrl}}/',
    params: {
      memberId: { type: 'string', description: 'The member number', pattern: '^\\d{5}$', sensitivity: 'pii-id' },
      productCode: { type: 'string', description: 'Share product', enum: ['SV02', 'VC01'], sensitivity: 'none' },
      initialDeposit: { type: 'money', description: 'Opening amount', minimum: 0, maximum: 10000, sensitivity: 'none' },
      note: { type: 'string', description: 'Optional memo', required: false, sensitivity: 'none' },
    },
    returns: { confirmationNumber: { type: 'string', description: 'Posting reference', sensitivity: 'none' } },
    steps: [{ id: 's1', intent: 'post it', action: 'click', ref: { role: 'button', name: 'Confirm and Post' }, risk: 'irreversible' }],
    outcomes: [
      { id: 'MEMBER_NOT_FOUND', description: 'No such member.', detect: { kind: 'textPresent', text: 'No member found' } },
      {
        id: 'PERMISSION_DENIED',
        description: 'The operator lacks the entitlement.',
        detect: { kind: 'textPresent', text: 'restricted' },
        disposition: 'escalate',
      },
    ],
    policy: { riskTier: 'irreversible', allowedOrigins: ['http://app.test'], requiresApproval: true },
    provenance: {
      discoveredBy: { model: 'test', runId: 'r', at: 'now', goal: 'g' },
      stability: { runs: 9, successes: 8, degradedSteps: [] },
    },
    ...over,
  }) as Capability;
}

describe('the tool contract', () => {
  it('names the tool after the capability, in a form a tool-calling API accepts', () => {
    expect(toolForCapability(capability()).name).toBe('meridian__member__subaccount_open');
  });

  it('projects each parameter with its type and every constraint it declares', () => {
    const t = toolForCapability(capability());
    expect(t.input_schema.properties['memberId']).toMatchObject({ type: 'string', pattern: '^\\d{5}$' });
    expect(t.input_schema.properties['productCode']).toMatchObject({ enum: ['SV02', 'VC01'] });
    expect(t.input_schema.properties['initialDeposit']).toMatchObject({ type: 'number', minimum: 0, maximum: 10000 });
    expect(t.input_schema.required).toEqual(['memberId', 'productCode', 'initialDeposit']);
    expect(t.input_schema.additionalProperties).toBe(false);
  });

  it('tells the agent when an argument is regulated data', () => {
    const t = toolForCapability(capability());
    expect((t.input_schema.properties['memberId'] as { description: string }).description).toContain('pii-id');
    expect((t.input_schema.properties['productCode'] as { description: string }).description).not.toContain('(');
  });

  it('falls back to a string for a type with no json equivalent', () => {
    const t = toolForCapability(
      capability({
        params: { when: { type: 'date', description: 'Effective date', sensitivity: 'none', required: true } },
        returns: {},
        steps: [{ id: 's1', intent: 'x', action: 'assert' }],
        policy: { riskTier: 'read_only', allowedOrigins: ['http://app.test'] },
      }),
    );
    expect(t.input_schema.properties['when']).toMatchObject({ type: 'string' });
  });
});

describe('what the description tells a calling agent', () => {
  it('lists the return values and the business outcomes it may get instead', () => {
    const d = toolForCapability(capability()).description;
    expect(d).toContain('Returns on success:');
    expect(d).toContain('confirmationNumber (string): Posting reference');
    expect(d).toContain('business outcomes, which are answers rather than errors');
    expect(d).toContain('MEMBER_NOT_FOUND');
    // An escalate-disposition outcome is not something the caller receives.
    expect(d).not.toContain('PERMISSION_DENIED');
  });

  it('says plainly that the capability commits something irreversible', () => {
    expect(toolForCapability(capability()).description).toContain('cannot be undone');
  });

  it('says why it is not invocable, rather than hiding it', () => {
    const t = toolForCapability(capability());
    expect(t.handspan.invocable).toBe(false);
    expect(t.description).toContain('Not currently invocable');
  });

  it('omits the refusal once the artifact is approved', () => {
    const cap = capability();
    cap.provenance.approval = { state: 'approved', by: 'R', at: 'now', contentHash: computeContentHash(cap) };
    const t = toolForCapability(cap);
    expect(t.handspan.invocable).toBe(true);
    expect(t.description).not.toContain('Not currently invocable');
  });

  it('says "(no values)" rather than leaving the returns section empty', () => {
    const d = toolForCapability(
      capability({
        returns: {},
        outcomes: [],
        steps: [{ id: 's1', intent: 'x', action: 'assert' }],
        policy: { riskTier: 'read_only', allowedOrigins: ['http://app.test'] },
      }),
    ).description;
    expect(d).toContain('(no values)');
    expect(d).not.toContain('business outcomes');
    expect(d).not.toContain('cannot be undone');
  });
});

describe('the catalog metadata', () => {
  it('carries the identity, the risk, the outcomes and the replay history', () => {
    expect(toolForCapability(capability()).handspan).toMatchObject({
      capabilityId: 'meridian.member.subaccount_open',
      version: '2.1.0',
      riskTier: 'irreversible',
      stability: { runs: 9, successes: 8 },
    });
    expect(toolForCapability(capability()).handspan.outcomes).toHaveLength(2);
  });
});
