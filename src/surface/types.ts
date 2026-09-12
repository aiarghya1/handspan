/**
 * The surface seam.
 *
 * Everything above this file (the discovery agent, the replay engine, the
 * artifact schema) is written against these types only. Nothing above it knows
 * what a CSS selector, a frame, a window handle or a UI Automation element is.
 *
 * A surface adapter owes the layers above three things:
 *   observe()  - turn whatever it can see into a flat list of named Controls
 *   resolve()  - turn a durable ControlRef back into a live control, and say
 *                how confidently it did so (the LocatorTier)
 *   act        - click / fill / select / press / navigate / read
 *
 * The durable half of that contract is `ControlRef`: role + accessible name +
 * scope. Those three signals exist on every surface we care about - a web DOM,
 * a frameset from 2003, and a Win32/WPF window read through UI Automation - and
 * they are what actually survives a vendor point release. Surface-specific
 * detail (CSS, XPath, automation ids) is allowed, but only as `hints`, below
 * the semantic tiers in the resolution ladder.
 */

export type SurfaceKind = 'web' | 'web-legacy' | 'desktop';

/**
 * Closed role vocabulary. Deliberately small and drawn from the intersection of
 * ARIA roles and UI Automation ControlTypes, so a ref recorded on one surface
 * is at least *expressible* on another.
 */
export const CONTROL_ROLES = [
  'button',
  'link',
  'textbox',
  'password',
  'checkbox',
  'radio',
  'combobox',
  'option',
  'cell',
  'row',
  'heading',
  'banner',
  'alert',
  'dialog',
  'tab',
  'image',
  'text',
] as const;
export type ControlRole = (typeof CONTROL_ROLES)[number];

/** How a frame/window was picked out. Empty path = the top document. */
export interface FrameSelector {
  name?: string;
  /** Index among sibling frames, used only when there is no name. */
  index?: number;
}
export type FramePath = FrameSelector[];

export type NameSource =
  | 'aria-label'
  | 'aria-labelledby'
  | 'label-for'
  | 'label-wrap'
  | 'adjacent-cell'
  | 'column-header'
  | 'preceding-text'
  | 'value'
  | 'placeholder'
  | 'title'
  | 'alt'
  | 'text'
  | 'none';

/** A control as perceived right now. `handle` is valid only for this observation. */
export interface Control {
  handle: string;
  role: ControlRole;
  name: string;
  nameSource: NameSource;
  value?: string;
  enabled: boolean;
  framePath: FramePath;
  /** Nearest preceding heading/banner text: the "screen" the control sits on. */
  section?: string;
  /** First cell of the containing table row, for grids with no other identity. */
  rowKey?: string;
  /** Whole-row text. Lets a ref say "the Balance cell in the row containing X". */
  rowText?: string;
  /** Index among controls with the same role+name in the same frame. */
  ordinal: number;
  bbox?: { x: number; y: number; width: number; height: number };
  /** Surface-specific fallbacks. Never the primary way to find anything. */
  hints: {
    selector?: string;
    tag?: string;
    attrs?: Record<string, string>;
    nearText?: string;
  };
  /** True when the control's own value should never be logged or persisted. */
  sensitive?: boolean;
}

/** The durable, serialized way an artifact names a control. */
export interface ControlRef {
  role: ControlRole;
  name?: string;
  nameMatch?: 'exact' | 'normalized' | 'contains' | 'regex';
  scope?: {
    frame?: FrameSelector;
    section?: string;
    rowContaining?: string;
  };
  /** Disambiguates when role+name+scope still matches more than one control. */
  ordinal?: number;
  hints?: Control['hints'];
}

/**
 * Resolution ladder, best first. Recorded on every resolve so replay can report
 * *how* it found each control, not just that it did. A resolve that lands below
 * the tier the artifact was recorded at is the drift signal.
 */
export const LOCATOR_TIERS = [
  'role+name+scope', // 1 semantic, fully scoped - what we want every time
  'role+name+frame', // 2 semantic, scope drifted (section renamed, row moved)
  'role+name', // 3 semantic, frame drifted
  'role+nearText', // 4 label association, name synthesis changed
  'hint-selector', // 5 surface-specific escape hatch
  'role+ordinal', // 6 positional; correct only if nothing was inserted
] as const;
export type LocatorTier = (typeof LOCATOR_TIERS)[number];

export function tierRank(t: LocatorTier): number {
  return LOCATOR_TIERS.indexOf(t) + 1;
}

export interface Resolution {
  ref: ControlRef;
  control: Control;
  tier: LocatorTier;
  /** Candidates the winning tier matched. >1 means the ref is under-specified. */
  candidateCount: number;
}

export class ControlNotFoundError extends Error {
  constructor(
    readonly ref: ControlRef,
    readonly triedTiers: LocatorTier[],
  ) {
    super(`no control matched ${describeRef(ref)} (tried ${triedTiers.length} tiers)`);
    this.name = 'ControlNotFoundError';
  }
}

export class AmbiguousControlError extends Error {
  constructor(
    readonly ref: ControlRef,
    readonly tier: LocatorTier,
    readonly count: number,
  ) {
    super(`${describeRef(ref)} matched ${count} controls at tier ${tier} with no ordinal to disambiguate`);
    this.name = 'AmbiguousControlError';
  }
}

export function describeRef(ref: ControlRef): string {
  const parts: string[] = [ref.role];
  if (ref.name) parts.push(`"${ref.name}"`);
  if (ref.scope?.frame?.name) parts.push(`in frame ${ref.scope.frame.name}`);
  if (ref.scope?.section) parts.push(`under "${ref.scope.section}"`);
  if (ref.scope?.rowContaining) parts.push(`in row containing "${ref.scope.rowContaining}"`);
  if (ref.ordinal !== undefined) parts.push(`#${ref.ordinal}`);
  return parts.join(' ');
}

/** A frame's worth of visible text, kept for condition matching. */
export interface FrameView {
  framePath: FramePath;
  url: string;
  /** Normalized visible text, whitespace-collapsed and length-capped. */
  text: string;
  /** Banner/alert-shaped blocks, pulled out because conditions key off them. */
  alerts: string[];
}

export interface Observation {
  at: string;
  /** Top-level document URL. */
  url: string;
  title: string;
  frames: FrameView[];
  controls: Control[];
  /** Present when the adapter captured one for this observation. */
  screenshotPath?: string;
}

/**
 * Serializable predicate. One evaluator covers step checkpoints, business
 * outcome detection and recovery triggers, so there is exactly one place where
 * "what does the screen say" is decided.
 */
export type Condition =
  | { kind: 'urlMatches'; pattern: string }
  | { kind: 'textPresent'; text: string; regex?: boolean; frame?: FrameSelector }
  | { kind: 'textAbsent'; text: string; regex?: boolean; frame?: FrameSelector }
  | { kind: 'controlPresent'; ref: ControlRef }
  | { kind: 'controlAbsent'; ref: ControlRef }
  | { kind: 'valueMatches'; ref: ControlRef; pattern: string }
  | { kind: 'allOf'; of: Condition[] }
  | { kind: 'anyOf'; of: Condition[] }
  | { kind: 'not'; of: Condition };

export interface ScreenshotOptions {
  /** Paint over controls the policy marked sensitive before encoding. */
  maskSensitive?: boolean;
  fullPage?: boolean;
}

/**
 * What every surface adapter implements. A desktop adapter would back
 * `observe` with UI Automation / AX APIs and `resolve` with the same ladder
 * over ControlType + Name + ancestor window; nothing above this interface
 * changes.
 */
export interface SurfaceDriver {
  readonly surface: SurfaceKind;

  observe(opts?: { screenshot?: boolean }): Promise<Observation>;
  resolve(ref: ControlRef): Promise<Resolution>;

  navigate(url: string): Promise<void>;
  click(res: Resolution): Promise<void>;
  fill(res: Resolution, value: string): Promise<void>;
  select(res: Resolution, value: string): Promise<void>;
  press(key: string, res?: Resolution): Promise<void>;
  readText(res: Resolution): Promise<string>;

  currentUrl(): string;
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;
  /** Richer failure signal. HTML per frame on web; control-tree dump on desktop. */
  structureSnapshot(): Promise<string>;

  /** Idle heuristic the adapter knows how to compute for its own surface. */
  waitForQuiescence(timeoutMs: number): Promise<void>;

  close(): Promise<void>;
}
