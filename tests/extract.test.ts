/**
 * The perception pass, run against real markup in a real browser.
 *
 * This is the one test that needs Chromium, and it earns it: name synthesis on
 * legacy markup is the foundation everything else stands on, and it cannot be
 * checked without a layout engine. It drives static HTML rather than the mock
 * app, so it is hermetic.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSurfaceDriver } from '../src/surface/web/driver.js';
import type { Control } from '../src/surface/types.js';

const PAGE = `<html><head><style>
  .hdr { font-weight: bold; background: #1f3864; color: #fff; padding: 4px }
  .err { color: #900; background: #ffe8e8; border: 1px solid #a00; padding: 4px }
  td { padding: 2px 4px }
</style></head><body>
  <div class="hdr">MEMBER INQUIRY</div>
  <form action="/member/search" method="post">
    <table><tr>
      <td nowrap>Member Number</td>
      <td><input type="text" name="mbr_no" size="10"></td>
      <td nowrap>Suffix</td>
      <td><input type="text" name="sfx" size="5"></td>
    </tr><tr>
      <td colspan="4"><input type="submit" value="Retrieve"> <input type="reset" value="Clear"></td>
    </tr></table>
  </form>
  <div class="err">Member Number must be exactly 5 numeric digits.</div>
  <div class="hdr">SHARE LIST</div>
  <table>
    <tr><td>Sfx</td><td>Product</td><td>Balance</td></tr>
    <tr><td>0001</td><td>REGULAR SHARE SAVINGS</td><td>4182.55</td></tr>
    <tr><td>0075</td><td>PRIMARY CHECKING</td><td>913.20</td></tr>
  </table>
  <div role="dialog"><h3>Scheduled Maintenance</h3>
    <p>Nightly batch begins at 23:00 ET.</p>
    <button type="button">Continue</button>
  </div>
</body></html>`;

let driver: WebSurfaceDriver;
let controls: Control[];

beforeAll(async () => {
  driver = await WebSurfaceDriver.launch({ headless: true, postActionSettleMs: 100 });
  await driver.livePage().setContent(PAGE);
  controls = (await driver.observe()).controls;
}, 120_000);

afterAll(async () => {
  await driver?.close();
});

const find = (role: string, name: string) =>
  controls.find((c) => c.role === role && c.name.toLowerCase() === name.toLowerCase());

describe('name synthesis on legacy markup', () => {
  it('names a bare input from the table cell beside it', () => {
    // No id, no label/for, no aria-label: the browser computes no accessible
    // name at all. This is the whole reason the cascade exists.
    const mbr = find('textbox', 'Member Number');
    expect(mbr).toBeDefined();
    expect(mbr!.nameSource).toBe('adjacent-cell');
    expect(mbr!.hints.attrs?.['name']).toBe('mbr_no');
  });

  it('names a submit input from its value attribute', () => {
    expect(find('button', 'Retrieve')?.nameSource).toBe('value');
    expect(find('button', 'Clear')).toBeDefined();
  });

  it('attributes each control to the styled title bar above it', () => {
    expect(find('textbox', 'Member Number')?.section).toBe('MEMBER INQUIRY');
    // A styled div is how these screens title a panel; there is no <h1>.
    expect(find('cell', 'Product')?.section).toBe('SHARE LIST');
  });

  it('distinguishes a grid cell from a layout cell by how it got its name', () => {
    const balance = controls.find((c) => c.role === 'cell' && c.value === '4182.55');
    expect(balance!.name).toBe('Balance');
    expect(balance!.nameSource).toBe('column-header');
    expect(balance!.rowText).toContain('REGULAR SHARE SAVINGS');
  });

  it('does not emit layout wrapper cells as values', () => {
    // A <td> containing another table holds a whole sub-screen, not a value.
    expect(controls.filter((c) => c.role === 'cell' && (c.value ?? '').length > 80)).toHaveLength(0);
  });

  it('skips cells that contain controls, since the control is already a target', () => {
    expect(controls.filter((c) => c.role === 'cell' && c.value === '')).toHaveLength(0);
  });
});

describe('alerts and dialogs', () => {
  it('finds an aria dialog and the button inside it', async () => {
    expect(find('dialog', 'Scheduled Maintenance')).toBeDefined();
    expect(find('button', 'Continue')?.section).toBe('Scheduled Maintenance');
  });

  it('finds a legacy error banner that carries no role, by its colour', async () => {
    // These screens style errors red and stop there. Without this heuristic the
    // one signal that something went wrong is invisible to the agent.
    const obs = await driver.observe();
    expect(obs.frames[0]!.alerts.join(' ')).toContain('must be exactly 5 numeric digits');
  });
});

describe('resolution against a live page', () => {
  it('resolves a legacy field at the top tier and can fill it', async () => {
    const res = await driver.resolve({
      role: 'textbox',
      name: 'Member Number',
      scope: { section: 'MEMBER INQUIRY' },
    });
    expect(res.tier).toBe('role+name+scope');
    await driver.fill(res, '12345');
    expect(await driver.readText(res)).toBe('12345');
  });

  it('reads a grid value by row label rather than by position', async () => {
    const res = await driver.resolve({
      role: 'cell',
      name: 'Balance',
      scope: { rowContaining: 'PRIMARY CHECKING' },
    });
    expect(await driver.readText(res)).toBe('913.20');
  });

  it('masks a password field in screenshots', async () => {
    await driver.livePage().setContent('<input type="password" name="pw" value="secret">');
    const obs = await driver.observe();
    expect(obs.controls[0]!.sensitive).toBe(true);
    // The value never leaves the page in the observation either.
    expect(obs.controls[0]!.value).not.toBe('secret');
    expect(await driver.screenshot({ maskSensitive: true })).toBeInstanceOf(Buffer);
  });
});
