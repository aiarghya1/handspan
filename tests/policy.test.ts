/**
 * The guardrail. These tests pin the two properties that matter: the allowlist
 * is deny-by-default and is re-checked after the fact, and risk classification
 * over-classifies rather than under-classifies.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, PolicyEngine, PolicyViolation } from '../src/policy/policy.js';

const engine = (over: Partial<typeof DEFAULT_POLICY> = {}) =>
  new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: ['http://app.test'], ...over });

describe('location allowlist', () => {
  it('denies by default', () => {
    const p = new PolicyEngine({ ...DEFAULT_POLICY, allowedOrigins: [] });
    expect(p.isLocationAllowed('http://app.test/').ok).toBe(false);
  });

  it('allows a listed origin and refuses everything else', () => {
    const p = engine();
    expect(p.isLocationAllowed('http://app.test/member/12345').ok).toBe(true);
    const bad = p.isLocationAllowed('http://evil.test/');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('origin-not-allowed');
  });

  it('enforces path prefixes within an allowed origin', () => {
    const p = engine({ allowedPathPrefixes: ['/member'] });
    expect(p.isLocationAllowed('http://app.test/member/1').ok).toBe(true);
    const bad = p.isLocationAllowed('http://app.test/admin');
    if (!bad.ok) expect(bad.code).toBe('path-not-allowed');
  });

  it('throws on a session that has left the allowlist', () => {
    // This is the check that actually enforces the boundary: a click can
    // navigate anywhere, so intent-time checking is not enough.
    expect(() => engine().assertLocationAllowed('http://evil.test/')).toThrow(PolicyViolation);
  });
});

describe('risk classification', () => {
  const p = engine();
  const click = (name: string) => p.classify({ kind: 'click', actor: 'replay', ref: { role: 'button', name } });

  it('treats commit-shaped labels as irreversible', () => {
    for (const name of ['Confirm and Post', 'Post Transaction', 'Approve', 'Wire Funds', 'Void', 'Reverse', 'Close Account']) {
      expect(click(name), name).toBe('irreversible');
    }
  });

  it('treats create-shaped labels as reversible writes', () => {
    expect(click('Save')).toBe('reversible_write');
    expect(click('Open Sub-Account')).toBe('reversible_write');
  });

  it('treats lookups as read-only', () => {
    expect(click('Retrieve')).toBe('read_only');
    expect(click('Member Inquiry')).toBe('read_only');
  });

  it('treats typing as read-only, because the risk lives in the submit', () => {
    expect(p.classify({ kind: 'fill', actor: 'replay', ref: { role: 'textbox', name: 'Amount' } })).toBe('read_only');
    expect(p.classify({ kind: 'select', actor: 'replay', ref: { role: 'combobox', name: 'Product' } })).toBe('read_only');
  });

  it('treats a bare Enter as a write, since the default submit cannot be named', () => {
    expect(p.classify({ kind: 'press', actor: 'replay', ref: { role: 'textbox', name: 'Amount' } })).not.toBe('irreversible');
    expect(p.classify({ kind: 'press', actor: 'replay', ref: { role: 'button', name: 'Post' } })).toBe('irreversible');
  });
});

describe('authorize', () => {
  it('routes an irreversible action by the agent to a human, by default', () => {
    const d = engine().authorize({ kind: 'click', actor: 'discovery-agent', ref: { role: 'button', name: 'Confirm and Post' } });
    expect(d.allow).toBe(false);
    expect(d.escalate).toBe(true);
    expect(d.risk).toBe('irreversible');
  });

  it('blocks outright when configured to, without offering escalation', () => {
    const d = engine({ onIrreversible: 'block' }).authorize({
      kind: 'click',
      actor: 'discovery-agent',
      ref: { role: 'button', name: 'Post' },
    });
    expect(d.allow).toBe(false);
    expect(d.escalate).toBeUndefined();
  });

  it('lets an operator commit, because deciding is why they were called in', () => {
    const d = engine().authorize({ kind: 'click', actor: 'operator', ref: { role: 'button', name: 'Confirm and Post' } });
    expect(d.allow).toBe(true);
  });

  it('still holds an operator to the origin allowlist', () => {
    const d = engine().authorize({ kind: 'navigate', actor: 'operator', url: 'http://evil.test/' });
    expect(d.allow).toBe(false);
  });

  it('refuses an operator commit when the deployment forbids it', () => {
    const d = engine({ operatorMayCommit: false }).authorize({
      kind: 'click',
      actor: 'operator',
      ref: { role: 'button', name: 'Post' },
    });
    expect(d.allow).toBe(false);
  });

  it('refuses an action kind that is not allowlisted', () => {
    const d = engine({ allowedActions: ['navigate', 'extract'] }).authorize({
      kind: 'click',
      actor: 'replay',
      ref: { role: 'button', name: 'Retrieve' },
    });
    expect(d.code).toBe('action-not-allowed');
  });

  it('stops at the step budget', () => {
    const p = engine({ maxSteps: 1 });
    p.countStep();
    expect(p.authorize({ kind: 'click', actor: 'replay', ref: { role: 'button', name: 'Retrieve' } }).code).toBe(
      'step-budget-exceeded',
    );
  });
});

describe('forCapability', () => {
  const cap = {
    policy: {
      allowedOrigins: ['http://app.test', 'http://other.test'],
      allowedPathPrefixes: ['/member'],
      allowedActions: ['click', 'navigate'] as const,
    },
  };

  it('lets an artifact narrow the ambient policy', () => {
    const p = PolicyEngine.forCapability({ ...DEFAULT_POLICY, allowedOrigins: ['http://app.test'] }, {
      policy: { ...cap.policy, allowedActions: [...cap.policy.allowedActions] },
    });
    expect(p.config.allowedOrigins).toEqual(['http://app.test']);
  });

  it('fails closed when an artifact names an origin the deployment forbids', () => {
    const p = PolicyEngine.forCapability({ ...DEFAULT_POLICY, allowedOrigins: ['http://only.test'] }, {
      policy: { ...cap.policy, allowedActions: [...cap.policy.allowedActions] },
    });
    expect(p.config.allowedOrigins).toEqual([]);
    expect(p.isLocationAllowed('http://app.test/').ok).toBe(false);
  });
});

describe('malformed and non-http locations', () => {
  it('rejects something that is not a url at all', () => {
    const bad = engine().isLocationAllowed('not a url');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('malformed-url');
  });

  it('permits about: pages, which a browser reaches on its own', () => {
    expect(engine().isLocationAllowed('about:blank').ok).toBe(true);
  });
});

describe('navigation risk', () => {
  it('classifies a navigation by the verbs in its url', () => {
    const p = engine();
    expect(p.classify({ kind: 'navigate', actor: 'replay', url: 'http://app.test/member/12345' })).toBe('read_only');
    expect(p.classify({ kind: 'navigate', actor: 'replay', url: 'http://app.test/transfer/post' })).toBe('irreversible');
    expect(p.classify({ kind: 'navigate', actor: 'replay' })).toBe('read_only');
  });

  it('classifies the read-only actions as read-only whatever they target', () => {
    const p = engine();
    for (const kind of ['extract', 'assert', 'wait'] as const) {
      expect(p.classify({ kind, actor: 'replay', ref: { role: 'button', name: 'Confirm and Post' } }), kind).toBe('read_only');
    }
  });
});

describe('budgets', () => {
  it('reports what is left, and counts only actions actually performed', () => {
    const p = engine({ maxSteps: 3 });
    expect(p.stepsUsed).toBe(0);
    expect(p.budgetRemaining.steps).toBe(3);
    p.countStep();
    p.countStep();
    expect(p.stepsUsed).toBe(2);
    expect(p.budgetRemaining.steps).toBe(1);
    expect(p.budgetRemaining.ms).toBeGreaterThan(0);
  });

  it('stops at the wall-clock budget', () => {
    const p = engine({ maxDurationMs: -1 });
    const d = p.authorize({ kind: 'click', actor: 'replay', ref: { role: 'button', name: 'Retrieve' } });
    expect(d.code).toBe('time-budget-exceeded');
    expect(p.budgetRemaining.ms).toBe(0);
  });

  it('refuses a navigation outside the allowlist before performing it', () => {
    const d = engine().authorize({ kind: 'navigate', actor: 'replay', url: 'http://evil.test/' });
    expect(d.allow).toBe(false);
    expect(d.code).toBe('origin-not-allowed');
  });
});

describe('narrowing for a capability', () => {
  it('adopts the artifact path prefixes when the deployment sets none', () => {
    const p = PolicyEngine.forCapability(
      { ...DEFAULT_POLICY, allowedOrigins: ['http://app.test'], allowedPathPrefixes: [] },
      { policy: { allowedOrigins: ['http://app.test'], allowedPathPrefixes: ['/member'], allowedActions: ['click'] } },
    );
    expect(p.config.allowedPathPrefixes).toEqual(['/member']);
    expect(p.isLocationAllowed('http://app.test/admin').ok).toBe(false);
  });

  it('keeps the deployment path prefixes when it sets them', () => {
    const p = PolicyEngine.forCapability(
      { ...DEFAULT_POLICY, allowedOrigins: ['http://app.test'], allowedPathPrefixes: ['/only'] },
      { policy: { allowedOrigins: ['http://app.test'], allowedPathPrefixes: ['/member'], allowedActions: ['click'] } },
    );
    expect(p.config.allowedPathPrefixes).toEqual(['/only']);
  });

  it('adopts the artifact origins when the deployment names none at all', () => {
    const p = PolicyEngine.forCapability(
      { ...DEFAULT_POLICY, allowedOrigins: [] },
      { policy: { allowedOrigins: ['http://app.test'], allowedPathPrefixes: [], allowedActions: ['click'] } },
    );
    expect(p.config.allowedOrigins).toEqual(['http://app.test']);
  });
});

describe('the policy violation error', () => {
  it('carries the code and the request that caused it', () => {
    const err = new PolicyViolation('origin-not-allowed', 'nope', { kind: 'navigate', actor: 'replay', url: 'x' });
    expect(err.name).toBe('PolicyViolation');
    expect(err.code).toBe('origin-not-allowed');
    expect(err.request?.kind).toBe('navigate');
  });
});

describe('an irreversible action with nothing to name', () => {
  it('names the action kind instead of the control', () => {
    const blocked = engine({ onIrreversible: 'block' }).authorize({
      kind: 'navigate',
      actor: 'discovery-agent',
      url: 'http://app.test/transfer/post',
    });
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toContain('"navigate"');

    const escalating = engine().authorize({ kind: 'navigate', actor: 'discovery-agent', url: 'http://app.test/transfer/post' });
    expect(escalating.escalate).toBe(true);
    expect(escalating.reason).toContain('"navigate"');
  });
});

describe('a navigation with no url', () => {
  it('is refused as malformed rather than allowed through', () => {
    const d = engine().authorize({ kind: 'navigate', actor: 'replay' });
    expect(d.allow).toBe(false);
    expect(d.code).toBe('malformed-url');
  });
});
