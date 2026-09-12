/**
 * The web surface adapter, against a real browser and real navigations.
 *
 * It serves its own pages rather than the demo app, so the test is hermetic and
 * each page isolates one behaviour: a form that replaces the document, a
 * frameset, a select, a page that navigates on a keystroke.
 *
 * The interesting assertions are about timing and identity. A click that
 * submits a form resolves before the browser has issued the request, and the
 * element it acted on is gone by the time the request completes - the two
 * things that make naive automation flaky on these screens.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { AmbiguousControlError, ControlNotFoundError } from '../src/surface/types.js';
import { WebSurfaceDriver } from '../src/surface/web/driver.js';

let server: Server;
let base = '';
let driver: WebSurfaceDriver;

const page = (body: string) => `<html><head><style>.hdr{font-weight:bold}</style></head><body>${body}</body></html>`;

beforeAll(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (_q, r) =>
    r.send(
      page(`<div class="hdr">HOME</div>
        <a href="/detail">Go to detail</a>
        <form method="post" action="/search">
          <table><tr><td>Member Number</td><td><input type="text" name="mbr"></td></tr></table>
          <input type="submit" value="Retrieve">
        </form>`),
    ),
  );
  app.post('/search', (q, r) =>
    r.send(page(`<div class="hdr">RESULT</div><p>searched for ${String((q.body as { mbr?: string }).mbr ?? '')}</p>`)),
  );
  app.get('/detail', (_q, r) => r.send(page('<div class="hdr">DETAIL</div><p>the detail screen</p>')));
  app.get('/frames', (_q, r) =>
    r.send(`<html><frameset cols="150,*"><frame name="nav" src="/nav"><frame src="/detail"></frameset></html>`),
  );
  app.get('/nav', (_q, r) => r.send(page('<div class="hdr">MENU</div><a href="/detail" target="_self">Detail</a>')));
  app.get('/select', (_q, r) =>
    r.send(
      page(`<div class="hdr">PRODUCT</div>
        <table><tr><td>Product</td><td>
          <select name="prod"><option value="SV02">SECONDARY SHARE</option><option value="VC01">VACATION CLUB</option></select>
        </td></tr></table>`),
    ),
  );
  app.get('/keyboard', (_q, r) =>
    r.send(
      page(`<div class="hdr">KEYBOARD</div>
        <form action="/detail" method="get">
          <table><tr><td>Quick Find</td><td><input type="text" name="q"></td></tr></table>
        </form>`),
    ),
  );
  app.get('/twins', (_q, r) => r.send(page('<div class="hdr">TWINS</div><button>Confirm</button><button>Confirm</button>')));
  app.get('/secret', (_q, r) =>
    r.send(page('<div class="hdr">SIGN ON</div><table><tr><td>Password</td><td><input type="password" name="pw"></td></tr></table>')),
  );
  app.get('/taxid', (_q, r) => r.send(page('<div class="hdr">MEMBER</div><table><tr><td>Tax ID</td><td>412-88-0031</td></tr></table>')));
  app.get('/covered', (_q, r) =>
    r.send(
      page(`<div class="hdr">COVERED</div>
        <button style="position:absolute;top:40px;left:0;width:100px;height:20px">Underneath</button>
        <div style="position:absolute;top:0;left:0;width:400px;height:200px;background:#fff"></div>`),
    ),
  );
  app.get('/racing', (_q, r) =>
    r.send(`<html><frameset cols="150,*"><frame src="/mid-navigation"><frame src="/detail"></frameset></html>`),
  );
  app.get('/mid-navigation', (_q, r) =>
    r.send(
      page(`<div class="hdr">RACING</div>
        <script>document.createTreeWalker = function () {
          throw new Error('Execution context was destroyed, most likely because of a navigation');
        };</script>`),
    ),
  );
  app.get('/broken', (_q, r) =>
    r.send(
      page(`<div class="hdr">BROKEN</div>
        <script>document.createTreeWalker = function () { throw new Error('walker unavailable in this document'); };</script>`),
    ),
  );

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      base = `http://localhost:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });

  driver = await WebSurfaceDriver.launch({
    headless: true,
    postActionSettleMs: 900,
    sensitivePatterns: [/\b\d{3}-\d{2}-\d{4}\b/],
  });
}, 120_000);

afterAll(async () => {
  await driver?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('navigation', () => {
  it('goes to a url and reports where it is', async () => {
    await driver.navigate(`${base}/detail`);
    expect(driver.currentUrl()).toBe(`${base}/detail`);
    expect((await driver.observe()).title).toBeDefined();
  });

  it('follows a link and settles on the new document', async () => {
    await driver.navigate(base);
    await driver.click(await driver.resolve({ role: 'link', name: 'Go to detail' }));
    expect(driver.currentUrl()).toBe(`${base}/detail`);
    expect((await driver.observe()).frames[0]!.text).toContain('the detail screen');
  });
});

describe('a click that replaces the document', () => {
  it('submits the form and waits for the result, not for the click', async () => {
    // The click resolves before the browser has issued the POST. Without the
    // navigation watch, the next observation reads the old page.
    await driver.navigate(base);
    await driver.fill(await driver.resolve({ role: 'textbox', name: 'Member Number' }), '12345');
    await driver.click(await driver.resolve({ role: 'button', name: 'Retrieve' }));

    const obs = await driver.observe();
    expect(obs.frames[0]!.text).toContain('searched for 12345');
    expect(driver.currentUrl()).toContain('/search');
  });

  it('treats a click whose element detaches mid-action as having landed', async () => {
    await driver.navigate(base);
    await driver.click(await driver.resolve({ role: 'button', name: 'Retrieve' }));
    expect((await driver.observe()).frames[0]!.text).toContain('searched for');
  });
});

describe('typing and selecting', () => {
  it('reads back what it typed', async () => {
    await driver.navigate(base);
    const field = await driver.resolve({ role: 'textbox', name: 'Member Number' });
    await driver.fill(field, '23456');
    expect(await driver.readText(await driver.resolve({ role: 'textbox', name: 'Member Number' }))).toBe('23456');
  });

  it('selects by option value and by visible label', async () => {
    await driver.navigate(`${base}/select`);
    const byValue = await driver.resolve({ role: 'combobox', name: 'Product' });
    await driver.select(byValue, 'VC01');
    expect(await driver.readText(await driver.resolve({ role: 'combobox', name: 'Product' }))).toBe('VC01');

    // A recording captures what the operator saw, which is the label.
    await driver.select(await driver.resolve({ role: 'combobox', name: 'Product' }), 'SECONDARY SHARE');
    expect(await driver.readText(await driver.resolve({ role: 'combobox', name: 'Product' }))).toBe('SV02');
  });

  it('presses a key on a control, and on the page', async () => {
    await driver.navigate(`${base}/keyboard`);
    const field = await driver.resolve({ role: 'textbox', name: 'Quick Find' });
    await driver.press('Enter', field);
    // The form submits on Enter with no button to name.
    expect(driver.currentUrl()).toContain('/detail');

    await driver.navigate(`${base}/detail`);
    await driver.press('Tab');
    expect(driver.currentUrl()).toBe(`${base}/detail`);
  });
});

describe('framesets', () => {
  it('perceives every frame and scopes controls to the right one', async () => {
    await driver.navigate(`${base}/frames`);
    const obs = await driver.observe();
    expect(obs.frames.map((f) => f.framePath.map((p) => p.name ?? `#${p.index}`).join('/'))).toEqual(['', 'nav', '#1']);

    const inNav = await driver.resolve({ role: 'link', name: 'Detail', scope: { frame: { name: 'nav' } } });
    expect(inNav.control.framePath).toEqual([{ name: 'nav' }]);
  });

  it('gives an unnamed frame an index, since it has nothing else', async () => {
    await driver.navigate(`${base}/frames`);
    const obs = await driver.observe();
    const unnamed = obs.frames.find((f) => f.framePath[0]?.index !== undefined);
    expect(unnamed?.url).toContain('/detail');
  });

  it('captures the html of every frame in a snapshot', async () => {
    await driver.navigate(`${base}/frames`);
    const snap = await driver.structureSnapshot();
    expect(snap).toContain('<!-- frame top');
    expect(snap).toContain('<!-- frame nav');
    expect(snap).toContain('MENU');
    expect(snap).toContain('the detail screen');
  });
});

describe('resolution failures', () => {
  it('reports a control that is not there', async () => {
    await driver.navigate(`${base}/detail`);
    await expect(driver.resolve({ role: 'button', name: 'Nowhere' })).rejects.toThrow(ControlNotFoundError);
  });

  it('refuses to choose between two identical controls', async () => {
    await driver.navigate(`${base}/twins`);
    await expect(driver.resolve({ role: 'button', name: 'Confirm' })).rejects.toThrow(AmbiguousControlError);
  });

  it('uses an ordinal to pick one of them', async () => {
    await driver.navigate(`${base}/twins`);
    const second = await driver.resolve({ role: 'button', name: 'Confirm', ordinal: 1 });
    expect(second.control.ordinal).toBe(1);
  });

  it('falls back to a selector hint when the name has changed', async () => {
    await driver.navigate(base);
    const real = await driver.resolve({ role: 'textbox', name: 'Member Number' });
    const hint = real.control.hints.selector!;
    const viaHint = await driver.resolve({ role: 'textbox', name: 'Renamed Field', hints: { selector: hint } });
    expect(viaHint.tier).toBe('hint-selector');
    expect(viaHint.control.hints.selector).toBe(hint);
  });
});

describe('sensitive values', () => {
  it('never reads back a password field', async () => {
    await driver.navigate(`${base}/secret`);
    const obs = await driver.observe();
    const pw = obs.controls.find((c) => c.role === 'password')!;
    expect(pw.sensitive).toBe(true);
    expect(pw.value).toBeUndefined();
  });

  it('masks a value matching a sensitive pattern, wherever it appears', async () => {
    await driver.navigate(`${base}/taxid`);
    const obs = await driver.observe();
    const cell = obs.controls.find((c) => c.role === 'cell' && c.name === 'Tax ID')!;
    expect(cell.value).toBe('«redacted»');
    expect(cell.sensitive).toBe(true);
  });

  it('produces a screenshot with and without masking', async () => {
    await driver.navigate(`${base}/taxid`);
    await driver.observe();
    expect(await driver.screenshot({ maskSensitive: true })).toBeInstanceOf(Buffer);
    expect(await driver.screenshot({ maskSensitive: false, fullPage: true })).toBeInstanceOf(Buffer);
  });

  it('can screenshot before anything has been observed', async () => {
    const fresh = await WebSurfaceDriver.launch({ headless: true, postActionSettleMs: 200 });
    try {
      await fresh.navigate(`${base}/detail`);
      expect(await fresh.screenshot()).toBeInstanceOf(Buffer);
    } finally {
      await fresh.close();
    }
  }, 60_000);
});

describe('the live page handle', () => {
  it('is the same page the driver is using, which is what an operator takes over', async () => {
    await driver.navigate(`${base}/detail`);
    expect(driver.livePage().url()).toBe(`${base}/detail`);
  });
});

describe('waiting', () => {
  it('returns once the document is loaded', async () => {
    await driver.navigate(`${base}/detail`);
    await expect(driver.waitForQuiescence(5_000)).resolves.toBeUndefined();
  });
});

describe('acting on a stale resolution', () => {
  it('refuses rather than acting on the wrong control', async () => {
    await driver.navigate(base);
    const stale = await driver.resolve({ role: 'link', name: 'Go to detail' });
    await driver.navigate(`${base}/detail`);
    // The handle map is rebuilt on every observation, so the old handle is gone.
    await expect(driver.click({ ...stale, control: { ...stale.control, handle: 'f9c9' } })).rejects.toThrow(/no longer live/);
  });
});

describe('defaults and failure modes', () => {
  it('launches headless when nothing says otherwise', async () => {
    const d = await WebSurfaceDriver.launch();
    try {
      await d.navigate(`${base}/detail`);
      expect((await d.observe()).frames[0]!.text).toContain('the detail screen');
    } finally {
      await d.close();
    }
  }, 90_000);

  it('reports a click that could not land and caused no navigation', async () => {
    // An overlay swallows the click, so Playwright times out and nothing moved.
    await driver.navigate(`${base}/covered`);
    const target = await driver.resolve({ role: 'button', name: 'Underneath' });
    await expect(driver.click(target)).rejects.toThrow();
    expect(driver.currentUrl()).toContain('/covered');
  }, 60_000);

  it('reports a keystroke that could not land either', async () => {
    await driver.navigate(`${base}/covered`);
    const target = await driver.resolve({ role: 'button', name: 'Underneath' });
    await expect(driver.press('Enter', { ...target, control: { ...target.control, handle: 'f9c9' } })).rejects.toThrow();
  }, 60_000);

  it('does not hide a perception failure behind a navigation excuse', async () => {
    // The in-page pass throws for a reason that has nothing to do with
    // navigating, which must surface rather than be skipped silently.
    await driver.navigate(`${base}/broken`);
    await expect(driver.observe()).rejects.toThrow(/perception failed in frame/);
  }, 60_000);
});

describe('a frame that moves while it is being read', () => {
  it('is skipped rather than treated as a fault', async () => {
    await driver.navigate(`${base}/racing`);
    const obs = await driver.observe();
    // The frame reported an error that names a navigation, so it contributed
    // nothing and the rest of the page was still perceived.
    expect(obs.frames.some((f) => f.url.includes('/detail'))).toBe(true);
  }, 60_000);
});
