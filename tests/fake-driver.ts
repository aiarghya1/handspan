/**
 * An in-memory surface, used to test the replay engine without a browser.
 *
 * It exists because the interesting replay behaviour is the error taxonomy -
 * business outcome versus recoverable versus hard failure - and driving a real
 * browser into each of those states is slow and indirect. The fake is a state
 * machine of screens: an action moves it to a named screen, and a screen is
 * just a list of controls and some text.
 *
 * That it is straightforward to write is itself the point. `SurfaceDriver` is
 * the surface seam, so if a fake can implement it in a hundred lines, so can a
 * desktop adapter over UI Automation.
 */

import type {
  Condition,
  Control,
  ControlRef,
  Observation,
  Resolution,
  ScreenshotOptions,
  SurfaceDriver,
  SurfaceKind,
} from '../src/surface/types.js';
import { resolveFromControls } from '../src/surface/match.js';

export interface FakeControl {
  role: Control['role'];
  name: string;
  /** Defaults to 'text'. Set 'column-header' to model a data-grid cell. */
  nameSource?: Control['nameSource'];
  value?: string;
  section?: string;
  rowText?: string;
  frame?: string;
}

export interface FakeScreen {
  url: string;
  title?: string;
  text?: string;
  alerts?: string[];
  controls: FakeControl[];
  /** Path reported for this screen's single frame. Defaults to the top document. */
  framePath?: Array<{ name?: string; index?: number }>;
}

/** key is `${screen}::${role}:${name}` or `${screen}::*` for any action. */
export type Transitions = Record<string, string>;

export class FakeDriver implements SurfaceDriver {
  readonly surface: SurfaceKind = 'web-legacy';
  current: string;
  readonly actions: string[] = [];
  observeCount = 0;

  constructor(
    private readonly screens: Record<string, FakeScreen>,
    private readonly transitions: Transitions,
    start: string,
  ) {
    this.current = start;
  }

  private screen(): FakeScreen {
    const s = this.screens[this.current];
    if (!s) throw new Error(`no fake screen named "${this.current}"`);
    return s;
  }

  async observe(): Promise<Observation> {
    this.observeCount += 1;
    const s = this.screen();
    const counts = new Map<string, number>();
    const controls: Control[] = s.controls.map((c, i) => {
      const key = `${c.role}::${c.name.toLowerCase().trim()}`;
      const ordinal = counts.get(key) ?? 0;
      counts.set(key, ordinal + 1);
      return {
        handle: `h${i}`,
        role: c.role,
        name: c.name,
        nameSource: c.nameSource ?? 'text',
        value: c.value,
        enabled: true,
        framePath: c.frame ? [{ name: c.frame }] : [],
        section: c.section,
        rowText: c.rowText,
        ordinal,
        hints: { selector: `#${c.role}-${i}`, tag: 'div' },
      };
    });
    const text = [s.text ?? '', ...s.controls.map((c) => `${c.name} ${c.value ?? ''}`)].join(' ');
    return {
      at: new Date().toISOString(),
      url: s.url,
      title: s.title ?? this.current,
      frames: [{ framePath: s.framePath ?? [], url: s.url, text, alerts: s.alerts ?? [] }],
      controls,
    };
  }

  async resolve(ref: ControlRef): Promise<Resolution> {
    const obs = await this.observe();
    return resolveFromControls(ref, obs.controls);
  }

  private advance(label: string): void {
    this.actions.push(`${this.current}::${label}`);
    const next = this.transitions[`${this.current}::${label}`] ?? this.transitions[`${this.current}::*`];
    if (next) this.current = next;
  }

  async navigate(url: string): Promise<void> {
    const named = Object.entries(this.screens).find(([, s]) => s.url === url);
    this.actions.push(`navigate::${url}`);
    if (named) this.current = named[0];
    else this.advance(`navigate:${url}`);
  }

  async click(res: Resolution): Promise<void> {
    this.advance(`click:${res.control.role}:${res.control.name}`);
  }

  async fill(res: Resolution, value: string): Promise<void> {
    const s = this.screen();
    const target = s.controls.find((c) => c.name === res.control.name && c.role === res.control.role);
    if (target) target.value = value;
    this.advance(`fill:${res.control.name}`);
  }

  async select(res: Resolution, value: string): Promise<void> {
    await this.fill(res, value);
  }

  async press(key: string): Promise<void> {
    this.advance(`press:${key}`);
  }

  async readText(res: Resolution): Promise<string> {
    return res.control.value ?? res.control.name;
  }

  currentUrl(): string {
    return this.screen().url;
  }

  async screenshot(_opts?: ScreenshotOptions): Promise<Buffer> {
    return Buffer.from('fake-png');
  }

  async structureSnapshot(): Promise<string> {
    return `<fake screen="${this.current}">`;
  }

  async waitForQuiescence(): Promise<void> {}
  async close(): Promise<void> {}
}

export const textPresent = (text: string): Condition => ({ kind: 'textPresent', text });
