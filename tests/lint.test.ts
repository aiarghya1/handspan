/**
 * The artifact linter.
 *
 * Every rule here exists because a wrong artifact does the wrong thing to the
 * right application, and static checks are the cheapest place to catch that.
 */

import { describe, expect, it } from 'vitest';
import { lintCapability, lintErrors } from '../src/artifact/lint.js';
import { computeContentHash } from '../src/artifact/store.js';
import type { Capability } from '../src/artifact/schema.js';
import { capability } from './capability-fixture.js';

describe('lint', () => {
  it('passes a well-formed artifact', () => {
    expect(lintErrors(lintCapability(capability()))).toHaveLength(0);
  });

  it('catches a literal that looks like regulated data', () => {
    const cap = capability();
    cap.steps[0]!.value = '412-88-0031';
    expect(lintCapability(cap).map((f) => f.code)).toContain('literal-sensitive-value');
  });

  it('catches a reference to an undeclared parameter', () => {
    const cap = capability();
    cap.steps[0]!.value = '{{ssn}}';
    expect(lintCapability(cap).map((f) => f.code)).toContain('undeclared-param');
  });

  it('catches a secret that is not declared in secrets[]', () => {
    const cap = capability();
    cap.steps[0]!.value = '{{secret:other.password}}';
    expect(lintCapability(cap).map((f) => f.code)).toContain('undeclared-secret');
  });

  it('catches a declared return that no step produces', () => {
    const cap = capability();
    cap.steps = cap.steps.filter((s) => s.id !== 's3');
    expect(lintCapability(cap).map((f) => f.code)).toContain('unproduced-return');
  });

  it('does not confuse outcome data with a declared return', () => {
    const cap = capability();
    cap.outcomes[0]!.extract = [
      { as: 'searchedFor', source: { kind: 'text', pattern: 'for (\\d+)' }, transform: 'trim' },
    ];
    expect(lintCapability(cap).map((f) => f.code)).not.toContain('undeclared-return');
  });

  it('catches an understated risk tier', () => {
    const cap = capability();
    cap.steps[1]!.risk = 'irreversible';
    expect(lintCapability(cap).map((f) => f.code)).toContain('risk-understated');
  });

  it('warns about an unverified mutating step', () => {
    const cap = capability();
    cap.steps[1]!.checkpoint = undefined;
    expect(lintCapability(cap).map((f) => f.code)).toContain('unverified-step');
  });

  it('warns about an ungated irreversible step', () => {
    const cap = capability();
    cap.steps[1]!.risk = 'irreversible';
    cap.policy.riskTier = 'irreversible';
    expect(lintCapability(cap).map((f) => f.code)).toContain('ungated-irreversible');
  });

  it('catches a tampered content hash', () => {
    const cap = capability({ contentHash: 'deadbeef' });
    expect(lintCapability(cap).map((f) => f.code)).toContain('hash-mismatch');
  });
});
describe('lint, the remaining rules', () => {
  it('rejects an unexpected apiVersion', () => {
    const cap = { ...capability(), apiVersion: 'handspan.dev/capability/v99' } as unknown as Capability;
    expect(lintCapability(cap).map((f) => f.code)).toContain('api-version');
  });

  it('rejects duplicate step and outcome ids', () => {
    const cap = capability();
    cap.steps.push({ ...cap.steps[0]! });
    cap.outcomes.push({ ...cap.outcomes[0]! });
    const codes = lintCapability(cap).map((f) => f.code);
    expect(codes).toContain('duplicate-step-id');
    expect(codes).toContain('duplicate-outcome-id');
  });

  it('warns about an outcome checked after a step that does not exist', () => {
    const cap = capability();
    cap.outcomes[0]!.checkAfter = ['s99'];
    expect(lintCapability(cap).map((f) => f.code)).toContain('unknown-step-ref');
  });

  it('rejects reading an output that is produced later, or not at all', () => {
    const forward = capability();
    forward.steps[0]!.value = '{{out:savingsBalance}}';
    expect(lintCapability(forward).map((f) => f.code)).toContain('forward-output-ref');

    const missing = capability();
    missing.steps[0]!.value = '{{out:nothing}}';
    expect(lintCapability(missing).map((f) => f.code)).toContain('unknown-output-ref');
  });

  it('accepts reading an output an earlier step produced, or an outcome supplies', () => {
    const cap = capability();
    cap.steps.splice(2, 0, {
      ...cap.steps[0]!,
      id: 's2b',
      action: 'extract',
      ref: undefined,
      value: undefined,
      checkpoint: undefined,
      extract: { as: 'ref', source: { kind: 'text', pattern: 'r(1)' }, transform: 'trim' },
    });
    cap.steps[cap.steps.length - 1] = {
      ...cap.steps[cap.steps.length - 1]!,
      id: 's9',
      action: 'navigate',
      url: '{{baseUrl}}/{{out:ref}}',
      extract: undefined,
    };
    cap.returns = { ...cap.returns, ref: { type: 'string', description: 'r', sensitivity: 'none', required: true } };
    const codes = lintCapability(cap).map((f) => f.code);
    expect(codes).not.toContain('unknown-output-ref');
    expect(codes).not.toContain('forward-output-ref');
  });

  it('rejects a step whose shape does not match its action', () => {
    const noUrl = capability();
    noUrl.steps[1] = { ...noUrl.steps[1]!, action: 'navigate', url: undefined, ref: undefined };
    expect(lintCapability(noUrl).map((f) => f.code)).toContain('navigate-without-url');

    const noSpec = capability();
    noSpec.steps[2] = { ...noSpec.steps[2]!, extract: undefined };
    expect(lintCapability(noSpec).map((f) => f.code)).toContain('extract-without-spec');

    const noTarget = capability();
    noTarget.steps[1] = { ...noTarget.steps[1]!, ref: undefined };
    expect(lintCapability(noTarget).map((f) => f.code)).toContain('action-without-target');
  });

  it('rejects an action the artifact does not permit itself', () => {
    const cap = capability();
    cap.policy.allowedActions = ['navigate'];
    expect(lintCapability(cap).map((f) => f.code)).toContain('action-not-allowed');
  });

  it('warns about a step that extracts something the contract does not declare', () => {
    const cap = capability();
    cap.returns = {};
    expect(lintCapability(cap).map((f) => f.code)).toContain('undeclared-return');
  });

  it('rejects a parameter declared as a secret', () => {
    const cap = capability();
    cap.params['token'] = { type: 'string', description: 'a token', required: true, sensitivity: 'secret' };
    expect(lintCapability(cap).map((f) => f.code)).toContain('secret-as-param');
  });

  it('warns about an example that looks like real data', () => {
    const cap = capability();
    cap.params['memberId']!.example = '412-88-0031';
    expect(lintCapability(cap).map((f) => f.code)).toContain('sensitive-example');
  });

  it('warns about a recovery that replays a phase with no steps in it', () => {
    const cap = capability();
    cap.recoveries = [
      {
        id: 'reauth',
        description: 'sign on again',
        when: { kind: 'textPresent', text: 'expired' },
        do: [{ kind: 'replayFrom', phase: 'signon' }],
        maxPerRun: 1,
        retryStep: true,
      },
    ];
    expect(lintCapability(cap).map((f) => f.code)).toContain('recovery-empty-phase');
  });

  it('does not warn when the phase it replays does exist', () => {
    const cap = capability();
    cap.steps[0] = { ...cap.steps[0]!, phase: 'signon' };
    cap.recoveries = [
      {
        id: 'reauth',
        description: 'sign on again',
        when: { kind: 'textPresent', text: 'expired' },
        do: [{ kind: 'replayFrom', phase: 'signon' }],
        maxPerRun: 1,
        retryStep: true,
      },
    ];
    expect(lintCapability(cap).map((f) => f.code)).not.toContain('recovery-empty-phase');
  });

  it('allows a literal url and a literal value that are not regulated data', () => {
    const cap = capability();
    cap.steps[0]!.value = '0001';
    expect(lintCapability(cap).filter((f) => f.severity === 'error')).toEqual([]);
  });
});
