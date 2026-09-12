/**
 * The guardrail.
 *
 * Every action reaches the surface driver through `authorize`, whether it was
 * chosen by the model during discovery, read out of an artifact during replay,
 * or performed by a human operator who has taken control. One gate, three
 * actors. That is the single most useful property of this design: there is no
 * path to the application that skips the policy check, and the audit log has
 * one shape regardless of who acted.
 *
 * Three things it enforces.
 *
 * 1. **Where.** An origin and path allowlist, deny by default. Checked on
 *    navigation *and* after every action, because a click can navigate
 *    anywhere and the pre-check only sees intent.
 *
 * 2. **What.** Action kinds are allowlisted, and each action is classified into
 *    a risk tier. The classifier keys off the control's accessible name, which
 *    is the same signal a human operator uses: a button that says "Confirm and
 *    Post" is doing something a button that says "Retrieve" is not. It is a
 *    heuristic and it is tuned to over-classify - the cost of calling a read
 *    irreversible is a needless confirmation; the cost of the reverse is a
 *    posted transaction.
 *
 * 3. **Who.** An operator who has been handed control may do things the agent
 *    may not - that is why they were called in - but only inside the same
 *    origin allowlist. Authority differs; the boundary does not.
 */

import type { ControlRef } from '../surface/types.js';
import type { Risk, StepActionKind } from '../artifact/schema.js';

export type Actor = 'discovery-agent' | 'replay' | 'operator';

export interface ActionRequest {
  kind: StepActionKind;
  actor: Actor;
  url?: string;
  ref?: ControlRef;
  /** Present only so the classifier can see it; never retained. */
  valuePreview?: string;
}

export interface PolicyDecision {
  allow: boolean;
  risk: Risk;
  code?: PolicyViolationCode;
  reason?: string;
  /** True when the caller should route this to a human instead of performing it. */
  escalate?: boolean;
}

export type PolicyViolationCode =
  | 'origin-not-allowed'
  | 'path-not-allowed'
  | 'action-not-allowed'
  | 'irreversible-blocked'
  | 'malformed-url'
  | 'step-budget-exceeded'
  | 'time-budget-exceeded';

export class PolicyViolation extends Error {
  constructor(
    readonly code: PolicyViolationCode,
    message: string,
    readonly request?: ActionRequest,
  ) {
    super(message);
    this.name = 'PolicyViolation';
  }
}

export interface PolicyConfig {
  allowedOrigins: string[];
  /** Empty means any path within an allowed origin. */
  allowedPathPrefixes: string[];
  allowedActions: StepActionKind[];
  /** Control names matching these mean the click commits something. */
  irreversiblePatterns: string[];
  reversibleWritePatterns: string[];
  /**
   * What discovery does when the model wants to perform an irreversible action.
   * `escalate` is the default: a person decides, and the flow continues, which
   * is how the sub-account capability gets recorded at all.
   */
  onIrreversible: 'block' | 'escalate' | 'allow';
  /** Operators may commit; they were called in precisely to decide. */
  operatorMayCommit: boolean;
  maxSteps: number;
  maxDurationMs: number;
  /** Values matching these are masked in screenshots and never logged. */
  sensitivePatterns: string[];
}

export const DEFAULT_POLICY: PolicyConfig = {
  allowedOrigins: [],
  allowedPathPrefixes: [],
  allowedActions: ['navigate', 'click', 'fill', 'select', 'press', 'extract', 'assert', 'wait'],
  irreversiblePatterns: [
    'confirm(\\s|$)',
    '\\bpost\\b',
    '\\bsubmit\\b',
    '\\btransfer\\b',
    '\\bwire\\b',
    '\\bdisburse\\b',
    '\\bdelete\\b',
    '\\bremove\\b',
    '\\bclose\\s+account\\b',
    '\\bapprove\\b',
    '\\bvoid\\b',
    '\\brevers(e|al)\\b',
    '\\bcharge\\s?off\\b',
    '\\bwaive\\b',
  ],
  // "Continue" is deliberately not here: on these screens it is a navigation
  // verb far more often than a write, and treating every wizard step as one
  // inflates the risk tier of read-only lookups without gating anything more.
  reversibleWritePatterns: ['\\bsave\\b', '\\bupdate\\b', '\\bcreate\\b', '\\badd\\b', '\\bopen\\b', '\\bapply\\b'],
  onIrreversible: 'escalate',
  operatorMayCommit: true,
  maxSteps: 40,
  maxDurationMs: 5 * 60_000,
  sensitivePatterns: ['\\b\\d{3}-\\d{2}-\\d{4}\\b'],
};

function compile(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, 'i'));
}

export class PolicyEngine {
  private readonly irreversible: RegExp[];
  private readonly reversible: RegExp[];
  readonly sensitivePatterns: RegExp[];
  private steps = 0;
  private readonly startedAt = Date.now();

  constructor(readonly config: PolicyConfig) {
    this.irreversible = compile(config.irreversiblePatterns);
    this.reversible = compile(config.reversibleWritePatterns);
    this.sensitivePatterns = compile(config.sensitivePatterns);
  }

  static forCapability(base: PolicyConfig, cap: { policy: { allowedOrigins: string[]; allowedPathPrefixes: string[]; allowedActions: StepActionKind[] } }): PolicyEngine {
    // The artifact narrows the ambient policy; it can never widen it. An
    // artifact that names an origin the deployment does not permit simply has
    // no permitted origins left and fails closed.
    const narrow = <T>(ambient: T[], declared: T[]): T[] =>
      ambient.length === 0 ? declared : declared.filter((d) => ambient.includes(d));
    return new PolicyEngine({
      ...base,
      allowedOrigins: narrow(base.allowedOrigins, cap.policy.allowedOrigins),
      allowedPathPrefixes:
        base.allowedPathPrefixes.length === 0 ? cap.policy.allowedPathPrefixes : base.allowedPathPrefixes,
      allowedActions: narrow(base.allowedActions, cap.policy.allowedActions),
    });
  }

  // -- location ------------------------------------------------------------

  isLocationAllowed(url: string): { ok: true } | { ok: false; code: PolicyViolationCode; reason: string } {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, code: 'malformed-url', reason: `not a URL: ${url}` };
    }
    if (parsed.protocol === 'about:' || parsed.protocol === 'blank:') return { ok: true };
    if (!this.config.allowedOrigins.includes(parsed.origin)) {
      return { ok: false, code: 'origin-not-allowed', reason: `origin ${parsed.origin} is not allowlisted` };
    }
    const prefixes = this.config.allowedPathPrefixes;
    if (prefixes.length > 0 && !prefixes.some((p) => parsed.pathname.startsWith(p))) {
      return { ok: false, code: 'path-not-allowed', reason: `path ${parsed.pathname} is outside the allowed prefixes` };
    }
    return { ok: true };
  }

  /**
   * Called after every action. A click is an intent to move somewhere the
   * pre-check could not see, so the only honest allowlist check is the one that
   * looks at where the session actually ended up.
   */
  assertLocationAllowed(url: string): void {
    const v = this.isLocationAllowed(url);
    if (!v.ok) throw new PolicyViolation(v.code, `session left the allowlist: ${v.reason}`);
  }

  // -- risk ----------------------------------------------------------------

  classify(req: ActionRequest): Risk {
    if (req.kind === 'extract' || req.kind === 'assert' || req.kind === 'wait') return 'read_only';
    // Typing and selecting change nothing on the server. All of the risk in a
    // legacy flow sits in the control that submits the form.
    if (req.kind === 'fill' || req.kind === 'select') return 'read_only';
    if (req.kind === 'navigate') {
      const u = req.url ?? '';
      return this.irreversible.some((re) => re.test(u)) ? 'irreversible' : 'read_only';
    }
    const name = req.ref?.name ?? '';
    if (this.irreversible.some((re) => re.test(name))) return 'irreversible';
    if (this.reversible.some((re) => re.test(name))) return 'reversible_write';
    // A bare keystroke usually triggers the form's default submit, which has no
    // name to classify. Assume it writes something rather than that it is
    // harmless - but do not assume it commits, or every Enter needs a human.
    if (req.kind === 'press') return 'reversible_write';
    return 'read_only';
  }

  // -- the gate ------------------------------------------------------------

  authorize(req: ActionRequest): PolicyDecision {
    const risk = this.classify(req);

    if (this.steps >= this.config.maxSteps) {
      return { allow: false, risk, code: 'step-budget-exceeded', reason: `step budget of ${this.config.maxSteps} exhausted` };
    }
    if (Date.now() - this.startedAt > this.config.maxDurationMs) {
      return { allow: false, risk, code: 'time-budget-exceeded', reason: `time budget of ${this.config.maxDurationMs}ms exhausted` };
    }
    if (!this.config.allowedActions.includes(req.kind)) {
      return { allow: false, risk, code: 'action-not-allowed', reason: `action "${req.kind}" is not permitted` };
    }
    if (req.kind === 'navigate') {
      const v = this.isLocationAllowed(req.url ?? '');
      if (!v.ok) return { allow: false, risk, code: v.code, reason: v.reason };
    }

    if (risk === 'irreversible') {
      if (req.actor === 'operator') {
        if (!this.config.operatorMayCommit) {
          return { allow: false, risk, code: 'irreversible-blocked', reason: 'operators may not commit under this policy' };
        }
        return { allow: true, risk };
      }
      if (req.actor === 'replay') {
        // Replay's authority comes from the artifact's approval state, checked
        // by the engine before the run starts. By the time an action gets here
        // that decision has already been made.
        return { allow: true, risk };
      }
      switch (this.config.onIrreversible) {
        case 'allow':
          return { allow: true, risk };
        case 'block':
          return { allow: false, risk, code: 'irreversible-blocked', reason: `"${req.ref?.name ?? req.kind}" commits an irreversible change` };
        case 'escalate':
          return {
            allow: false,
            risk,
            escalate: true,
            code: 'irreversible-blocked',
            reason: `"${req.ref?.name ?? req.kind}" commits an irreversible change and needs a human decision`,
          };
      }
    }

    return { allow: true, risk };
  }

  /** Counted only for actions that were actually performed. */
  countStep(): void {
    this.steps += 1;
  }

  get stepsUsed(): number {
    return this.steps;
  }

  get budgetRemaining(): { steps: number; ms: number } {
    return {
      steps: Math.max(0, this.config.maxSteps - this.steps),
      ms: Math.max(0, this.config.maxDurationMs - (Date.now() - this.startedAt)),
    };
  }
}
