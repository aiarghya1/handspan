/**
 * Condition evaluation. One evaluator serves checkpoints, business-outcome
 * detection and recovery triggers, so these tests are really about all three.
 */

import { describe, expect, it } from 'vitest';
import { describeCondition, evaluateCondition, waitForCondition } from '../src/replay/conditions.js';
import type { Observation } from '../src/surface/types.js';
import { FakeDriver } from './fake-driver.js';

const obs = (over: Partial<Observation> = {}): Observation => ({
  at: new Date().toISOString(),
  url: 'http://app.test/',
  title: 'Home',
  frames: [
    { framePath: [], url: 'http://app.test/', text: 'Meridian Core Servicing', alerts: [] },
    { framePath: [{ name: 'main' }], url: 'http://app.test/member/12345', text: 'MEMBER DETAIL - 12345 Active', alerts: [] },
  ],
  controls: [],
  ...over,
});

describe('urlMatches', () => {
  it('matches any frame, not just the top document', () => {
    // The whole point: in a frameset the address bar never changes, so a
    // condition that only looked at the top URL would be useless here.
    expect(evaluateCondition({ kind: 'urlMatches', pattern: '/member/\\d+' }, obs()).ok).toBe(true);
  });

  it('reports the urls it actually saw when it does not match', () => {
    const r = evaluateCondition({ kind: 'urlMatches', pattern: '/loan/' }, obs());
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('http://app.test/member/12345');
  });

  it('treats an invalid pattern as a failure rather than throwing', () => {
    expect(evaluateCondition({ kind: 'urlMatches', pattern: '([' }, obs()).ok).toBe(false);
  });
});

describe('text conditions', () => {
  it('searches frame text and alert text together', () => {
    const o = obs({ frames: [{ framePath: [], url: 'u', text: 'body', alerts: ['No member found for 99999.'] }] });
    expect(evaluateCondition({ kind: 'textPresent', text: 'No member found for' }, o).ok).toBe(true);
  });

  it('supports the regex form the compiler emits for parameterized checkpoints', () => {
    expect(evaluateCondition({ kind: 'textPresent', text: 'MEMBER DETAIL - \\S+', regex: true }, obs()).ok).toBe(true);
  });

  it('can be restricted to one frame', () => {
    const cond = { kind: 'textPresent' as const, text: 'MEMBER DETAIL', frame: { name: 'nav' } };
    expect(evaluateCondition(cond, obs()).ok).toBe(false);
  });

  it('textAbsent is the negation, and says which way it failed', () => {
    const r = evaluateCondition({ kind: 'textAbsent', text: 'MEMBER DETAIL' }, obs());
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('should not be');
  });
});

describe('control conditions', () => {
  const withControls = obs({
    controls: [
      {
        handle: 'h0',
        role: 'button',
        name: 'Retrieve',
        nameSource: 'value',
        enabled: true,
        framePath: [{ name: 'main' }],
        ordinal: 0,
        hints: {},
      },
    ],
  });

  it('asks the same question the action layer asks', () => {
    expect(evaluateCondition({ kind: 'controlPresent', ref: { role: 'button', name: 'Retrieve' } }, withControls).ok).toBe(true);
    expect(evaluateCondition({ kind: 'controlAbsent', ref: { role: 'button', name: 'Retrieve' } }, withControls).ok).toBe(false);
    expect(evaluateCondition({ kind: 'controlPresent', ref: { role: 'button', name: 'Post' } }, withControls).ok).toBe(false);
  });
});

describe('combinators', () => {
  it('allOf reports the first failure, so the message names the real problem', () => {
    const r = evaluateCondition(
      { kind: 'allOf', of: [{ kind: 'textPresent', text: 'MEMBER DETAIL' }, { kind: 'textPresent', text: 'Closed' }] },
      obs(),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('Closed');
  });

  it('anyOf succeeds on the first match', () => {
    const r = evaluateCondition(
      { kind: 'anyOf', of: [{ kind: 'textPresent', text: 'nope' }, { kind: 'textPresent', text: 'Active' }] },
      obs(),
    );
    expect(r.ok).toBe(true);
  });
});

describe('describeCondition', () => {
  it('renders conditions in language an operator can act on', () => {
    expect(describeCondition({ kind: 'textPresent', text: 'MEMBER DETAIL' })).toBe('the screen shows "MEMBER DETAIL"');
    expect(
      describeCondition({ kind: 'allOf', of: [{ kind: 'textPresent', text: 'A' }, { kind: 'textAbsent', text: 'B' }] }),
    ).toBe('the screen shows "A" and the screen does not show "B"');
  });
});

describe('waitForCondition', () => {
  it('keeps polling a slow screen rather than failing it', async () => {
    // Transient slowness must cost latency, not a failed run.
    const driver = new FakeDriver(
      { slow: { url: 'u', text: 'Please wait', controls: [] }, done: { url: 'u', text: 'MEMBER DETAIL', controls: [] } },
      {},
      'slow',
    );
    setTimeout(() => {
      driver.current = 'done';
    }, 400);
    const r = await waitForCondition(driver, { kind: 'textPresent', text: 'MEMBER DETAIL' }, 4_000, 100);
    expect(r.ok).toBe(true);
    expect(r.polls).toBeGreaterThan(1);
  });

  it('gives up at the budget and hands back what it last saw', async () => {
    const driver = new FakeDriver({ a: { url: 'u', text: 'nothing here', controls: [] } }, {}, 'a');
    const r = await waitForCondition(driver, { kind: 'textPresent', text: 'never' }, 300, 100);
    expect(r.ok).toBe(false);
    expect(r.observation.frames[0]!.text).toContain('nothing here');
  });
});

describe('valueMatches', () => {
  const withValue = (value: string | undefined): Observation =>
    obs({
      controls: [
        {
          handle: 'h0',
          role: 'textbox',
          name: 'Member Number',
          nameSource: 'adjacent-cell',
          value,
          enabled: true,
          framePath: [{ name: 'main' }],
          ordinal: 0,
          hints: {},
        },
      ],
    });

  it('checks the value a field currently holds, which is how a fill is verified', () => {
    const cond = { kind: 'valueMatches' as const, ref: { role: 'textbox' as const, name: 'Member Number' }, pattern: '^\\d{5}$' };
    expect(evaluateCondition(cond, withValue('12345')).ok).toBe(true);
    const miss = evaluateCondition(cond, withValue('123'));
    expect(miss.ok).toBe(false);
    expect(miss.detail).toContain('did not match');
  });

  it('treats an empty field as a value, not as an absent control', () => {
    const cond = { kind: 'valueMatches' as const, ref: { role: 'textbox' as const, name: 'Member Number' }, pattern: '\\S' };
    expect(evaluateCondition(cond, withValue(undefined)).ok).toBe(false);
  });

  it('says the control is missing rather than that the value is wrong', () => {
    const cond = { kind: 'valueMatches' as const, ref: { role: 'textbox' as const, name: 'Absent' }, pattern: '.' };
    expect(evaluateCondition(cond, withValue('x')).detail).toContain('not on screen');
  });

  it('treats an invalid pattern as a failure rather than throwing', () => {
    const cond = { kind: 'valueMatches' as const, ref: { role: 'textbox' as const, name: 'Member Number' }, pattern: '([' };
    expect(evaluateCondition(cond, withValue('x'))).toMatchObject({ ok: false });
  });
});

describe('frame selection', () => {
  const twoFrames = obs({
    frames: [
      { framePath: [{ index: 0 }], url: 'u0', text: 'in the first frame', alerts: [] },
      { framePath: [{ index: 1 }], url: 'u1', text: 'in the second frame', alerts: [] },
    ],
  });

  it('can select a frame by index when it has no name', () => {
    expect(evaluateCondition({ kind: 'textPresent', text: 'second', frame: { index: 1 } }, twoFrames).ok).toBe(true);
    expect(evaluateCondition({ kind: 'textPresent', text: 'second', frame: { index: 0 } }, twoFrames).ok).toBe(false);
  });

  it('searches every frame when the selector names neither', () => {
    expect(evaluateCondition({ kind: 'textPresent', text: 'second', frame: {} }, twoFrames).ok).toBe(true);
  });

  it('treats an invalid regex in a text condition as no match', () => {
    expect(evaluateCondition({ kind: 'textPresent', text: '([', regex: true }, twoFrames).ok).toBe(false);
    expect(evaluateCondition({ kind: 'textAbsent', text: '([', regex: true }, twoFrames).ok).toBe(true);
  });
});

describe('describeCondition, for every shape', () => {
  it('renders each kind in language an operator can act on', () => {
    const ref = { role: 'button' as const, name: 'Retrieve' };
    expect(describeCondition({ kind: 'urlMatches', pattern: '/member/' })).toBe('url matches //member//');
    expect(describeCondition({ kind: 'textAbsent', text: 'ABEND' })).toBe('the screen does not show "ABEND"');
    expect(describeCondition({ kind: 'controlPresent', ref })).toBe('a button named "Retrieve" is on screen');
    expect(describeCondition({ kind: 'controlAbsent', ref })).toBe('no button named "Retrieve" is on screen');
    expect(describeCondition({ kind: 'valueMatches', ref, pattern: '\\d' })).toBe('button "Retrieve" matches /\\d/');
    expect(describeCondition({ kind: 'anyOf', of: [{ kind: 'textPresent', text: 'A' }, { kind: 'textPresent', text: 'B' }] })).toBe(
      'the screen shows "A" or the screen shows "B"',
    );
    expect(describeCondition({ kind: 'not', of: { kind: 'textPresent', text: 'A' } })).toBe('not (the screen shows "A")');
  });

  it('names an unnamed control without printing "undefined"', () => {
    expect(describeCondition({ kind: 'controlPresent', ref: { role: 'dialog' } })).toBe('a dialog named "" is on screen');
  });
});

describe('the not combinator', () => {
  it('reports which way the negation went', () => {
    const present = evaluateCondition({ kind: 'not', of: { kind: 'textPresent', text: 'MEMBER DETAIL' } }, obs());
    expect(present).toMatchObject({ ok: false });
    expect(present.detail).toContain('expected NOT');

    const absent = evaluateCondition({ kind: 'not', of: { kind: 'textPresent', text: 'nowhere' } }, obs());
    expect(absent).toMatchObject({ ok: true });
    expect(absent.detail).toContain('negation holds');
  });
});

describe('conditions about controls with no name', () => {
  const withDialog = obs({
    controls: [
      { handle: 'h0', role: 'dialog', name: '', nameSource: 'none', enabled: true, framePath: [], ordinal: 0, hints: {} },
    ],
  });

  it('reports presence and absence without printing "undefined"', () => {
    expect(evaluateCondition({ kind: 'controlPresent', ref: { role: 'dialog' } }, withDialog).detail).toContain('dialog ""');
    expect(evaluateCondition({ kind: 'controlAbsent', ref: { role: 'dialog' } }, withDialog).detail).toContain('dialog ""');
    expect(evaluateCondition({ kind: 'controlPresent', ref: { role: 'alert' } }, withDialog).detail).toContain('no alert named ""');
    expect(evaluateCondition({ kind: 'controlAbsent', ref: { role: 'alert' } }, withDialog).detail).toContain('alert "" is absent');
    expect(evaluateCondition({ kind: 'valueMatches', ref: { role: 'alert' }, pattern: '.' }, withDialog).detail).toContain(
      'cannot read alert ""',
    );
  });
});

describe('combinator detail', () => {
  it('joins every reason when an allOf succeeds', () => {
    const r = evaluateCondition(
      { kind: 'allOf', of: [{ kind: 'textPresent', text: 'MEMBER DETAIL' }, { kind: 'textPresent', text: 'Active' }] },
      obs(),
    );
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('; ');
  });

  it('lists every reason when an anyOf fails', () => {
    const r = evaluateCondition(
      { kind: 'anyOf', of: [{ kind: 'textPresent', text: 'nope' }, { kind: 'textPresent', text: 'also nope' }] },
      obs(),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(' | ');
  });
});

describe('describing conditions about unnamed controls', () => {
  it('leaves the name blank rather than printing undefined', () => {
    expect(describeCondition({ kind: 'controlAbsent', ref: { role: 'dialog' } })).toBe('no dialog named "" is on screen');
    expect(describeCondition({ kind: 'valueMatches', ref: { role: 'textbox' }, pattern: '\\d' })).toBe('textbox "" matches /\\d/');
  });
});
