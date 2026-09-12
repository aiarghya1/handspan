/**
 * The trace's own shape. Small, but it is the hand-off between the agent and
 * the compiler, so its initial state is worth pinning.
 */

import { describe, expect, it } from 'vitest';
import { newTrace, summarizeTrace } from '../src/discover/trace.js';

describe('newTrace', () => {
  it('starts empty, with nothing blocked and no human involved', () => {
    const t = newTrace({ goalId: 'a.b.c', goal: 'do the thing', model: 'claude-opus-5', runId: 'run-1' });
    expect(t).toMatchObject({
      goalId: 'a.b.c',
      goal: 'do the thing',
      model: 'claude-opus-5',
      runId: 'run-1',
      entries: [],
      declaredOutcomes: [],
      humanAssisted: false,
      blockedActions: 0,
      turns: 0,
    });
    expect(Date.parse(t.startedAt)).not.toBeNaN();
    expect(t.finishedAt).toBeUndefined();
  });
});

describe('summarizeTrace', () => {
  it('reads correctly in the singular and the plural', () => {
    const t = newTrace({ goalId: 'a.b', goal: 'g', model: 'm', runId: 'r' });
    t.entries.push({ seq: 0, at: 'now', action: 'click', intent: 'i', phase: 'input', risk: 'read_only' });
    t.turns = 1;
    expect(summarizeTrace(t)).toBe('1 action over 1 turn, 0 blocked');

    t.entries.push({ seq: 1, at: 'now', action: 'click', intent: 'i', phase: 'input', risk: 'read_only' });
    t.turns = 3;
    t.blockedActions = 1;
    t.humanAssisted = true;
    expect(summarizeTrace(t)).toBe('2 actions over 3 turns, 1 blocked, human-assisted');
  });
});
