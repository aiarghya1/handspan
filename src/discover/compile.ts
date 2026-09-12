/**
 * Trace -> capability artifact.
 *
 * A pure function, which is the point: the artifact is derived from what was
 * done to the application, not from what the model said about it. Re-running
 * the compiler on a saved trace produces a byte-identical artifact, so the
 * recording step is auditable independently of the model.
 *
 * Three jobs matter here.
 *
 * **Parameterization.** A recording that hard-codes today's member number is
 * worthless. Values the goal supplied become `{{templates}}`, credentials become
 * vault references - and, less obviously, so do the *conditions*: the model's
 * stated expectation "MEMBER DETAIL - 12345" would pin the checkpoint to one
 * member, so any parameter value appearing in a checkpoint or in a ref's scope
 * is generalized before it is written down.
 *
 * **Runtime conditions.** The happy path met almost none of them, so business
 * outcomes and recoveries are merged in from the app profile: facts about the
 * application rather than about this flow.
 *
 * **Risk.** The tier is derived from the steps rather than asserted, and an
 * irreversible step sets `requiresApproval` on the way out. A flow that had to
 * ask a human for permission to finish cannot silently become unattended.
 */

import type { ControlRef } from '../surface/types.js';
import type { AppProfile } from '../artifact/app-profile.js';
import {
  API_VERSION,
  zCapability,
  zOutcome,
  zStep,
  type Capability,
  type Outcome,
  type Recovery,
  type Risk,
  type Step,
} from '../artifact/schema.js';
import { maxRisk } from '../artifact/store.js';
import type { GoalSpec } from './goal.js';
import type { DiscoveryTrace, TraceEntry } from './trace.js';

export interface CompileOptions {
  trace: DiscoveryTrace;
  goal: GoalSpec;
  app: AppProfile;
  baseUrl: string;
  version?: string;
}

/** Longest first, so a value that contains another is generalized correctly. */
function paramValuePairs(goal: GoalSpec): Array<[name: string, value: string]> {
  return Object.entries(goal.params)
    .map(([name, p]) => [name, p.value] as [string, string])
    .filter(([, v]) => v.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Generalize a phrase the model chose as a success condition.
 *
 * "MEMBER DETAIL - 12345" becomes /MEMBER DETAIL - \S+/, so the checkpoint
 * still identifies the screen but holds for any member. Returning a regex
 * rather than truncating keeps the shape of the phrase, which is what makes it
 * a useful assertion instead of a prefix match on two words.
 */
export function generalizeText(
  text: string,
  params: Array<[string, string]>,
): { text: string; regex: boolean } {
  let touched = false;
  let out = escapeRegex(text);
  for (const [, value] of params) {
    const needle = escapeRegex(value);
    if (out.includes(needle)) {
      out = out.split(needle).join('\\S+');
      touched = true;
    }
  }
  return touched ? { text: out, regex: true } : { text, regex: false };
}

/**
 * Remove parameter values from a ref's scope.
 *
 * `deriveRef` scopes by the section heading it saw, and on a detail screen that
 * heading contains the member number. Keeping the prefix works because section
 * matching is intentionally loose: "MEMBER DETAIL" still matches the live
 * "MEMBER DETAIL - 23456".
 */
export function scrubRef(ref: ControlRef, params: Array<[string, string]>): ControlRef {
  const cut = (s: string | undefined): string | undefined => {
    if (!s) return s;
    let out = s;
    for (const [, value] of params) {
      const i = out.indexOf(value);
      if (i >= 0) out = out.slice(0, i).replace(/[\s\-–:|,.]+$/, '');
    }
    const trimmed = out.trim();
    return trimmed.length >= 3 ? trimmed : undefined;
  };

  const scope = ref.scope
    ? {
        frame: ref.scope.frame,
        section: cut(ref.scope.section),
        rowContaining: cut(ref.scope.rowContaining),
      }
    : undefined;

  const name = ref.name && params.some(([, v]) => ref.name!.includes(v)) ? cut(ref.name) : ref.name;

  return {
    ...ref,
    name,
    scope: scope && (scope.frame || scope.section || scope.rowContaining) ? scope : undefined,
  };
}

function templateValue(entry: TraceEntry): string | undefined {
  if (entry.secretKey) return `{{secret:${entry.secretKey}}}`;
  if (entry.parameter) return `{{${entry.parameter}}}`;
  return entry.value;
}

export function compileCapability(opts: CompileOptions): Capability {
  const { trace, goal, app } = opts;
  const params = paramValuePairs(goal);
  const origin = new URL(opts.baseUrl).origin;

  const steps: Step[] = [];
  const scrub = (r: ControlRef | undefined) => (r ? scrubRef(r, params) : undefined);

  // The entry step, so replay starts exactly where discovery did. Its
  // checkpoint is the first control the agent actually touched, which is a
  // stronger signal that the app loaded than any URL comparison in a frameset.
  const firstTargeted = trace.entries.find((e) => e.ref);
  steps.push(
    zStep.parse({
      id: 's000',
      intent: `open ${app.title}`,
      action: 'navigate',
      phase: 'navigate',
      risk: 'read_only',
      url: `{{baseUrl}}${goal.entryPath}`,
      checkpoint: firstTargeted?.ref
        ? { kind: 'controlPresent', ref: scrub(firstTargeted.ref) }
        : { kind: 'urlMatches', pattern: escapeRegex(goal.entryPath) },
      timeoutMs: 20_000,
    }) as Step,
  );

  for (const e of trace.entries) {
    const ref = scrub(e.ref);
    let checkpoint: Record<string, unknown> | undefined = e.expect
      ? (() => {
          const g = generalizeText(e.expect!, params);
          return { kind: 'textPresent' as const, text: g.text, regex: g.regex };
        })()
      : undefined;

    // A fill has no screen transition to assert, so the model never gives it an
    // expectation - but an unverified fill is how a flow silently proceeds with
    // an empty field. The parameter's own declared pattern is exactly the right
    // assertion: it proves the value landed without writing the value down.
    if (!checkpoint && (e.action === 'fill' || e.action === 'select') && e.parameter && ref) {
      const pattern = goal.params[e.parameter]?.pattern;
      checkpoint = { kind: 'valueMatches', ref, pattern: pattern ?? '\\S' };
    }

    const step: Record<string, unknown> = {
      id: `s${String(e.seq + 1).padStart(3, '0')}`,
      intent: e.intent,
      action: e.action,
      phase: e.phase,
      risk: e.risk,
      ref,
      value: templateValue(e),
      key: e.key,
      checkpoint,
      recordedTier: e.resolvedTier,
      timeoutMs: 15_000,
      // A step a human had to perform during discovery is exactly the step most
      // likely to need one again, so it escalates rather than failing.
      onCheckpointFail: e.humanAssisted ? 'escalate' : 'fail',
    };

    // Discovery meets the interstitials too, and records dismissing one as an
    // ordinary step. On replay the recovery handles it first, so the recorded
    // step would then fail looking for a dialog that is already gone. Making
    // such a step conditional on the recovery's own trigger keeps both paths
    // correct whichever fires: "if the notice is up, dismiss it; otherwise skip".
    const shadows = recoveryShadowing(app, ref, e.triggeredRecoveries ?? []);
    if (shadows) {
      step['optional'] = true;
      step['waitFor'] = shadows.when;
      step['intent'] = `${e.intent} (only if present; also handled by recovery "${shadows.id}")`;
    }

    if (e.action === 'extract' && e.extract) {
      step['extract'] = {
        as: e.extract.as,
        source:
          e.extract.source.kind === 'control'
            ? { kind: 'control', ref: scrub(e.extract.source.ref) }
            : { kind: 'text', pattern: e.extract.source.pattern },
        transform: transformFor(goal.returns[e.extract.as]?.type),
      };
      step['ref'] = undefined;
    }

    steps.push(zStep.parse(step) as Step);
  }

  // The overall success condition, asserted last. Separate from the per-step
  // checkpoints on purpose: a reviewer should be able to see, in one place,
  // what "this capability worked" means.
  if (trace.successText) {
    const g = generalizeText(trace.successText, params);
    steps.push(
      zStep.parse({
        id: 's999',
        intent: 'confirm the goal is complete',
        action: 'assert',
        phase: 'read',
        risk: 'read_only',
        checkpoint: { kind: 'textPresent', text: g.text, regex: g.regex },
        timeoutMs: 10_000,
      }) as Step,
    );
  }

  const modelOutcomes: Outcome[] = trace.declaredOutcomes.map(
    (o) =>
      zOutcome.parse({
        id: o.id,
        description: o.description,
        detect: (() => {
          const g = generalizeText(o.whenText, params);
          return { kind: 'textPresent', text: g.text, regex: g.regex };
        })(),
        disposition: o.disposition,
      }) as Outcome,
  );

  // App-level conditions win on id collision: they were written deliberately by
  // a person who has seen the application fail, not inferred from one run.
  const byId = new Map<string, Outcome>();
  for (const o of modelOutcomes) byId.set(o.id, o);
  for (const o of app.outcomes) byId.set(o.id, o);
  const outcomes = [...byId.values()];

  const recoveries: Recovery[] = [...app.recoveries];

  const riskTier: Risk = steps.reduce<Risk>((acc, s) => maxRisk(acc, s.risk), 'read_only');
  const usedSecrets = [...new Set(trace.entries.map((e) => e.secretKey).filter((k): k is string => Boolean(k)))];

  const paramSpecs = Object.fromEntries(
    Object.entries(goal.params).map(([name, p]) => {
      const { value: _value, ...spec } = p;
      return [name, spec];
    }),
  );

  // Seed overrides for the other tenants the app profile knows about, so a
  // capability recorded once is at least addressable for the rest of the estate.
  const tenantOverrides = Object.entries(app.tenants)
    .filter(([t]) => t !== goal.tenant)
    .map(([tenant, cfg]) => ({
      tenant,
      appVersion: cfg.appVersion,
      note: cfg.note ?? 'seeded from the app profile; not yet qualified against this tenant',
      entryUrlTemplate: `${cfg.baseUrl}${goal.entryPath}`,
      nameAliases: cfg.nameAliases,
      allowedOrigins: [new URL(cfg.baseUrl).origin],
    }));

  const capability = zCapability.parse({
    apiVersion: API_VERSION,
    id: goal.id,
    version: opts.version ?? '1.0.0',
    title: goal.title,
    summary: goal.summary,
    surface: app.surface,
    app: {
      id: app.id,
      vendor: app.vendor,
      vendorVersion: app.vendorVersion,
      recordedForTenant: goal.tenant,
    },
    entryUrlTemplate: `{{baseUrl}}${goal.entryPath}`,
    params: paramSpecs,
    returns: goal.returns,
    secrets: usedSecrets,
    steps,
    outcomes,
    recoveries,
    policy: {
      riskTier,
      allowedOrigins: [origin],
      allowedPathPrefixes: app.policy.allowedPathPrefixes,
      allowedActions: app.policy.allowedActions ?? [...new Set(steps.map((s) => s.action))],
      // A flow containing an irreversible step is never unattended by default.
      requiresApproval: riskTier === 'irreversible',
    },
    provenance: {
      discoveredBy: {
        model: trace.model,
        runId: trace.runId,
        at: trace.startedAt,
        goal: trace.goal,
        blockedActions: trace.blockedActions,
        humanAssisted: trace.humanAssisted,
      },
      approval: { state: 'draft' },
      stability: { runs: 0, successes: 0, degradedSteps: [] },
    },
    tenantOverrides,
  });

  return capability;
}

/**
 * Is this step the agent doing a recovery's job?
 *
 * Two conditions, and both are needed. The action has to target the same
 * control the recovery targets, *and* the recovery's trigger has to have been
 * true on screen when the agent acted. Reference matching alone is not enough:
 * the maintenance notice is dismissed with a button named "Continue", and so is
 * the sub-account form. Marking the latter conditional on a dialog that is
 * never present would silently skip the step that reaches the confirmation
 * screen - which is exactly the bug this check was written to fix.
 */
function recoveryShadowing(
  app: AppProfile,
  ref: ControlRef | undefined,
  triggered: string[],
): Recovery | undefined {
  if (!ref?.name || triggered.length === 0) return undefined;
  const norm = (v: string | undefined) => (v ?? '').toLowerCase().trim();
  const sameControl = (a: ControlRef | undefined): boolean =>
    Boolean(a) && a!.role === ref.role && norm(a!.name) === norm(ref.name);

  return app.recoveries.find(
    (rec) => triggered.includes(rec.id) && rec.do.some((a) => (a.kind === 'click' || a.kind === 'fill') && sameControl(a.ref)),
  );
}

function transformFor(type: string | undefined): 'trim' | 'money' | 'integer' | 'number' | 'upper' {
  switch (type) {
    case 'money':
      return 'money';
    case 'integer':
      return 'integer';
    case 'number':
      return 'number';
    default:
      return 'trim';
  }
}
