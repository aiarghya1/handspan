// @vitest-environment jsdom
/**
 * Every branch of the perception pass, driven in Node.
 *
 * The naming cascade is the foundation the whole locator strategy rests on, and
 * it has one branch per way a legacy screen can label a control. Each is
 * exercised here against markup that isolates it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { byName, byValue, extract, installDomPolyfills as installPolyfills, perceive } from './dom-harness.js';

const STYLE = `<style>
  .hdr { font-weight: bold; display: block }
  .err { color: rgb(153,0,0) }
  .redbg { background-color: rgb(200,40,40) }
  .gone { display: none }
  .invis { visibility: hidden }
  .clear { opacity: 0 }
  .inlinebold { font-weight: bold; display: inline }
</style>`;

beforeEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>';
});

describe('the naming cascade, in priority order', () => {
  it('prefers aria-label', () => {
    const v = perceive(`<body><td>Ignored</td><input type="text" aria-label="Member Number" name="m"></body>`);
    expect(byName(v, 'textbox', 'Member Number')?.nameSource).toBe('aria-label');
  });

  it('falls back to aria-labelledby, joining every referenced element', () => {
    const v = perceive(
      `<body><span id="a">Member</span><span id="b">Number</span><input type="text" aria-labelledby="a b"></body>`,
    );
    expect(byName(v, 'textbox', 'Member Number')?.nameSource).toBe('aria-labelledby');
  });

  it('ignores an aria-labelledby that points at nothing', () => {
    const v = perceive(
      `<body><table><tr><td>Suffix</td><td><input type="text" aria-labelledby="missing"></td></tr></table></body>`,
    );
    expect(byName(v, 'textbox', 'Suffix')?.nameSource).toBe('adjacent-cell');
  });

  it('uses a label/for association', () => {
    const v = perceive(`<body><label for="mbr">Member Number</label><input id="mbr" type="text"></body>`);
    expect(byName(v, 'textbox', 'Member Number')?.nameSource).toBe('label-for');
  });

  it('uses a wrapping label', () => {
    const v = perceive(`<body><label>Suffix <input type="text"></label></body>`);
    expect(byName(v, 'textbox', 'Suffix')?.nameSource).toBe('label-wrap');
  });

  it('uses the previous table cell, which is how these screens actually label fields', () => {
    const v = perceive(`<body><table><tr><td>Member Number</td><td><input type="text" name="m"></td></tr></table></body>`);
    expect(byName(v, 'textbox', 'Member Number')?.nameSource).toBe('adjacent-cell');
  });

  it('walks back past empty and control-bearing cells to find the label', () => {
    const v = perceive(
      `<body><table><tr><td>Branch</td><td></td><td><input type="text" name="b"></td></tr></table></body>`,
    );
    expect(byName(v, 'textbox', 'Branch')).toBeDefined();
  });

  it('does not take a label from a cell that itself holds a control', () => {
    const v = perceive(
      `<body><table><tr><td><input type="text" name="a"></td><td><input type="text" name="b"></td></tr></table></body>`,
    );
    // Neither input can name the other, so both fall through the cascade.
    expect(v.controls.filter((c) => c.role === 'textbox' && c.nameSource === 'adjacent-cell')).toHaveLength(0);
  });

  it('prefers the cell to its left over the column header, which is the layout-table case', () => {
    const v = perceive(
      `<body><table><tr><td>Sfx</td><td>Amount</td></tr><tr><td>Deposit</td><td><input type="text" name="amt"></td></tr></table></body>`,
    );
    expect(byName(v, 'textbox', 'Deposit')?.nameSource).toBe('adjacent-cell');
  });

  it('uses the column header when the field is first in its row and has nothing to its left', () => {
    const v = perceive(
      `<body><table><tr><td>Amount</td></tr><tr><td><input type="text" name="amt"></td></tr></table></body>`,
    );
    expect(byName(v, 'textbox', 'Amount')?.nameSource).toBe('adjacent-cell');
  });

  it('rejects an adjacent cell that is too long to be a label', () => {
    const v = perceive(
      `<body><table><tr><td>${'p'.repeat(80)}</td><td><input type="text" name="m"></td></tr></table></body>`,
    );
    expect(v.controls.find((c) => c.attrs['name'] === 'm')?.name).toBe('');
  });

  it('does not take a column header from a row that already holds controls', () => {
    const v = perceive(
      `<body><table><tr><td><input name="h"></td></tr><tr><td><input type="text" name="amt"></td></tr></table></body>`,
    );
    expect(v.controls.find((c) => c.attrs['name'] === 'amt')?.name).toBe('');
  });

  it('falls back to preceding inline text', () => {
    const v = perceive(`<body><div>Initial Deposit <input type="text" name="amt"></div></body>`);
    expect(byName(v, 'textbox', 'Initial Deposit')?.nameSource).toBe('preceding-text');
  });

  it('reads preceding text out of a sibling element when there is no text node', () => {
    const v = perceive(`<body><div><b>Opening Amount</b><input type="text" name="amt"></div></body>`);
    expect(byName(v, 'textbox', 'Opening Amount')?.nameSource).toBe('preceding-text');
  });

  it('stops walking backwards when it reaches another control', () => {
    const v = perceive(`<body><div>Label <input name="first"><input type="text" name="second"></div></body>`);
    expect(v.controls.find((c) => c.attrs['name'] === 'second')?.name).toBe('');
  });

  it('uses a placeholder, then a title, when nothing else exists', () => {
    expect(byName(perceive(`<body><input type="text" placeholder="Search"></body>`), 'textbox', 'Search')?.nameSource).toBe(
      'placeholder',
    );
    expect(byName(perceive(`<body><input type="text" title="Tooltip"></body>`), 'textbox', 'Tooltip')?.nameSource).toBe(
      'title',
    );
  });

  it('leaves a control genuinely unnamed rather than inventing a name', () => {
    const v = perceive(`<body><input type="text" name="anon"></body>`);
    expect(v.controls[0]).toMatchObject({ role: 'textbox', name: '', nameSource: 'none' });
  });
});

describe('buttons and links', () => {
  it('names a submit from its value, a button from its text', () => {
    const v = perceive(`<body><input type="submit" value="Retrieve"><button>Continue</button></body>`);
    expect(byName(v, 'button', 'Retrieve')?.nameSource).toBe('value');
    expect(byName(v, 'button', 'Continue')?.nameSource).toBe('text');
  });

  it('falls through the remaining name sources for a button', () => {
    expect(byName(perceive(`<body><button aria-label="Post"></button></body>`), 'button', 'Post')?.nameSource).toBe(
      'aria-label',
    );
    expect(byName(perceive(`<body><input type="image" alt="Go"></body>`), 'button', 'Go')?.nameSource).toBe('alt');
    expect(byName(perceive(`<body><input type="button" title="Help"></body>`), 'button', 'Help')?.nameSource).toBe('title');
    expect(perceive(`<body><input type="button"></body>`).controls[0]).toMatchObject({ name: '', nameSource: 'none' });
  });

  it('treats reset and image inputs as buttons', () => {
    const v = perceive(`<body><input type="reset" value="Clear"><input type="image" alt="Find"></body>`);
    expect(byName(v, 'button', 'Clear')).toBeDefined();
    expect(byName(v, 'button', 'Find')).toBeDefined();
  });

  it('names a link from its text, then aria-label, then a nested image alt', () => {
    expect(byName(perceive(`<body><a href="/x">New Inquiry</a></body>`), 'link', 'New Inquiry')?.nameSource).toBe('text');
    expect(byName(perceive(`<body><a href="/x" aria-label="Back"></a></body>`), 'link', 'Back')?.nameSource).toBe('aria-label');
    expect(byName(perceive(`<body><a href="/x"><img alt="Home"></a></body>`), 'link', 'Home')?.nameSource).toBe('alt');
    expect(perceive(`<body><a href="/x"><img></a></body>`).controls.find((c) => c.role === 'link')?.name).toBe('');
  });

  it('ignores an anchor with no href, which is not a link', () => {
    expect(perceive(`<body><a>Not a link</a></body>`).controls.filter((c) => c.role === 'link')).toHaveLength(0);
  });
});

describe('roles', () => {
  it('maps input types and elements onto the closed role vocabulary', () => {
    const v = perceive(`<body>
      <input type="password" name="pw">
      <input type="checkbox" name="cb">
      <input type="radio" name="rb">
      <input type="hidden" name="h">
      <textarea name="ta"></textarea>
      <select name="s"><option value="1">One</option></select>
      <h2>Heading</h2>
      <p>text</p>
    </body>`);
    const roles = v.controls.map((c) => c.role);
    expect(roles).toContain('password');
    expect(roles).toContain('checkbox');
    expect(roles).toContain('radio');
    expect(roles).toContain('textbox');
    expect(roles).toContain('combobox');
    // Hidden inputs are not controls, and headings surface as `section`.
    expect(v.controls.some((c) => c.attrs['name'] === 'h')).toBe(false);
    expect(roles).not.toContain('heading');
  });

  it('honours an explicit role attribute', () => {
    const v = perceive(`<body>
      <div role="button">Go</div>
      <div role="alertdialog"><h3>Warning</h3></div>
      <div role="status">Saved</div>
      <div role="heading">Title</div>
    </body>`);
    expect(byName(v, 'button', 'Go')).toBeDefined();
    expect(v.controls.some((c) => c.role === 'dialog')).toBe(true);
    expect(v.controls.some((c) => c.role === 'alert')).toBe(true);
  });

  it('names a dialog from its heading, or from its text when it has none', () => {
    const withHeading = perceive(`<body><div role="dialog"><h3>Scheduled Maintenance</h3><p>later</p></div></body>`);
    expect(byName(withHeading, 'dialog', 'Scheduled Maintenance')).toBeDefined();
    const without = perceive(`<body><div role="dialog">Session about to expire</div></body>`);
    expect(v2Name(without)).toContain('Session about to expire');
    function v2Name(v: ReturnType<typeof perceive>): string {
      return v.controls.find((c) => c.role === 'dialog')!.name;
    }
  });
});

describe('sections', () => {
  it('attributes a control to the styled title bar above it', () => {
    const v = perceive(`${STYLE}<body><div class="hdr">MEMBER INQUIRY</div><input type="text" name="m"></body>`);
    expect(v.controls[0]?.section).toBe('MEMBER INQUIRY');
  });

  it('recognises real headings and legends as sections', () => {
    for (const [tag, text] of [['h1', 'One'], ['legend', 'Two']] as const) {
      const v = perceive(`<body><${tag}>${text}</${tag}><input type="text" name="m"></body>`);
      expect(v.controls[0]?.section, tag).toBe(text);
    }
  });

  it('recognises a table caption as a section', () => {
    const v = perceive(
      `<body><table><caption>SHARE LIST</caption><tr><td>x</td></tr></table><input type="text" name="m"></body>`,
    );
    expect(v.controls.find((c) => c.role === 'textbox')?.section).toBe('SHARE LIST');
  });

  it('does not treat an inline or table-cell element as a section', () => {
    const v = perceive(`${STYLE}<body><span class="inlinebold">Inline</span><input type="text" name="m"></body>`);
    expect(v.controls[0]?.section).toBeUndefined();
  });

  it('ignores a bold block that is too long to be a title', () => {
    const v = perceive(`${STYLE}<body><div class="hdr">${'x'.repeat(120)}</div><input type="text" name="m"></body>`);
    expect(v.controls[0]?.section).toBeUndefined();
  });

  it('takes the nearest preceding section, and an enclosing one when there is no sibling', () => {
    const v = perceive(
      `${STYLE}<body><div class="hdr">FIRST</div><div class="hdr">SECOND</div><input type="text" name="m"></body>`,
    );
    expect(v.controls[0]?.section).toBe('SECOND');
  });
});

describe('visibility', () => {
  it('skips elements hidden by display, visibility, opacity or zero size', () => {
    const v = perceive(`${STYLE}<body>
      <input type="text" name="a" class="gone">
      <input type="text" name="b" class="invis">
      <input type="text" name="c" class="clear">
      <input type="text" name="d" data-zero-size>
      <input type="text" name="e">
    </body>`);
    expect(v.controls.map((c) => c.attrs['name'])).toEqual(['e']);
  });
});

describe('table cells as values', () => {
  it('names a grid cell from its column header and records the whole row', () => {
    const v = perceive(`<body><table>
      <tr><td>Sfx</td><td>Product</td><td>Balance</td></tr>
      <tr><td>0001</td><td>REGULAR SHARE SAVINGS</td><td>4182.55</td></tr>
    </table></body>`);
    const balance = byValue(v, '4182.55')!;
    expect(balance).toMatchObject({ role: 'cell', name: 'Balance', nameSource: 'column-header' });
    expect(balance.rowText).toContain('REGULAR SHARE SAVINGS');
    expect(balance.rowKey).toBe('0001');
  });

  it('names a layout cell from the label beside it', () => {
    const v = perceive(`<body><table><tr><td>Name</td><td>DELACROIX, R M</td></tr></table></body>`);
    expect(byValue(v, 'DELACROIX, R M')).toMatchObject({ name: 'Name', nameSource: 'adjacent-cell' });
  });

  it('leaves a cell unnamed when there is no header and no label', () => {
    const v = perceive(`<body><table><tr><td>Lonely</td></tr></table></body>`);
    expect(byValue(v, 'Lonely')?.name).toBe('');
  });

  it('skips a header cell that is too long to be a column name', () => {
    const v = perceive(`<body><table>
      <tr><td>${'h'.repeat(80)}</td></tr>
      <tr><td>value</td></tr>
    </table></body>`);
    expect(byValue(v, 'value')?.name).toBe('');
  });

  it('skips layout wrappers, cells holding controls, empty cells and very long cells', () => {
    const v = perceive(`<body><table><tr>
      <td><table><tr><td>nested</td></tr></table></td>
      <td><input name="x"></td>
      <td></td>
      <td>${'y'.repeat(100)}</td>
      <td>kept</td>
    </tr></table></body>`);
    const cellValues = v.controls.filter((c) => c.role === 'cell').map((c) => c.value);
    expect(cellValues).toContain('kept');
    expect(cellValues).toContain('nested');
    expect(cellValues.some((x) => (x ?? '').length > 90)).toBe(false);
  });

  it('caps how many cells one screen can contribute', () => {
    const rows = Array.from({ length: 200 }, (_, i) => `<tr><td>h</td><td>v${i}</td></tr>`).join('');
    const v = perceive(`<body><table>${rows}</table></body>`);
    expect(v.controls.filter((c) => c.role === 'cell').length).toBeLessThanOrEqual(150);
  });
});

describe('values and attributes', () => {
  it('records the value and options of a select, for the model to choose from', () => {
    const v = perceive(
      `<body><select name="prod"><option value="SV02">SECONDARY SHARE</option><option value="VC01">VACATION</option></select></body>`,
    );
    const sel = v.controls.find((c) => c.role === 'combobox')!;
    expect(sel.value).toBe('SV02');
    expect(sel.attrs['options']).toContain('VC01|VACATION');
  });

  it('never reads back a password field', () => {
    const v = perceive(`<body><input type="password" name="pw" value="secret"></body>`);
    expect(v.controls[0]).toMatchObject({ role: 'password', sensitive: true });
    expect(v.controls[0]?.value).toBeUndefined();
  });

  it('records a disabled control as disabled rather than hiding it', () => {
    const v = perceive(`<body><input type="text" name="m" disabled></body>`);
    expect(v.controls[0]?.enabled).toBe(false);
  });

  it('keeps only the attributes a locator hint can use, truncated', () => {
    const v = perceive(`<body><form action="/go"><input type="text" name="m" maxlength="5" value="${'v'.repeat(200)}"></form></body>`);
    expect(Object.keys(v.controls[0]!.attrs).sort()).toEqual(['maxlength', 'name', 'type', 'value']);
    expect(v.controls[0]!.attrs['value']!.length).toBeLessThanOrEqual(120);
  });
});

describe('selector hints', () => {
  it('prefers a form-scoped name, then an id, then a structural path', () => {
    expect(perceive(`<body><form action="/s"><input type="text" name="m"></form></body>`).controls[0]?.selector).toBe(
      'form[action="/s"] input[name="m"]',
    );
    expect(perceive(`<body><input type="text" name="m"></body>`).controls[0]?.selector).toBe('input[name="m"]');
    expect(perceive(`<body><input type="text" id="mbr:1"></body>`).controls[0]?.selector).toContain('#mbr');
    const path = perceive(`<body><div><span></span><div><input type="text"></div></div></body>`).controls[0]?.selector;
    expect(path).toContain('input');
  });

  it('disambiguates siblings of the same tag with nth-of-type', () => {
    const v = perceive(`<body><div><p></p><p><input type="text"></p></div></body>`);
    expect(v.controls[0]?.selector).toContain('nth-of-type');
  });
});

describe('alerts', () => {
  it('picks up aria alert and dialog roles', () => {
    const v = perceive(`<body><div role="alert">No member found for 99999.</div></body>`);
    expect(v.alerts.join(' ')).toContain('No member found');
  });

  it('picks up a legacy error banner by its colour, with no role at all', () => {
    const v = perceive(`${STYLE}<body><div class="err">Member Number must be exactly 5 digits.</div></body>`);
    expect(v.alerts.join(' ')).toContain('must be exactly 5 digits');
  });

  it('picks up a red background as well as red text', () => {
    const v = perceive(`${STYLE}<body><div class="redbg">Access is restricted.</div></body>`);
    expect(v.alerts.join(' ')).toContain('restricted');
  });

  it('ignores ordinary text, long blocks, and hidden elements', () => {
    const v = perceive(`${STYLE}<body>
      <div>ordinary</div>
      <div class="err">${'x'.repeat(400)}</div>
      <div class="err gone">hidden error</div>
    </body>`);
    expect(v.alerts.join(' ')).not.toContain('ordinary');
    expect(v.alerts.join(' ')).not.toContain('hidden error');
    expect(v.alerts.some((a) => a.length > 300)).toBe(false);
  });

  it('does not repeat the same alert text twice', () => {
    const v = perceive(`${STYLE}<body><div class="err">Same message.</div><div class="err">Same message.</div></body>`);
    expect(v.alerts.filter((a) => a.includes('Same message'))).toHaveLength(1);
  });
});

describe('frame text and handles', () => {
  it('uses innerText when the platform provides it, and textContent when it does not', () => {
    expect(perceive(`<body><div>from text content</div></body>`).text).toContain('from text content');
    expect(perceive(`<body><div>ignored</div></body>`, { innerText: 'from inner text' }).text).toBe('from inner text');
  });

  it('caps the amount of screen text it carries', () => {
    expect(perceive(`<body><div>${'z'.repeat(9000)}</div></body>`).text.length).toBeLessThanOrEqual(6000);
  });

  it('stamps a handle on every control and clears stale ones first', () => {
    const first = perceive(`<body><input type="text" name="a"><input type="text" name="b"></body>`);
    expect(first.controls.map((c) => c.handle)).toEqual(['f0c0', 'f0c1']);
    expect(document.querySelectorAll('[data-hs-h]')).toHaveLength(2);

    // A second pass over the same document must not accumulate handles.
    const second = extractAgain();
    expect(second.controls.map((c) => c.handle)).toEqual(['f0c0', 'f0c1']);
    expect(document.querySelectorAll('[data-hs-h]')).toHaveLength(2);
  });
});

function extractAgain() {
  // Re-run the pass over the document left by the previous call.
  return perceive(document.body.outerHTML);
}

describe('edge cases of the platform', () => {
  it('returns an empty view for a frame caught mid-navigation with no body', () => {
    // jsdom recreates a body from markup, so remove it explicitly: the branch
    // under test is a real transient state in a browser, not a parse artefact.
    document.documentElement.innerHTML = '<head></head><body></body>';
    installPolyfills();
    document.documentElement.removeChild(document.body);
    expect(document.body).toBeNull();
    expect(extract('f0')).toEqual({ text: '', alerts: [], controls: [] });
  });

  it('takes an enclosing title bar only when no earlier one applies', () => {
    // A control wrapped by the styled title bar rather than following it.
    const v = perceive(`${STYLE}<body><div class="hdr">PANEL<input type="text" name="m"></div></body>`);
    expect(v.controls.find((c) => c.role === 'textbox')?.section).toBe('PANEL');
  });

  it('prefers a preceding title bar over an enclosing one', () => {
    const v = perceive(
      `${STYLE}<body><div class="hdr">EARLIER</div><div class="hdr">WRAPPER<input type="text" name="m"></div></body>`,
    );
    expect(v.controls.find((c) => c.role === 'textbox')?.section).toBe('EARLIER');
  });

  it('skips a hidden table cell', () => {
    const v = perceive(`${STYLE}<body><table><tr><td class="gone">hidden value</td><td>shown</td></tr></table></body>`);
    const values = v.controls.filter((c) => c.role === 'cell').map((c) => c.value);
    expect(values).toContain('shown');
    expect(values).not.toContain('hidden value');
  });

  it('ignores a colour the platform reports in a form it cannot parse', () => {
    // Browsers resolve colours to rgb(), but the guard exists because a
    // platform that reports a keyword must not be read as an alert.
    const original = window.getComputedStyle.bind(window);
    const spy = (el: Element, pseudo?: string | null) => {
      const style = original(el, pseudo ?? undefined);
      if ((el as HTMLElement).id === 'odd') {
        return { ...style, color: 'rebeccapurple', backgroundColor: 'transparent' } as CSSStyleDeclaration;
      }
      return style;
    };
    Object.defineProperty(window, 'getComputedStyle', { value: spy, configurable: true });
    try {
      const v = perceive('<body><div id="odd">not an alert</div></body>');
      expect(v.alerts).toEqual([]);
    } finally {
      Object.defineProperty(window, 'getComputedStyle', { value: original, configurable: true });
    }
  });
});
