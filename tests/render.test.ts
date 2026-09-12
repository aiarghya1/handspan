/**
 * What the model is shown.
 *
 * The rendering is the model's action space, so these tests pin the two things
 * that determine whether it can act at all: every control carries an
 * addressable handle, and the interactive controls are not buried under the
 * table cells that outnumber them ten to one.
 */

import { describe, expect, it } from 'vitest';
import { observationSignature, renderObservation } from '../src/discover/render.js';
import type { Control, Observation } from '../src/surface/types.js';

const control = (over: Partial<Control> & Pick<Control, 'role' | 'name' | 'handle'>): Control => ({
  nameSource: 'text',
  enabled: true,
  framePath: [],
  ordinal: 0,
  hints: {},
  ...over,
});

const obs = (over: Partial<Observation> = {}): Observation => ({
  at: '2026-09-12T00:00:00.000Z',
  url: 'http://app.test/',
  title: 'Home',
  frames: [{ framePath: [], url: 'http://app.test/', text: 'body', alerts: [] }],
  controls: [],
  ...over,
});

describe('rendering a screen', () => {
  it('lists every frame, named or by index', () => {
    const out = renderObservation(
      obs({
        frames: [
          { framePath: [], url: 'http://app.test/', text: '', alerts: [] },
          { framePath: [{ name: 'main' }], url: 'http://app.test/main', text: '', alerts: [] },
          { framePath: [{ index: 2 }], url: 'http://app.test/other', text: '', alerts: [] },
        ],
      }),
    );
    expect(out).toContain('top      http://app.test/');
    expect(out).toContain('main     http://app.test/main');
    expect(out).toContain('#2       http://app.test/other');
  });

  it('puts alerts where the model cannot miss them', () => {
    const out = renderObservation(
      obs({ frames: [{ framePath: [], url: 'u', text: 'x', alerts: ['No member found for 99999.'] }] }),
    );
    expect(out).toContain('Alerts and dialogs currently on screen:');
    expect(out).toContain('! No member found for 99999.');
  });

  it('says so plainly when there is nothing to act on', () => {
    expect(renderObservation(obs())).toContain('(none)');
  });

  it('renders an interactive control with its handle, value, frame, screen and options', () => {
    const out = renderObservation(
      obs({
        controls: [
          control({
            handle: 'f2c0',
            role: 'combobox',
            name: 'Product',
            value: 'SV02',
            framePath: [{ name: 'main' }],
            section: 'OPEN SUB-ACCOUNT',
            hints: { attrs: { options: 'SV02|SECONDARY ;; VC01|VACATION' } },
          }),
        ],
      }),
    );
    expect(out).toContain('[f2c0] combobox "Product" value="SV02" frame=main screen="OPEN SUB-ACCOUNT"');
    expect(out).toContain('options=[SV02|SECONDARY ;; VC01|VACATION]');
  });

  it('marks a disabled control, and omits an empty value', () => {
    const out = renderObservation(
      obs({ controls: [control({ handle: 'h0', role: 'button', name: 'Post', enabled: false, value: '' })] }),
    );
    expect(out).toContain('DISABLED');
    expect(out).not.toContain('value=""');
  });

  it('separates grid values from the controls, so the buttons stay findable', () => {
    const out = renderObservation(
      obs({
        controls: [
          control({ handle: 'h0', role: 'button', name: 'Retrieve' }),
          control({ handle: 'h1', role: 'cell', name: 'Balance', value: '4182.55', rowText: '0001 REGULAR SHARE SAVINGS 4182.55' }),
          control({ handle: 'h2', role: 'cell', name: '', value: 'unlabelled thing' }),
          control({ handle: 'h3', role: 'cell', name: 'Empty' }),
        ],
      }),
    );
    expect(out).toContain('Controls you can act on');
    expect(out).toContain('Values on screen');
    expect(out).toContain('[h1] "Balance" = "4182.55" row="0001 REGULAR SHARE SAVINGS 4182.55"');
    expect(out).toContain('[h2] (unlabelled) = "unlabelled thing"');
    // A cell with no value is not a value.
    expect(out).not.toContain('[h3]');
  });

  it('caps the number of cells and says how many it left out', () => {
    const controls = Array.from({ length: 60 }, (_, i) =>
      control({ handle: `c${i}`, role: 'cell', name: 'Balance', value: String(i) }),
    );
    const out = renderObservation(obs({ controls }), { maxCells: 10 });
    expect(out).toContain('... 50 more cells not listed');
  });
});

describe('observationSignature', () => {
  it('changes when the screen changes, and not when it does not', () => {
    const a = obs({ controls: [control({ handle: 'h0', role: 'button', name: 'Retrieve' })] });
    const b = obs({ controls: [control({ handle: 'h9', role: 'button', name: 'Retrieve' })] });
    const c = obs({ controls: [control({ handle: 'h0', role: 'button', name: 'Search' })] });
    // The handle is not part of the identity: renumbering is not progress.
    expect(observationSignature(a)).toBe(observationSignature(b));
    expect(observationSignature(a)).not.toBe(observationSignature(c));
  });

  it('notices a new alert on an otherwise identical screen', () => {
    const before = obs();
    const after = obs({ frames: [{ framePath: [], url: 'http://app.test/', text: 'body', alerts: ['now failing'] }] });
    expect(observationSignature(before)).not.toBe(observationSignature(after));
  });
});
