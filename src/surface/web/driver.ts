/**
 * Web surface adapter: Playwright + the in-page perception pass.
 *
 * Two decisions worth naming.
 *
 * 1. The model's action space is *controls*, never coordinates. It is offered a
 *    list of named controls and picks one by handle. Screenshots go to the model
 *    as perceptual context, but a click is always "the button named Continue in
 *    frame main", never "pixel 412,308". That constraint is what makes a
 *    discovery run recordable at all: a coordinate is not a durable locator, so
 *    an agent that clicks coordinates produces nothing replayable.
 *
 * 2. resolve() re-perceives before every action rather than trusting a cached
 *    observation. Legacy apps navigate on almost every interaction, so a cached
 *    handle is stale more often than not. Re-perceiving costs ~50ms here and
 *    removes a whole class of flake.
 */

import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright';
import {
  type Control,
  type ControlRef,
  type ControlRole,
  type FramePath,
  type FrameView,
  type Observation,
  type Resolution,
  type ScreenshotOptions,
  type SurfaceDriver,
  type SurfaceKind,
} from '../types.js';
import { normalizeName, resolveFromControls } from '../match.js';
import { extractFrame, type RawFrameView } from './extract.js';

/**
 * Evaluate a TypeScript function inside a frame.
 *
 * Playwright serializes the function with `toString()`, which means any helper
 * the transpiler injected into module scope becomes a free variable in the
 * page: esbuild (which tsx uses) emits `__name` wrappers to preserve function
 * names, and the naked function then throws `ReferenceError: __name is not
 * defined` in the browser.
 *
 * So the function is shipped as a self-invoking expression - Playwright treats
 * a string payload as an expression, not as a callable - inside a scope that
 * defines the shims. Perception is then independent of how the project is
 * built, at the cost of the argument having to be JSON-serializable.
 */
/**
 * A frame that navigated or detached while it was being read is a normal
 * transient state, not a fault: the next observation picks it up. Anything else
 * is a perception bug and must surface.
 */
function isTransientFrameError(err: unknown): boolean {
  return /detached|navigat|destroyed|Target closed|Execution context/i.test(String(err));
}

async function evaluateInFrame<A, R>(frame: Frame, fn: (arg: A) => R, arg: A): Promise<R> {
  const src = `(() => {
    const __name = (f) => f;
    const __publicField = (o, k, v) => (o[k] = v);
    return (${fn.toString()})(${JSON.stringify(arg)});
  })()`;
  return frame.evaluate<R>(src);
}

export interface WebDriverOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Regexes whose matches are painted over in screenshots and never logged. */
  sensitivePatterns?: RegExp[];
  defaultTimeoutMs?: number;
  /**
   * How long to wait after an action for a navigation to *start*. Clicking a
   * submit button resolves as soon as the event is dispatched, before the
   * browser has issued the request, so without this window the next
   * observation reads the old document.
   */
  postActionSettleMs?: number;
  /**
   * Shorter than the general timeout: a click that replaces the document is
   * recognized by the navigation it caused, so there is nothing to gain by
   * letting Playwright retry actionability against a detached element for the
   * full ten seconds.
   */
  clickTimeoutMs?: number;
  /** CDP port, so a human operator can attach to the same live session. */
  remoteDebuggingPort?: number;
}

export class WebSurfaceDriver implements SurfaceDriver {
  readonly surface: SurfaceKind = 'web-legacy';

  private browser!: Browser;
  private context!: BrowserContext;
  private page!: Page;
  private lastObservation?: Observation;
  /** Monotonic count of frame navigations, used to tell whether an action landed. */
  private navCount = 0;
  private frameOfHandle = new Map<string, Frame>();
  private readonly opts: Required<Omit<WebDriverOptions, 'remoteDebuggingPort'>> & {
    remoteDebuggingPort?: number;
  };

  constructor(opts: WebDriverOptions = {}) {
    this.opts = {
      headless: opts.headless ?? true,
      viewport: opts.viewport ?? { width: 1280, height: 900 },
      sensitivePatterns: opts.sensitivePatterns ?? [],
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 10_000,
      postActionSettleMs: opts.postActionSettleMs ?? 1_200,
      clickTimeoutMs: opts.clickTimeoutMs ?? 4_000,
      remoteDebuggingPort: opts.remoteDebuggingPort,
    };
  }

  static async launch(opts: WebDriverOptions = {}): Promise<WebSurfaceDriver> {
    const d = new WebSurfaceDriver(opts);
    const args =
      d.opts.remoteDebuggingPort === undefined ? [] : [`--remote-debugging-port=${d.opts.remoteDebuggingPort}`];
    d.browser = await chromium.launch({ headless: d.opts.headless, args });
    d.context = await d.browser.newContext({ viewport: d.opts.viewport });
    d.context.setDefaultTimeout(d.opts.defaultTimeoutMs);
    d.page = await d.context.newPage();
    d.page.on('framenavigated', () => {
      d.navCount += 1;
    });
    return d;
  }

  /** Exposed so the escalation broker can hand the same session to a human. */
  livePage(): Page {
    return this.page;
  }

  currentUrl(): string {
    return this.page.url();
  }

  // -- perception ----------------------------------------------------------

  private framePathOf(frame: Frame): FramePath {
    const path: FramePath = [];
    let cur: Frame | null = frame;
    while (cur) {
      const parent: Frame | null = cur.parentFrame();
      if (!parent) break;
      const siblings = parent.childFrames();
      const name = cur.name();
      path.unshift(name ? { name } : { index: siblings.indexOf(cur) });
      cur = parent;
    }
    return path;
  }

  async observe(opts: { screenshot?: boolean } = {}): Promise<Observation> {
    await this.waitForQuiescence(this.opts.defaultTimeoutMs).catch(() => {});

    const frames = this.page.frames();
    const frameViews: FrameView[] = [];
    const controls: Control[] = [];
    this.frameOfHandle.clear();

    for (let fi = 0; fi < frames.length; fi++) {
      const frame = frames[fi]!;
      let raw: RawFrameView;
      try {
        raw = await evaluateInFrame<string, RawFrameView>(frame, extractFrame, `f${fi}`);
      } catch (err) {
        // No separate detached-frame check: reading a detached frame throws, and
        // that throw is one of the transient cases below.
        if (isTransientFrameError(err)) continue;
        throw new Error(`perception failed in frame ${fi} (${frame.url()}): ${String(err)}`);
      }
      const framePath = this.framePathOf(frame);

      // Ordinals are assigned per frame over role+normalized-name, so an
      // artifact's ordinal keeps meaning even if unrelated controls move.
      const groupCounts = new Map<string, number>();
      for (const rc of raw.controls) {
        const key = `${rc.role}::${normalizeName(rc.name)}`;
        const ordinal = groupCounts.get(key) ?? 0;
        groupCounts.set(key, ordinal + 1);

        const control: Control = {
          handle: rc.handle,
          role: rc.role as ControlRole,
          name: rc.name,
          nameSource: rc.nameSource as Control['nameSource'],
          value: this.maskIfSensitive(rc.value, rc.sensitive),
          enabled: rc.enabled,
          framePath,
          section: rc.section,
          rowKey: rc.rowKey,
          rowText: rc.rowText,
          ordinal,
          bbox: rc.bbox,
          hints: { selector: rc.selector, tag: rc.tag, attrs: rc.attrs, nearText: rc.nearText },
          sensitive: rc.sensitive || this.looksSensitive(rc.value),
        };
        controls.push(control);
        this.frameOfHandle.set(rc.handle, frame);
      }

      frameViews.push({ framePath, url: frame.url(), text: raw.text, alerts: raw.alerts });
    }

    const obs: Observation = {
      at: new Date().toISOString(),
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      frames: frameViews,
      controls,
    };
    this.lastObservation = obs;
    return obs;
  }

  private looksSensitive(value: string | undefined): boolean {
    if (!value) return false;
    return this.opts.sensitivePatterns.some((re) => re.test(value));
  }

  private maskIfSensitive(value: string | undefined, sensitive?: boolean): string | undefined {
    if (value === undefined) return undefined;
    if (sensitive || this.looksSensitive(value)) return '«redacted»';
    return value;
  }

  // -- resolution ladder ---------------------------------------------------

  /**
   * Perception is re-run before every resolve. On these screens almost every
   * interaction replaces the document, so a cached control list is stale more
   * often than not; re-perceiving costs tens of milliseconds and removes an
   * entire class of flake.
   */
  async resolve(ref: ControlRef): Promise<Resolution> {
    const obs = await this.observe();
    return resolveFromControls(ref, obs.controls);
  }

  private frameFor(res: Resolution): Frame {
    const frame = this.frameOfHandle.get(res.control.handle);
    if (!frame) throw new Error(`handle ${res.control.handle} is no longer live; re-observe before acting`);
    return frame;
  }

  private locator(res: Resolution) {
    return this.frameFor(res).locator(`[data-hs-h="${res.control.handle}"]`);
  }

  // -- actions -------------------------------------------------------------

  /**
   * Did the page move, and has it finished moving?
   *
   * On these screens practically every interaction is a server round-trip, so
   * "has the action taken effect?" is really "has the frame it targeted
   * finished navigating?". A click resolves as soon as the event is dispatched,
   * before the browser has issued the request, so without this window the next
   * observation reads the old document.
   *
   * A counter rather than a one-shot event listener, because it answers the
   * second question too: a click that replaces the document can leave
   * Playwright retrying actionability against an element that no longer exists,
   * and the only way to tell that apart from a click that genuinely missed is
   * to ask whether anything navigated.
   *
   * This is best-effort on purpose. The hard guarantee lives one layer up: the
   * replay engine polls each step's checkpoint until it holds or the step times
   * out, so a settle that returns too early costs a poll, not a failure.
   */
  private async navigatedSince(mark: number, withinMs: number): Promise<boolean> {
    const deadline = Date.now() + withinMs;
    while (this.navCount === mark && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.navCount !== mark;
  }

  private async settle(mark: number): Promise<void> {
    await this.navigatedSince(mark, this.opts.postActionSettleMs);
    await this.waitForQuiescence(this.opts.defaultTimeoutMs).catch(() => {});
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.waitForQuiescence(this.opts.defaultTimeoutMs).catch(() => {});
  }

  async click(res: Resolution): Promise<void> {
    const loc = this.locator(res);
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const mark = this.navCount;
    try {
      await loc.click({ timeout: this.opts.clickTimeoutMs });
    } catch (err) {
      // The submit landed and the document was replaced underneath the click,
      // so Playwright kept retrying against an element that is gone. If
      // something navigated, the click did its job.
      if (!(await this.navigatedSince(mark, 500))) throw err;
    }
    await this.settle(mark);
  }

  async fill(res: Resolution, value: string): Promise<void> {
    const loc = this.locator(res);
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.fill(value, { timeout: this.opts.defaultTimeoutMs });
  }

  async select(res: Resolution, value: string): Promise<void> {
    const loc = this.locator(res);
    // Accept either the option value or its visible label; legacy screens are
    // recorded from what the operator saw, which is the label.
    const mark = this.navCount;
    try {
      await loc.selectOption({ value }, { timeout: 2_000 });
    } catch {
      await loc.selectOption({ label: value }, { timeout: this.opts.defaultTimeoutMs });
    }
    await this.settle(mark);
  }

  async press(key: string, res?: Resolution): Promise<void> {
    const mark = this.navCount;
    try {
      if (res) await this.locator(res).press(key, { timeout: this.opts.clickTimeoutMs });
      else await this.page.keyboard.press(key);
    } catch (err) {
      if (!(await this.navigatedSince(mark, 500))) throw err;
    }
    await this.settle(mark);
  }

  async readText(res: Resolution): Promise<string> {
    const loc = this.locator(res);
    const tag = res.control.hints.tag;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      return (await loc.inputValue()).trim();
    }
    // The locator came from a resolved control, so the element is there and
    // textContent is a string rather than null.
    return (await loc.textContent())!.replace(/\s+/g, ' ').trim();
  }

  // -- evidence ------------------------------------------------------------

  async screenshot(opts: ScreenshotOptions = {}): Promise<Buffer> {
    const mask = opts.maskSensitive === false ? [] : await this.sensitiveLocators();
    return this.page.screenshot({ fullPage: opts.fullPage ?? false, mask });
  }

  /** Locators for password fields and anything matching a sensitive pattern. */
  private async sensitiveLocators() {
    const obs = this.lastObservation ?? (await this.observe());
    const out = [];
    for (const c of obs.controls) {
      if (!c.sensitive) continue;
      // The control list and the handle map are populated together by observe,
      // so every control in the last observation has a frame.
      const frame = this.frameOfHandle.get(c.handle)!;
      out.push(frame.locator(`[data-hs-h="${c.handle}"]`));
    }
    return out;
  }

  async structureSnapshot(): Promise<string> {
    const parts: string[] = [];
    for (const frame of this.page.frames()) {
      // A detached frame simply reports as unavailable rather than needing its
      // own check.
      const html = await frame.content().catch(() => '<unavailable>');
      const path = this.framePathOf(frame)
        .map((f) => f.name ?? `#${f.index}`)
        .join('/');
      parts.push(`<!-- frame ${path || 'top'} : ${frame.url()} -->\n${html}`);
    }
    return parts.join('\n\n');
  }

  async waitForQuiescence(timeoutMs: number): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
    // Legacy screens are server-rendered; networkidle is cheap and sufficient.
    await this.page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 5_000) }).catch(() => {});
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}
