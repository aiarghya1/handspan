/**
 * The compiler's parameterization rules.
 *
 * These are the difference between a recording that works once and a capability
 * that works for every member. The model's stated expectation and the recorder's
 * derived scope both contain the value used during discovery, and both have to
 * be generalized before they are written down.
 */

import { describe, expect, it } from 'vitest';
import { generalizeText, scrubRef } from '../src/discover/compile.js';
import { evaluateCondition } from '../src/replay/conditions.js';
import type { Observation } from '../src/surface/types.js';

const params: Array<[string, string]> = [['memberId', '12345']];

describe('generalizeText', () => {
  it('leaves a phrase that contains no parameter value alone', () => {
    expect(generalizeText('MEMBER DETAIL', params)).toEqual({ text: 'MEMBER DETAIL', regex: false });
  });

  it('replaces the parameter value with a wildcard and keeps the shape', () => {
    const g = generalizeText('MEMBER DETAIL - 12345', params);
    expect(g).toEqual({ text: 'MEMBER DETAIL - \\S+', regex: true });
  });

  it('produces a checkpoint that holds for a different member', () => {
    const g = generalizeText('MEMBER DETAIL - 12345', params);
    const obs: Observation = {
      at: '',
      url: 'u',
      title: '',
      frames: [{ framePath: [], url: 'u', text: 'MEMBER DETAIL - 98765 Active', alerts: [] }],
      controls: [],
    };
    expect(evaluateCondition({ kind: 'textPresent', text: g.text, regex: g.regex }, obs).ok).toBe(true);
  });

  it('escapes regex metacharacters so a literal phrase stays literal', () => {
    const g = generalizeText('Amount (USD) 12345', params);
    expect(g.text).toBe('Amount \\(USD\\) \\S+');
  });

  it('generalizes every occurrence', () => {
    expect(generalizeText('12345 / 12345', params).text).toBe('\\S+ / \\S+');
  });
});

describe('scrubRef', () => {
  it('cuts a parameter value out of a section heading, keeping the usable prefix', () => {
    // Section matching is loose, so "MEMBER DETAIL" still matches the live
    // heading "MEMBER DETAIL - 23456".
    const ref = scrubRef({ role: 'cell', name: 'Name', scope: { section: 'MEMBER DETAIL - 12345' } }, params);
    expect(ref.scope?.section).toBe('MEMBER DETAIL');
  });

  it('drops a scope that is nothing but the parameter value', () => {
    const ref = scrubRef({ role: 'cell', name: 'Balance', scope: { rowContaining: '12345' } }, params);
    expect(ref.scope).toBeUndefined();
  });

  it('leaves a scope that has no parameter value in it', () => {
    const ref = scrubRef({ role: 'cell', name: 'Balance', scope: { rowContaining: 'REGULAR SHARE SAVINGS' } }, params);
    expect(ref.scope?.rowContaining).toBe('REGULAR SHARE SAVINGS');
  });

  it('preserves the frame, which is structural rather than data', () => {
    const ref = scrubRef(
      { role: 'button', name: 'Retrieve', scope: { frame: { name: 'main' }, section: 'INQUIRY 12345' } },
      params,
    );
    expect(ref.scope?.frame).toEqual({ name: 'main' });
    expect(ref.scope?.section).toBe('INQUIRY');
  });
});
