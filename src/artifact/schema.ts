/**
 * The capability artifact.
 *
 * This is the contract between three different readers, and the shape is a
 * compromise between what each of them needs:
 *
 *   - a **calling agent**, which needs a tool description, a typed input
 *     signature, a typed output signature, and an enumerated set of outcomes
 *     it might get back. It must never have to read the steps.
 *   - a **replay engine**, which needs an ordered step list where every target
 *     is expressed durably and every step carries its own success condition.
 *   - a **human reviewer**, who has to be able to approve this thing for
 *     unattended execution against a production core banking system, which
 *     means reading it must be plausible in a few minutes.
 *
 * Consequences worth naming:
 *
 * 1. Steps and the public contract are separated. `params`/`returns`/`outcomes`
 *    are the capability's interface; `steps` are its implementation. An agent
 *    binds to the former.
 * 2. Every step carries its own `checkpoint`. The artifact is not "a list of
 *    clicks" but "a list of clicks and what each one should have achieved",
 *    which is what lets replay fail loudly at the right step instead of drifting
 *    silently to the wrong screen.
 * 3. Business outcomes are declared data, not exceptions. "No such member" is a
 *    named result with its own detector, so the engine returns it rather than
 *    throwing, and the calling agent can branch on it.
 * 4. Nothing in here holds a value. Inputs are templates (`{{memberId}}`),
 *    credentials are vault references (`{{secret:meridian.password}}`). An
 *    artifact is safe to commit to a repository and show to a reviewer.
 * 5. Tenant variation is expressed as overrides on one shared artifact rather
 *    than as N copies, because hundreds of institutions run the same vendor
 *    product with different labels.
 */

import { z } from 'zod';
import { CONTROL_ROLES, LOCATOR_TIERS, type ControlRef } from '../surface/types.js';

export const API_VERSION = 'handspan.dev/capability/v1';

// -- targeting --------------------------------------------------------------

export const zFrameSelector = z
  .object({ name: z.string().optional(), index: z.number().int().nonnegative().optional() })
  .strict();

export const zControlRef = z
  .object({
    role: z.enum(CONTROL_ROLES),
    name: z.string().optional(),
    /** Defaults to `normalized` at resolution time: case- and space-insensitive,
     *  trailing punctuation stripped. Legacy labels gain and lose colons. */
    nameMatch: z.enum(['exact', 'normalized', 'contains', 'regex']).optional(),
    scope: z
      .object({
        frame: zFrameSelector.optional(),
        section: z.string().optional(),
        rowContaining: z.string().optional(),
      })
      .strict()
      .optional(),
    ordinal: z.number().int().nonnegative().optional(),
    hints: z
      .object({
        selector: z.string().optional(),
        tag: z.string().optional(),
        attrs: z.record(z.string()).optional(),
        nearText: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Keeps the schema and the surface seam from drifting apart: if a field is
 * added to ControlRef without adding it here (or vice versa), this stops
 * compiling.
 */
type MutuallyAssignable<A, B> = A extends B ? (B extends A ? true : never) : never;
const _controlRefMatchesSeam: MutuallyAssignable<z.output<typeof zControlRef>, ControlRef> = true;
void _controlRefMatchesSeam;

// -- conditions -------------------------------------------------------------

export type ConditionInput = z.input<typeof zCondition>;

export const zCondition: z.ZodType<import('../surface/types.js').Condition> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal('urlMatches'), pattern: z.string() }).strict(),
    z
      .object({
        kind: z.literal('textPresent'),
        text: z.string(),
        regex: z.boolean().optional(),
        frame: zFrameSelector.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('textAbsent'),
        text: z.string(),
        regex: z.boolean().optional(),
        frame: zFrameSelector.optional(),
      })
      .strict(),
    z.object({ kind: z.literal('controlPresent'), ref: zControlRef }).strict(),
    z.object({ kind: z.literal('controlAbsent'), ref: zControlRef }).strict(),
    z.object({ kind: z.literal('valueMatches'), ref: zControlRef, pattern: z.string() }).strict(),
    z.object({ kind: z.literal('allOf'), of: z.array(zCondition).min(1) }).strict(),
    z.object({ kind: z.literal('anyOf'), of: z.array(zCondition).min(1) }).strict(),
    z.object({ kind: z.literal('not'), of: zCondition }).strict(),
  ]),
);

// -- typed interface --------------------------------------------------------

/**
 * Data sensitivity drives redaction, not just documentation. A value tagged
 * `pii` or `secret` is never written to a log or an artifact; a `secret` is
 * never even held in the run record.
 */
export const zSensitivity = z.enum(['none', 'pii', 'pii-id', 'account', 'secret']);

export const zValueType = z.enum(['string', 'number', 'integer', 'boolean', 'money', 'date']);

export const zParamSpec = z
  .object({
    type: zValueType,
    description: z.string().min(1),
    required: z.boolean().default(true),
    /** Validated before the browser is ever opened. */
    pattern: z.string().optional(),
    enum: z.array(z.string()).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    sensitivity: zSensitivity.default('none'),
    /** Illustrative only. Must never be a real value; the linter enforces it. */
    example: z.string().optional(),
  })
  .strict();

export const zReturnSpec = z
  .object({
    type: zValueType,
    description: z.string().min(1),
    sensitivity: zSensitivity.default('none'),
    /** False when the value may legitimately be absent on the success path. */
    required: z.boolean().default(true),
  })
  .strict();

// -- steps ------------------------------------------------------------------

export const zStepAction = z.enum([
  'navigate',
  'click',
  'fill',
  'select',
  'press',
  'extract',
  'assert',
  'wait',
]);

/**
 * Risk is per step, not per capability, because a flow is usually a long
 * read-only prefix followed by one irreversible commit. Gating the whole
 * capability on its worst step would make every read require approval.
 */
export const zRisk = z.enum(['read_only', 'reversible_write', 'irreversible']);

/**
 * Phases exist so a recovery can say "get me back to where I was".
 *
 * Session expiry is the most common runtime condition in these systems, and
 * recovering from it is not "sign on again" - it is "sign on again, re-navigate
 * to the screen, re-enter what I had typed, and then retry what failed". A
 * phase label on each step is what lets `replayFrom` express that in one line
 * instead of duplicating the prefix of the flow inside the recovery.
 */
export const zPhase = z.enum(['signon', 'navigate', 'input', 'commit', 'read']);

export const zExtractSource = z.union([
  z.object({ kind: z.literal('control'), ref: zControlRef }).strict(),
  z
    .object({
      kind: z.literal('text'),
      frame: zFrameSelector.optional(),
      /** Regex with one capture group, applied to the frame's visible text. */
      pattern: z.string(),
    })
    .strict(),
]);

export const zExtract = z
  .object({
    as: z.string().min(1),
    source: zExtractSource,
    /** Optional narrowing regex with one capture group, applied to the value. */
    pattern: z.string().optional(),
    transform: z.enum(['trim', 'money', 'integer', 'number', 'upper']).default('trim'),
  })
  .strict();

export const zStep = z
  .object({
    id: z.string().min(1),
    /** Plain-language intent, written during discovery. The reviewer reads this. */
    intent: z.string().min(1),
    action: zStepAction,
    phase: zPhase.default('input'),
    risk: zRisk.default('read_only'),

    ref: zControlRef.optional(),
    /** Templated: "{{memberId}}", "{{secret:meridian.password}}", literals. */
    value: z.string().optional(),
    /** For `navigate`. Templated the same way. */
    url: z.string().optional(),
    /** For `press`. */
    key: z.string().optional(),
    extract: zExtract.optional(),

    /** Polled before acting. A step whose precondition never holds is skipped
     *  when `optional`, and fails otherwise. */
    waitFor: zCondition.optional(),
    /** Polled after acting. The step is not done until this holds. */
    checkpoint: zCondition.optional(),

    timeoutMs: z.number().int().positive().default(15_000),
    optional: z.boolean().default(false),
    onCheckpointFail: z.enum(['fail', 'escalate', 'retry_step']).default('fail'),

    /** Tier this step's ref resolved at during discovery: the drift baseline. */
    recordedTier: z.enum(LOCATOR_TIERS).optional(),
  })
  .strict();

// -- outcomes and recoveries ------------------------------------------------

/**
 * A named, expected end state that is not success. Conflating these with
 * failures is the mistake this field exists to prevent: "no such member" is an
 * answer the calling agent needs, not a crash.
 */
export const zOutcome = z
  .object({
    id: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, 'outcome ids are SCREAMING_SNAKE so callers can switch on them'),
    description: z.string().min(1),
    detect: zCondition,
    /** `return` hands it to the caller; `escalate` routes it to a human first. */
    disposition: z.enum(['return', 'escalate']).default('return'),
    /** Steps after which this is checked. Empty means "after every step". */
    checkAfter: z.array(z.string()).default([]),
    /** Values to pull out of the outcome screen (a reason code, a reference). */
    extract: z.array(zExtract).default([]),
  })
  .strict();

export const zRecoveryAction = z.union([
  z.object({ kind: z.literal('click'), ref: zControlRef }).strict(),
  z.object({ kind: z.literal('fill'), ref: zControlRef, value: z.string() }).strict(),
  z.object({ kind: z.literal('navigate'), url: z.string() }).strict(),
  z.object({ kind: z.literal('wait'), ms: z.number().int().positive().max(30_000) }).strict(),
  /**
   * Re-run every step from the first step of `phase` up to (not including) the
   * step that triggered this recovery, then retry that step. This is how
   * session expiry is handled: `replayFrom: signon` rebuilds the whole prefix.
   */
  z.object({ kind: z.literal('replayFrom'), phase: zPhase }).strict(),
]);

/**
 * A known, transient condition and the bounded response to it. Recoveries are
 * the only place replay is allowed to do something the step list did not ask
 * for, and each one is capped per run so a loop cannot form.
 */
export const zRecovery = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    when: zCondition,
    do: z.array(zRecoveryAction).min(1),
    maxPerRun: z.number().int().positive().max(5).default(2),
    /** After recovering, retry the step that was interrupted. */
    retryStep: z.boolean().default(true),
  })
  .strict();

// -- policy, provenance, tenancy -------------------------------------------

export const zPolicy = z
  .object({
    /** Worst risk any step in this capability carries. Derived, then checked. */
    riskTier: zRisk,
    /** Origins this capability is permitted to touch. Enforced per navigation. */
    allowedOrigins: z.array(z.string()).min(1),
    /** Path prefixes within those origins. Empty means "any path". */
    allowedPathPrefixes: z.array(z.string()).default([]),
    allowedActions: z.array(zStepAction).default([
      'navigate',
      'click',
      'fill',
      'select',
      'press',
      'extract',
      'assert',
      'wait',
    ]),
    /** Unattended replay is refused unless an approver has signed off. */
    requiresApproval: z.boolean().default(false),
  })
  .strict();

export const zProvenance = z
  .object({
    discoveredBy: z
      .object({
        model: z.string(),
        runId: z.string(),
        at: z.string(),
        goal: z.string(),
        /** Steps the model proposed that policy refused, kept for review. */
        blockedActions: z.number().int().nonnegative().default(0),
        /** True when a human took over at any point during discovery. */
        humanAssisted: z.boolean().default(false),
      })
      .strict(),
    approval: z
      .object({
        state: z.enum(['draft', 'approved', 'revoked']).default('draft'),
        by: z.string().optional(),
        at: z.string().optional(),
        note: z.string().optional(),
        /**
         * The contentHash that was approved. Approval is therefore tied to the
         * exact behaviour a reviewer read: editing any step changes the hash,
         * the approval no longer matches, and unattended replay is refused
         * until someone signs off again.
         */
        contentHash: z.string().optional(),
      })
      .strict()
      .default({ state: 'draft' }),
    /** Replay history. Cheap confidence signal, and the drift alarm. */
    stability: z
      .object({
        runs: z.number().int().nonnegative().default(0),
        successes: z.number().int().nonnegative().default(0),
        lastRunAt: z.string().optional(),
        /** Steps that last resolved below their recorded tier. */
        degradedSteps: z.array(z.string()).default([]),
      })
      .strict()
      .default({ runs: 0, successes: 0, degradedSteps: [] }),
  })
  .strict();

/**
 * Per-tenant specialization of one shared capability.
 *
 * The common case at scale is not "this tenant's app is different" but "this
 * tenant's app calls the same button something else". `nameAliases` handles
 * that class in one line for the whole flow; `refPatches` is the escape hatch
 * for a control that genuinely moved.
 */
export const zTenantOverride = z
  .object({
    tenant: z.string().min(1),
    appVersion: z.string().optional(),
    note: z.string().optional(),
    entryUrlTemplate: z.string().optional(),
    /** canonical control name -> the name this tenant's build uses */
    nameAliases: z.record(z.string()).default({}),
    refPatches: z.array(z.object({ stepId: z.string(), ref: zControlRef.partial() }).strict()).default([]),
    disabledSteps: z.array(z.string()).default([]),
    extraRecoveries: z.array(zRecovery).default([]),
    allowedOrigins: z.array(z.string()).optional(),
  })
  .strict();

// -- the artifact -----------------------------------------------------------

export const zCapability = z
  .object({
    apiVersion: z.literal(API_VERSION),
    /** Stable identity across versions. Callers invoke by this. */
    id: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/, 'id looks like app.domain.verb'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    title: z.string().min(1),
    /** The description a calling agent sees in the capability catalog. */
    summary: z.string().min(1),

    surface: z.enum(['web', 'web-legacy', 'desktop']),
    app: z
      .object({
        id: z.string().min(1),
        vendor: z.string().optional(),
        vendorVersion: z.string().optional(),
        /** The tenant this was recorded against. Overrides cover the others. */
        recordedForTenant: z.string().optional(),
      })
      .strict(),
    entryUrlTemplate: z.string().min(1),

    params: z.record(zParamSpec).default({}),
    returns: z.record(zReturnSpec).default({}),
    /** Vault keys this capability needs. Never values. */
    secrets: z.array(z.string()).default([]),

    steps: z.array(zStep).min(1),
    outcomes: z.array(zOutcome).default([]),
    recoveries: z.array(zRecovery).default([]),

    policy: zPolicy,
    provenance: zProvenance,
    tenantOverrides: z.array(zTenantOverride).default([]),

    /** sha256 of the canonicalized artifact minus provenance.stability. */
    contentHash: z.string().optional(),
  })
  .strict();

export type Capability = z.output<typeof zCapability>;
export type CapabilityInput = z.input<typeof zCapability>;
export type Step = z.output<typeof zStep>;
export type Outcome = z.output<typeof zOutcome>;
export type Recovery = z.output<typeof zRecovery>;
export type RecoveryAction = z.output<typeof zRecoveryAction>;
export type ParamSpec = z.output<typeof zParamSpec>;
export type ReturnSpec = z.output<typeof zReturnSpec>;
export type TenantOverride = z.output<typeof zTenantOverride>;
export type Extract = z.output<typeof zExtract>;
export type Risk = z.output<typeof zRisk>;
export type Phase = z.output<typeof zPhase>;
export type StepActionKind = z.output<typeof zStepAction>;
