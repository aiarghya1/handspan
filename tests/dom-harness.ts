/**
 * Runs the in-page perception pass in Node, under jsdom.
 *
 * `extractFrame` normally executes inside Chromium, where Node's coverage
 * instrumentation cannot see it. jsdom gives it a real DOM with a real style
 * cascade - font weight, colours and `display` all resolve correctly, which is
 * what the naming and alert heuristics key off - so the same function can be
 * driven directly and measured.
 *
 * Two things jsdom does not implement, supplied here rather than stubbed out of
 * the code under test:
 *
 *   - `getBoundingClientRect` always returns zeros, which the visibility check
 *     correctly treats as invisible. The harness returns a real box, and honours
 *     `data-zero-size` so the invisible branch can still be exercised.
 *   - `CSS.escape`, used when building a selector hint from an element id.
 *
 * The Playwright test in `extract.test.ts` remains the check that this behaviour
 * holds in a real browser; this one is the check that every branch of it is
 * reached.
 */

import { extractFrame, type RawFrameView } from '../src/surface/web/extract.js';

export function installDomPolyfills(): void {
  const proto = window.Element.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  };
  proto.getBoundingClientRect = function (this: Element): DOMRect {
    const zero = this.hasAttribute('data-zero-size');
    const box = { x: 4, y: 8, width: zero ? 0 : 120, height: zero ? 0 : 18 };
    return { ...box, top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box } as DOMRect;
  };
  if (!(globalThis as { CSS?: unknown }).CSS) {
    (globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s.replace(/([^\w-])/g, '\\$1') };
  }
}

/** The extraction pass itself, for tests that set up the document themselves. */
export const extract = extractFrame;

export function perceive(html: string, opts: { innerText?: string } = {}): RawFrameView {
  document.documentElement.innerHTML = html;
  installDomPolyfills();
  if (opts.innerText !== undefined) {
    Object.defineProperty(document.body, 'innerText', { value: opts.innerText, configurable: true });
  }
  return extractFrame('f0');
}

export const byName = (v: RawFrameView, role: string, name: string) =>
  v.controls.find((c) => c.role === role && c.name.toLowerCase() === name.toLowerCase());

export const byValue = (v: RawFrameView, value: string) => v.controls.find((c) => c.value === value);
