/**
 * The resolution ladder and the recorder's ref derivation.
 *
 * These are the tests that matter most for replay determinism: they pin the
 * ordering of the ladder, the refusal to guess between two matches, and the
 * rule that a recorded ref is the *least* specific one that is unambiguous.
 */

import { describe, expect, it } from 'vitest';
import {
  candidatesAtTier,
  deriveRef,
  deriveRowLabel,
  frameMatches,
  nameMatches,
  nearTextMatches,
  normalizeName,
  resolveFromControls,
  rowMatches,
  sectionMatches,
  tryResolveFromControls,
} from '../src/surface/match.js';
import { AmbiguousControlError, ControlNotFoundError, describeRef, tierRank, type Control } from '../src/surface/types.js';

function control(over: Partial<Control> & Pick<Control, 'role' | 'name'>): Control {
  return {
    handle: over.name.toLowerCase().replace(/\W+/g, '-'),
    nameSource: 'text',
    enabled: true,
    framePath: [],
    ordinal: 0,
    hints: {},
    ...over,
  };
}

describe('normalizeName', () => {
  it('ignores the punctuation and casing that legacy labels gain and lose', () => {
    expect(normalizeName('Member Number:')).toBe('member number');
    expect(normalizeName('  MEMBER   NUMBER ')).toBe('member number');
    expect(normalizeName('Member Number *')).toBe('member number');
  });
});

describe('resolution ladder', () => {
  const controls = [
    control({ role: 'textbox', name: 'Member Number', framePath: [{ name: 'main' }], section: 'MEMBER INQUIRY' }),
    control({ role: 'button', name: 'Retrieve', framePath: [{ name: 'main' }], section: 'MEMBER INQUIRY' }),
    control({ role: 'link', name: 'Member Inquiry', framePath: [{ name: 'nav' }], section: 'MENU' }),
  ];

  it('resolves at the top tier when the ref is fully scoped', () => {
    const r = resolveFromControls(
      { role: 'button', name: 'Retrieve', scope: { frame: { name: 'main' }, section: 'MEMBER INQUIRY' } },
      controls,
    );
    expect(r.tier).toBe('role+name+scope');
    expect(r.control.name).toBe('Retrieve');
  });

  it('still resolves, at a lower tier, when the recorded scope has drifted', () => {
    const r = resolveFromControls(
      { role: 'button', name: 'Retrieve', scope: { frame: { name: 'main' }, section: 'MEMBER SELECTION' } },
      controls,
    );
    // Section no longer matches, so tier 1 misses and tier 2 wins. This is the
    // drift signal replay reports rather than a failure.
    expect(r.tier).toBe('role+name+frame');
  });

  it('matches sections loosely, because headings carry runtime suffixes', () => {
    const detail = [control({ role: 'cell', name: 'Name', section: 'MEMBER DETAIL - 12345', value: 'X' })];
    const r = resolveFromControls({ role: 'cell', name: 'Name', scope: { section: 'MEMBER DETAIL' } }, detail);
    expect(r.tier).toBe('role+name+scope');
  });

  it('refuses to choose between two matches rather than guessing', () => {
    const two = [
      control({ role: 'button', name: 'Confirm', handle: 'a' }),
      control({ role: 'button', name: 'Confirm', handle: 'b', ordinal: 1 }),
    ];
    expect(() => resolveFromControls({ role: 'button', name: 'Confirm' }, two)).toThrow(AmbiguousControlError);
  });

  it('uses an ordinal to pick between matches when the ref supplies one', () => {
    const two = [
      control({ role: 'button', name: 'Confirm', handle: 'a', ordinal: 0 }),
      control({ role: 'button', name: 'Confirm', handle: 'b', ordinal: 1 }),
    ];
    expect(resolveFromControls({ role: 'button', name: 'Confirm', ordinal: 1 }, two).control.handle).toBe('b');
  });

  it('reports every tier it tried when nothing matches', () => {
    try {
      resolveFromControls({ role: 'button', name: 'Nope' }, controls);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ControlNotFoundError);
      expect((err as ControlNotFoundError).triedTiers).toHaveLength(6);
    }
  });

  it('falls back to the label beside a control when its synthesized name changes', () => {
    const renamed = [control({ role: 'textbox', name: 'Mbr No', hints: { nearText: 'Member Number' } })];
    const r = resolveFromControls({ role: 'textbox', name: 'Member Number' }, renamed);
    expect(r.tier).toBe('role+nearText');
  });

  it('treats a selector hint as a last resort, never as the primary key', () => {
    const moved = [control({ role: 'button', name: 'Search', hints: { selector: 'input[name="go"]' } })];
    const r = resolveFromControls({ role: 'button', name: 'Retrieve', hints: { selector: 'input[name="go"]' } }, moved);
    expect(r.tier).toBe('hint-selector');
  });

  it('never matches a control of a different role', () => {
    expect(tryResolveFromControls({ role: 'link', name: 'Retrieve' }, controls)).toBeNull();
  });
});

describe('deriveRef', () => {
  it('records the least specific ref that is unambiguous', () => {
    const controls = [
      control({ role: 'button', name: 'Retrieve', framePath: [{ name: 'main' }], section: 'MEMBER INQUIRY - 12345' }),
      control({ role: 'link', name: 'Home', framePath: [{ name: 'nav' }] }),
    ];
    const ref = deriveRef(controls[0]!, controls);
    // One Retrieve on screen, so no scope is recorded at all - and therefore
    // nothing to break when the heading changes.
    expect(ref).toMatchObject({ role: 'button', name: 'Retrieve' });
    expect(ref.scope).toBeUndefined();
    expect(ref.ordinal).toBeUndefined();
  });

  it('scopes a grid cell by its row label, not by position or by row text', () => {
    const row = (product: string, balance: string): Control[] => [
      control({ role: 'cell', name: 'Product', nameSource: 'column-header', value: product, rowText: `${product} ${balance}` }),
      control({ role: 'cell', name: 'Balance', nameSource: 'column-header', value: balance, rowText: `${product} ${balance}` }),
    ];
    const controls = [...row('REGULAR SHARE SAVINGS', '4182.55'), ...row('PRIMARY CHECKING', '913.20')];
    const target = controls.find((c) => c.value === '4182.55')!;
    const ref = deriveRef(target, controls);
    expect(ref.scope?.rowContaining).toBe('REGULAR SHARE SAVINGS');
    // The balance itself must not appear in the locator, or it stops resolving
    // the moment the balance changes.
    expect(JSON.stringify(ref)).not.toContain('4182.55');
    expect(resolveFromControls(ref, controls).control).toBe(target);
  });

  it('falls back to an ordinal for layout-table cells, where row text is the value', () => {
    const controls = [
      control({ role: 'cell', name: 'Name', value: 'DELACROIX, R M', ordinal: 0, rowText: 'Name DELACROIX, R M', section: 'MEMBER DETAIL' }),
      control({ role: 'cell', name: 'Name', value: 'Branch', ordinal: 1, rowText: 'Branch 004', section: 'MEMBER DETAIL' }),
    ];
    const ref = deriveRef(controls[0]!, controls);
    expect(ref.ordinal).toBe(0);
    expect(JSON.stringify(ref)).not.toContain('DELACROIX');
    expect(resolveFromControls(ref, controls).control).toBe(controls[0]);
  });
});

describe('candidatesAtTier', () => {
  it('needs an ordinal before the positional tier will match anything', () => {
    const controls = [control({ role: 'button', name: 'Go' })];
    expect(candidatesAtTier({ role: 'button' }, controls, 'role+ordinal')).toHaveLength(0);
    expect(candidatesAtTier({ role: 'button', ordinal: 0 }, controls, 'role+ordinal')).toHaveLength(1);
  });
});

describe('describeRef', () => {
  it('renders every part of a reference, for a failure message a person can act on', () => {
    expect(
      describeRef({
        role: 'cell',
        name: 'Balance',
        scope: { frame: { name: 'main' }, section: 'MEMBER DETAIL', rowContaining: 'REGULAR SHARE SAVINGS' },
        ordinal: 2,
      }),
    ).toBe('cell "Balance" in frame main under "MEMBER DETAIL" in row containing "REGULAR SHARE SAVINGS" #2');
  });

  it('renders a bare reference without empty clauses', () => {
    expect(describeRef({ role: 'button' })).toBe('button');
    expect(describeRef({ role: 'button', name: 'Retrieve' })).toBe('button "Retrieve"');
  });
});

describe('tierRank', () => {
  it('orders the ladder from most to least semantic', () => {
    expect(tierRank('role+name+scope')).toBe(1);
    expect(tierRank('role+ordinal')).toBe(6);
    expect(tierRank('role+name')).toBeLessThan(tierRank('hint-selector'));
  });
});

describe('name matching modes', () => {
  const button = control({ role: 'button', name: 'Confirm and Post' });

  it('matches exactly, loosely, by substring, or by regex, as the ref asks', () => {
    expect(nameMatches({ role: 'button', name: 'Confirm and Post', nameMatch: 'exact' }, button)).toBe(true);
    expect(nameMatches({ role: 'button', name: 'confirm and post', nameMatch: 'exact' }, button)).toBe(false);
    expect(nameMatches({ role: 'button', name: 'confirm and post' }, button)).toBe(true);
    expect(nameMatches({ role: 'button', name: 'Post', nameMatch: 'contains' }, button)).toBe(true);
    expect(nameMatches({ role: 'button', name: '^Confirm', nameMatch: 'regex' }, button)).toBe(true);
    expect(nameMatches({ role: 'button', name: '([', nameMatch: 'regex' }, button)).toBe(false);
  });

  it('matches anything when the ref names nothing', () => {
    expect(nameMatches({ role: 'button' }, button)).toBe(true);
  });
});

describe('scope matching', () => {
  it('matches a frame by name or by index, and anything when neither is given', () => {
    const inNamed = control({ role: 'link', name: 'Home', framePath: [{ name: 'nav' }] });
    const inIndexed = control({ role: 'link', name: 'Home', framePath: [{ index: 1 }] });
    expect(frameMatches({ role: 'link', scope: { frame: { name: 'nav' } } }, inNamed)).toBe(true);
    expect(frameMatches({ role: 'link', scope: { frame: { name: 'main' } } }, inNamed)).toBe(false);
    expect(frameMatches({ role: 'link', scope: { frame: { index: 1 } } }, inIndexed)).toBe(true);
    expect(frameMatches({ role: 'link', scope: { frame: {} } }, inNamed)).toBe(true);
  });

  it('fails a section match when the control has no section at all', () => {
    expect(sectionMatches({ role: 'button', scope: { section: 'MEMBER INQUIRY' } }, control({ role: 'button', name: 'x' }))).toBe(
      false,
    );
  });

  it('matches a row by its first cell as well as by its whole text', () => {
    const cell = control({ role: 'cell', name: 'Balance', rowKey: '0001', rowText: '0001 REGULAR SHARE SAVINGS 4182.55' });
    expect(rowMatches({ role: 'cell', scope: { rowContaining: '0001' } }, cell)).toBe(true);
    expect(rowMatches({ role: 'cell', scope: { rowContaining: 'PRIMARY CHECKING' } }, cell)).toBe(false);
  });

  it('cannot match nearby text when the ref names nothing', () => {
    expect(nearTextMatches({ role: 'textbox' }, control({ role: 'textbox', name: 'x', hints: { nearText: 'y' } }))).toBe(false);
  });
});

describe('deriveRowLabel', () => {
  it('returns nothing when the control is not in a row', () => {
    expect(deriveRowLabel(control({ role: 'cell', name: 'Balance' }), [])).toBeUndefined();
  });

  it('ignores row values that are numeric or too short to be a label', () => {
    const row = '0001 4182.55 ab';
    const cells = [
      control({ role: 'cell', name: 'Sfx', value: '0001', rowText: row, handle: 'a' }),
      control({ role: 'cell', name: 'Short', value: 'ab', rowText: row, handle: 'b' }),
      control({ role: 'cell', name: 'Balance', value: '4182.55', rowText: row, handle: 'c' }),
    ];
    expect(deriveRowLabel(cells[2]!, cells)).toBeUndefined();
  });
});

describe('ordinals beyond what any control declares', () => {
  it('falls back to position when no control has that ordinal', () => {
    const three = [
      control({ role: 'button', name: 'Confirm', handle: 'a', ordinal: 0 }),
      control({ role: 'button', name: 'Confirm', handle: 'b', ordinal: 1 }),
      control({ role: 'button', name: 'Confirm', handle: 'c', ordinal: 2 }),
    ];
    // Ordinals are renumbered per frame, so a recorded ordinal may not appear;
    // position within the matches is the fallback.
    const renumbered = three.map((c) => ({ ...c, ordinal: c.ordinal + 10 }));
    expect(resolveFromControls({ role: 'button', name: 'Confirm', ordinal: 1 }, renumbered).control.handle).toBe('b');
  });

  it('gives up when the ordinal is past the end', () => {
    const two = [
      control({ role: 'button', name: 'Confirm', handle: 'a', ordinal: 5 }),
      control({ role: 'button', name: 'Confirm', handle: 'b', ordinal: 6 }),
    ];
    expect(() => resolveFromControls({ role: 'button', name: 'Confirm', ordinal: 9 }, two)).toThrow(AmbiguousControlError);
  });
});

describe('deriving a reference for a control with no name', () => {
  it('records its position, since there is nothing else to key on', () => {
    const controls = [
      control({ role: 'button', name: '', handle: 'a', ordinal: 0, section: 'CONFIRM' }),
      control({ role: 'button', name: '', handle: 'b', ordinal: 1, section: 'CONFIRM' }),
    ];
    const ref = deriveRef(controls[1]!, controls);
    expect(ref.name).toBeUndefined();
    expect(ref.ordinal).toBe(1);
    expect(resolveFromControls(ref, controls).control.handle).toBe('b');
  });

  it('ignores a row sibling that holds no value at all', () => {
    const row = 'REGULAR SHARE SAVINGS 4182.55';
    const cells = [
      control({ role: 'cell', name: 'Sfx', rowText: row, handle: 'a', nameSource: 'column-header' }),
      control({ role: 'cell', name: 'Product', value: 'REGULAR SHARE SAVINGS', rowText: row, handle: 'b', nameSource: 'column-header' }),
      control({ role: 'cell', name: 'Balance', value: '4182.55', rowText: row, handle: 'c', nameSource: 'column-header' }),
    ];
    expect(deriveRowLabel(cells[2]!, cells)).toBe('REGULAR SHARE SAVINGS');
  });
});
