/**
 * Deterministic replay: the production execution path.
 *
 * No model is consulted. Every decision the engine makes is a lookup in the
 * artifact or an evaluation of a declared condition, which is what makes two
 * runs with the same inputs against the same screens do the same thing.
 *
 * The step loop is deliberately uniform, and the ordering inside it is the
 * interesting part:
 *
 *   1. observe
 *   2. apply any recovery whose trigger currently holds   <- interstitials
 *   3. wait for the step's precondition
 *   4. authorize, then act
 *   5. re-check the allowlist against where we actually ended up
 *   6. check for declared business outcomes                <- before checkpoints
 *   7. wait for the step's checkpoint
 *   8. extract
 *
 * Outcomes are checked before checkpoints on purpose. When a search returns
 * "no member found", the checkpoint for "the member detail screen is showing"
 * is also false - so whichever is checked first decides whether the caller is
 * told a fact about the member or a fact about the automation. Checking
 * outcomes first means the caller gets the fact about the member.
 */

import {
  AmbiguousControlError,
  ControlNotFoundError,
  tierRank,
  type Condition,
  type Observation,
  type SurfaceDriver,
} from '../surface/types.js';
import type { Capability, Outcome, Recovery, Step } from '../artifact/schema.js';
import { isApprovedForUnattended } from '../artifact/store.js';
import { lintCapability, lintErrors } from '../artifact/lint.js';
import { specializeForTenant } from '../artifact/tenant.js';
import { EnvSecretResolver, resolveTemplate, type SecretResolver } from '../artifact/template.js';
import { PolicyEngine, PolicyViolation, type ActionRequest, type PolicyConfig } from '../policy/policy.js';
import type { RunRecorder } from '../obs/recorder.js';
import { EscalationBroker, EscalationTimeout, type StuckReason } from '../escalation/broker.js';
import { describeCondition, evaluateCondition, waitForCondition } from './conditions.js';
import { applyTransform, checkOutputs, validateInputs, InputValidationError } from './values.js';
import type {
  FailureClass,
  RecoveryReport,
  ReplayResult,
  ReplayResultBase,
  StepReport,
} from './result.js';

export interface ReplayOptions {
  capability: Capability;
  inputs: Record<string, unknown>;
  driver: SurfaceDriver;
  recorder: RunRecorder;
  basePolicy: PolicyConfig;
  baseUrl: string;
  tenant?: string;
  secrets?: SecretResolver;
  broker?: EscalationBroker;
  /** Unattended runs refuse artifacts whose approval does not cover them. */
  attended?: boolean;
  /** Skip the strict tenant check when qualifying a new tenant's build. */
  lenientTenant?: boolean;
}

/**
 * How an escalation degrades when there is no human available. Each stuck
 * reason maps to the failure class that best tells a caller where to look.
 */
const NO_OPERATOR_FAILURE: Record<StuckReason, FailureClass> = {
  'control-not-found': 'target_not_found',
  'ambiguous-control': 'ambiguous_target',
  'checkpoint-failed': 'checkpoint_failed',
  'unexpected-dialog': 'checkpoint_failed',
  'session-expired': 'session_expired',
  'permission-denied': 'policy_blocked',
  'irreversible-approval': 'policy_blocked',
  'policy-blocked': 'policy_blocked',
  'model-requested-help': 'checkpoint_failed',
  'no-progress': 'checkpoint_failed',
  'budget-exhausted': 'budget_exhausted',
  'app-error': 'app_error',
};

export interface PrecheckFailure {
  class: FailureClass;
  message: string;
}

/**
 * Everything that can be decided without a browser: does the artifact pass
 * static validation, does it apply to this tenant, is it cleared for unattended
 * use, and are the inputs well formed.
 *
 * Exported so a caller runs it *before* opening a session. That is not just an
 * optimization: "the member number you gave me is malformed" should never cost
 * a browser launch, and it should never be reachable from a screen, or an
 * application validation error would be indistinguishable from a caller bug.
 */
export function precheckCapability(
  capability: Capability,
  inputs: Record<string, unknown>,
  opts: { tenant?: string; attended?: boolean; lenientTenant?: boolean } = {},
): { ok: true; capability: Capability; inputs: Record<string, unknown> } | { ok: false; failure: PrecheckFailure } {
  const errors = lintErrors(lintCapability(capability));
  if (errors.length > 0) {
    return { ok: false, failure: { class: 'invalid_artifact', message: errors.map((e) => `${e.code}: ${e.message}`).join('; ') } };
  }

  let specialized: Capability;
  try {
    specialized = specializeForTenant(capability, opts.tenant, { strict: !opts.lenientTenant }).capability;
  } catch (err) {
    return { ok: false, failure: { class: 'invalid_artifact', message: String(err) } };
  }

  if (!opts.attended) {
    const approval = isApprovedForUnattended(specialized);
    if (!approval.ok) {
      return { ok: false, failure: { class: 'not_approved', message: `unattended replay refused: ${approval.reason}` } };
    }
  }

  try {
    return { ok: true, capability: specialized, inputs: validateInputs(specialized.params, inputs) };
  } catch (err) {
    if (err instanceof InputValidationError) return { ok: false, failure: { class: 'invalid_input', message: err.message } };
    throw err;
  }
}

/** Thrown internally to unwind to the failure handler with a classification. */
class ReplayAbort extends Error {
  constructor(
    readonly cls: FailureClass,
    message: string,
    readonly step?: Step,
    readonly expected?: string,
    readonly observed?: string,
  ) {
    super(message);
  }
}

export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const steps: StepReport[] = [];
  const recoveries: RecoveryReport[] = [];
  const degradedSteps: string[] = [];
  const outputs: Record<string, unknown> = {};
  const recoveryUsage = new Map<string, number>();
  const { recorder, driver } = opts;

  const base = (): ReplayResultBase => ({
    capabilityId: opts.capability.id,
    capabilityVersion: opts.capability.version,
    tenant: opts.tenant,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    steps,
    recoveries,
    degradedSteps,
    evidence: {
      runId: recorder.runId,
      directory: recorder.dir,
      log: `${recorder.dir}/run.jsonl`,
      screenshots: [],
    },
  });

  const fail = async (
    cls: FailureClass,
    message: string,
    step?: Step,
    expected?: string,
    observed?: string,
  ): Promise<ReplayResult> => {
    const ev = await recorder.captureEvidence(driver, `fail-${step?.id ?? 'setup'}`, { snapshot: true }).catch(() => ({}));
    recorder.event('run.end', { status: 'failed', class: cls, stepId: step?.id, message });
    return {
      ...base(),
      status: 'failed',
      failure: {
        class: cls,
        message,
        stepId: step?.id,
        stepIntent: step?.intent,
        expected,
        observed,
        screenshot: (ev as { screenshot?: string }).screenshot,
        snapshot: (ev as { snapshot?: string }).snapshot,
      },
      partialOutputs: Object.keys(outputs).length > 0 ? outputs : undefined,
    };
  };

  // -- 0. static gates ---------------------------------------------------
  // Normally already run by the caller before the browser was opened; repeated
  // here so the engine is safe to call directly.
  const pre = precheckCapability(opts.capability, opts.inputs, {
    tenant: opts.tenant,
    attended: opts.attended,
    lenientTenant: opts.lenientTenant,
  });
  if (!pre.ok) {
    recorder.event('run.end', { status: 'failed', class: pre.failure.class, message: pre.failure.message });
    return {
      ...base(),
      status: 'failed',
      failure: { class: pre.failure.class, message: pre.failure.message },
    };
  }
  const capability = pre.capability;
  const inputs = pre.inputs;

  const policy = PolicyEngine.forCapability(opts.basePolicy, capability);
  const secrets = opts.secrets ?? new EnvSecretResolver();
  const tmpl = (s: string): string =>
    resolveTemplate(s, {
      params: inputs,
      outputs,
      secrets,
      secretRegistry: recorder.secrets,
      baseUrl: opts.baseUrl,
    });

  recorder.event('run.start', {
    mode: 'replay',
    capabilityId: capability.id,
    capabilityVersion: capability.version,
    contentHash: capability.contentHash,
    tenant: opts.tenant,
    attended: Boolean(opts.attended),
    paramNames: Object.keys(inputs),
    lintWarnings: lintCapability(capability)
      .filter((f) => f.severity === 'warn')
      .map((f) => f.code),
  });

  // -- helpers -------------------------------------------------------------

  // Always called from within a step, so `step` is not optional here.
  const escalate = async (
    reason: StuckReason,
    detail: string,
    step: Step,
    expected: string | undefined,
    observed: string | undefined,
    askedToDo: string,
  ): Promise<ReplayResult | 'resumed'> => {
    if (!opts.broker) {
      // Nobody to ask. The run still has to report the *right* failure class,
      // because "the app aborted" and "the checkpoint did not hold" send a
      // caller to different places.
      return fail(NO_OPERATOR_FAILURE[reason], `${detail} (no operator is configured for this run)`, step, expected, observed);
    }
    const ev = await recorder.captureEvidence(driver, `escalate-${step.id}`, { snapshot: true });
    const obs = await driver.observe();
    try {
      const resolution = await opts.broker.raise(reason, detail, {
        runId: recorder.runId,
        capabilityId: capability.id,
        capabilityVersion: capability.version,
        stepId: step.id,
        stepIntent: step.intent,
        expected,
        observed,
        observationSummary: recorder.summarizeObservation(obs),
        screenshotPath: ev.screenshot,
        snapshotPath: ev.snapshot,
        askedToDo,
      });
      if (resolution.action === 'resume') return 'resumed';
      if (resolution.action === 'outcome') {
        const declared = capability.outcomes.find((o) => o.id === resolution.outcomeId);
        recorder.event('outcome.detected', { outcomeId: resolution.outcomeId, source: 'operator' });
        return {
          ...base(),
          status: 'business_outcome',
          outcome: {
            id: resolution.outcomeId ?? 'OPERATOR_DECLARED',
            description: declared?.description ?? 'declared by the operator during an intervention',
            detail: resolution.note ?? detail,
            data: {},
          },
        };
      }
      return {
        ...base(),
        status: 'escalated',
        escalation: {
          // Read from the resolution: by the time it arrives, control has
          // already returned to automation and the broker no longer holds it.
          // The broker stamps the id on every resolution it hands back.
          interventionId: resolution.interventionId!,
          reason,
          resolvedBy: resolution.by,
          resolution: resolution.action,
          note: resolution.note,
        },
        outputs,
      };
    } catch (err) {
      if (err instanceof EscalationTimeout) {
        return fail('escalation_timeout', err.message, step, expected, observed);
      }
      throw err;
    }
  };

  const applicableRecovery = (obs: Observation): { recovery: Recovery; detail: string } | null => {
    for (const r of capability.recoveries) {
      if ((recoveryUsage.get(r.id) ?? 0) >= r.maxPerRun) continue;
      const res = evaluateCondition(r.when, obs);
      if (res.ok) return { recovery: r, detail: res.detail };
    }
    return null;
  };

  /**
   * Apply one recovery. Recoveries never nest: while one is running the engine
   * will not start another, so a screen that satisfies two triggers cannot form
   * a loop.
   */
  const runRecovery = async (r: Recovery, atStep: Step, trigger: string, upToIndex: number): Promise<void> => {
    const used = (recoveryUsage.get(r.id) ?? 0) + 1;
    recoveryUsage.set(r.id, used);
    recorder.event('recovery.applied', { recoveryId: r.id, atStepId: atStep.id, trigger, attempt: used });

    for (const action of r.do) {
      switch (action.kind) {
        case 'wait':
          await new Promise((res) => setTimeout(res, action.ms));
          break;
        case 'navigate':
          await driver.navigate(tmpl(action.url));
          policy.assertLocationAllowed(driver.currentUrl());
          break;
        case 'click':
          await driver.click(await driver.resolve(action.ref));
          break;
        case 'fill':
          await driver.fill(await driver.resolve(action.ref), tmpl(action.value));
          break;
        case 'replayFrom': {
          // Rebuild the prefix of the flow: everything from the first step of
          // this phase up to, but not including, the step that failed.
          const from = capability.steps.findIndex((s) => s.phase === action.phase);
          if (from < 0) break;
          for (let k = from; k < upToIndex; k++) {
            const prior = capability.steps[k]!;
            recorder.event('note', { note: 'replaying step during recovery', stepId: prior.id, recoveryId: r.id });
            await executeStep(prior, k, { inRecovery: true });
          }
          break;
        }
      }
    }
    recoveries.push({ recoveryId: r.id, atStepId: atStep.id, trigger, appliedCount: used, succeeded: true });
  };

  // -- the step executor ---------------------------------------------------

  async function executeStep(step: Step, index: number, ctx: { inRecovery?: boolean } = {}): Promise<StepReport> {
    const t0 = Date.now();
    const report: StepReport = {
      stepId: step.id,
      intent: step.intent,
      action: step.action,
      status: 'ok',
      durationMs: 0,
      recordedTier: step.recordedTier,
    };

    let obs = await driver.observe();

    // Interstitials are checked proactively against the observation we already
    // have, so a dialog that appears between steps costs nothing to notice.
    if (!ctx.inRecovery) {
      const hit = applicableRecovery(obs);
      if (hit) {
        await runRecovery(hit.recovery, step, hit.detail, index);
        report.status = 'recovered';
        obs = await driver.observe();
      }
    }

    if (step.waitFor) {
      // An optional step's precondition asks "is this interstitial on screen
      // right now", and the answer does not improve by waiting. Giving it the
      // step's full budget makes every run pay that timeout for every
      // interstitial that did not appear.
      const waitBudget = step.optional ? Math.min(step.timeoutMs, 1_500) : step.timeoutMs;
      const w = await waitForCondition(driver, step.waitFor, waitBudget);
      obs = w.observation;
      if (!w.ok) {
        if (step.optional) {
          recorder.event('note', { note: 'optional step skipped: precondition not met', stepId: step.id, detail: w.detail });
          report.status = 'skipped';
          report.durationMs = Date.now() - t0;
          report.note = w.detail;
          return report;
        }
        throw new ReplayAbort('precondition_failed', `precondition never held: ${w.detail}`, step, describeCondition(step.waitFor), w.detail);
      }
    }

    // -- authorize -----------------------------------------------------
    const request: ActionRequest = {
      kind: step.action,
      actor: 'replay',
      url: step.url ? tmpl(step.url) : undefined,
      ref: step.ref,
    };
    const decision = policy.authorize(request);
    recorder.event('action.request', {
      stepId: step.id,
      action: step.action,
      intent: step.intent,
      target: step.ref ? `${step.ref.role}:"${step.ref.name ?? ''}"` : request.url,
      risk: decision.risk,
      allowed: decision.allow,
    });
    if (!decision.allow) {
      recorder.event('action.blocked', { stepId: step.id, code: decision.code, reason: decision.reason });
      // The gate always states a reason when it refuses.
      throw new ReplayAbort('policy_blocked', decision.reason!, step);
    }
    policy.countStep();

    // -- act -----------------------------------------------------------
    try {
      switch (step.action) {
        case 'navigate':
          await driver.navigate(tmpl(step.url!));
          break;
        case 'wait':
          await new Promise((r) => setTimeout(r, Math.min(step.timeoutMs, 5_000)));
          break;
        case 'assert':
          break;
        case 'click': {
          const r = await driver.resolve(step.ref!);
          report.resolvedTier = r.tier;
          await driver.click(r);
          break;
        }
        case 'fill': {
          const r = await driver.resolve(step.ref!);
          report.resolvedTier = r.tier;
          await driver.fill(r, tmpl(step.value ?? ''));
          break;
        }
        case 'select': {
          const r = await driver.resolve(step.ref!);
          report.resolvedTier = r.tier;
          await driver.select(r, tmpl(step.value ?? ''));
          break;
        }
        case 'press': {
          const r = step.ref ? await driver.resolve(step.ref) : undefined;
          report.resolvedTier = r?.tier;
          await driver.press(step.key ?? 'Enter', r);
          break;
        }
        case 'extract':
          break; // handled below, after the outcome and checkpoint checks
      }
    } catch (err) {
      if (err instanceof ControlNotFoundError) {
        throw new ReplayAbort('target_not_found', err.message, step, `a ${step.ref?.role} named "${step.ref?.name}"`, 'no matching control on screen');
      }
      if (err instanceof AmbiguousControlError) {
        throw new ReplayAbort('ambiguous_target', err.message, step, `exactly one ${step.ref?.role} named "${step.ref?.name}"`, `${err.count} matches`);
      }
      if (err instanceof PolicyViolation) throw new ReplayAbort('policy_blocked', err.message, step);
      throw new ReplayAbort('driver_error', String(err), step);
    }

    // A click can navigate anywhere; this is the check that actually enforces
    // the allowlist.
    try {
      policy.assertLocationAllowed(driver.currentUrl());
    } catch (err) {
      throw new ReplayAbort('policy_blocked', String(err), step);
    }

    if (report.resolvedTier && step.recordedTier) {
      if (tierRank(report.resolvedTier) > tierRank(step.recordedTier)) {
        report.degraded = true;
        if (!degradedSteps.includes(step.id)) degradedSteps.push(step.id);
        recorder.event('note', {
          note: 'locator degraded',
          stepId: step.id,
          recordedTier: step.recordedTier,
          resolvedTier: report.resolvedTier,
        });
      }
    }

    recorder.event('action.done', { stepId: step.id, tier: report.resolvedTier, url: driver.currentUrl() });
    report.durationMs = Date.now() - t0;
    return report;
  }

  // -- outcome detection ---------------------------------------------------

  const detectOutcome = (obs: Observation, stepId: string): { outcome: Outcome; detail: string } | null => {
    for (const o of capability.outcomes) {
      if (o.checkAfter.length > 0 && !o.checkAfter.includes(stepId)) continue;
      const res = evaluateCondition(o.detect, obs);
      if (res.ok) return { outcome: o, detail: res.detail };
    }
    return null;
  };

  const runExtract = async (
    e: NonNullable<Step['extract']>,
    obs: Observation,
  ): Promise<{ ok: boolean; value?: unknown; detail: string }> => {
    let raw: string;

    if (e.source.kind === 'control') {
      try {
        const r = await driver.resolve(e.source.ref);
        raw = await driver.readText(r);
      } catch (err) {
        return { ok: false, detail: `cannot read ${e.source.ref.role} "${e.source.ref.name ?? ''}": ${String(err)}` };
      }
    } else {
      // Reading a value out of prose - a confirmation number inside a banner -
      // is common enough on these screens to deserve a first-class source.
      const wanted = e.source.frame;
      const frames = wanted
        ? obs.frames.filter((f) =>
            wanted.name !== undefined
              ? f.framePath.some((p) => p.name === wanted.name)
              : wanted.index !== undefined
                ? f.framePath.some((p) => p.index === wanted.index)
                : true,
          )
        : obs.frames;
      const hay = frames.map((f) => `${f.text} ${f.alerts.join(' ')}`).join('\n');
      const m = new RegExp(e.source.pattern).exec(hay);
      if (!m) return { ok: false, detail: `pattern /${e.source.pattern}/ matched nothing on screen` };
      raw = m[1] ?? m[0];
    }

    if (e.pattern) {
      const m = new RegExp(e.pattern).exec(raw);
      if (!m) return { ok: false, detail: `value did not match /${e.pattern}/` };
      raw = m[1] ?? m[0];
    }
    return { ok: true, value: applyTransform(raw, e.transform), detail: 'extracted' };
  };

  // -- main loop -----------------------------------------------------------

  try {
    // The recorded flow almost always opens with its own navigate step. Doing it
    // here as well would be a wasted round trip, and - less obviously - it would
    // mask a condition the app returns on that very first request.
    if (capability.steps[0]?.action !== 'navigate') {
      await driver.navigate(tmpl(capability.entryUrlTemplate));
      policy.assertLocationAllowed(driver.currentUrl());
    }

    for (let i = 0; i < capability.steps.length; i++) {
      const step = capability.steps[i]!;
      let report: StepReport;

      try {
        report = await executeStep(step, i);
      } catch (err) {
        if (!(err instanceof ReplayAbort)) throw err;

        // Before treating this as a failure, give a declared recovery one
        // chance: this is where session expiry and unexpected interstitials
        // are absorbed.
        const obs = await driver.observe();
        const hit = applicableRecovery(obs);
        if (hit) {
          await runRecovery(hit.recovery, step, hit.detail, i);
          if (hit.recovery.retryStep) {
            report = await executeStep(step, i, {});
            report.status = 'recovered';
          } else {
            report = { stepId: step.id, intent: step.intent, action: step.action, status: 'recovered', durationMs: 0 };
          }
        } else if (step.onCheckpointFail === 'escalate' || err.cls === 'target_not_found' || err.cls === 'ambiguous_target') {
          const outcome = await escalate(
            err.cls === 'target_not_found' ? 'control-not-found' : err.cls === 'ambiguous_target' ? 'ambiguous-control' : 'checkpoint-failed',
            err.message,
            step,
            err.expected,
            err.observed,
            `Complete "${step.intent}" by hand, then hand control back so the run can continue from the next step.`,
          );
          if (outcome !== 'resumed') return outcome;
          report = { stepId: step.id, intent: step.intent, action: step.action, status: 'recovered', durationMs: 0, note: 'completed by operator' };
        } else {
          steps.push({ stepId: step.id, intent: step.intent, action: step.action, status: 'failed', durationMs: 0 });
          return fail(err.cls, err.message, step, err.expected, err.observed);
        }
      }

      // -- outcomes before checkpoints --------------------------------
      let obs = await driver.observe();
      const outcomeHit = detectOutcome(obs, step.id);
      if (outcomeHit) {
        const { outcome, detail } = outcomeHit;
        recorder.event('outcome.detected', { outcomeId: outcome.id, stepId: step.id, detail, disposition: outcome.disposition });
        const data: Record<string, unknown> = {};
        for (const e of outcome.extract) {
          const r = await runExtract(e, obs);
          if (r.ok) data[e.as] = r.value;
        }
        await recorder.captureEvidence(driver, `outcome-${outcome.id}`);
        steps.push(report);

        if (outcome.disposition === 'escalate') {
          const res = await escalate(
            outcome.id === 'PERMISSION_DENIED' ? 'permission-denied' : 'app-error',
            `${outcome.id}: ${outcome.description}`,
            step,
            'the flow to continue normally',
            detail,
            `The application reported "${outcome.description}". Resolve it in the session if you can, then resume; otherwise hand it back as this business outcome.`,
          );
          if (res !== 'resumed') return res;
        } else {
          recorder.event('run.end', { status: 'business_outcome', outcomeId: outcome.id });
          return {
            ...base(),
            status: 'business_outcome',
            outcome: { id: outcome.id, description: outcome.description, detail, data },
          };
        }
      }

      // -- checkpoint --------------------------------------------------
      if (step.checkpoint && report.status !== 'skipped') {
        const expected = describeCondition(step.checkpoint);
        const w = await waitForCondition(driver, step.checkpoint, step.timeoutMs);
        obs = w.observation;
        report.checkpoint = { ok: w.ok, expected, observed: w.detail, waitedMs: w.waitedMs };

        if (!w.ok) {
          recorder.event('checkpoint.fail', { stepId: step.id, expected, observed: w.detail, waitedMs: w.waitedMs });

          const hit = applicableRecovery(obs);
          if (hit) {
            await runRecovery(hit.recovery, step, hit.detail, i);
            // A recovery that rebuilt the flow has undone whatever this step
            // achieved, so the step has to run again before its checkpoint can
            // hold. `inRecovery` keeps a second recovery from nesting.
            if (hit.recovery.retryStep) await executeStep(step, i, { inRecovery: true });
            const retry = await waitForCondition(driver, step.checkpoint, step.timeoutMs);
            report.checkpoint = { ok: retry.ok, expected, observed: retry.detail, waitedMs: retry.waitedMs };
            if (!retry.ok) {
              if (step.onCheckpointFail === 'escalate') {
                const res = await escalate('checkpoint-failed', `checkpoint for "${step.intent}" did not hold`, step, expected, retry.detail, `Get the session to the state where ${expected}, then hand control back.`);
                if (res !== 'resumed') return res;
              } else {
                report.status = 'failed';
                steps.push(report);
                return fail('checkpoint_failed', `checkpoint did not hold after recovery: ${retry.detail}`, step, expected, retry.detail);
              }
            }
          } else if (step.onCheckpointFail === 'escalate') {
            const res = await escalate('checkpoint-failed', `checkpoint for "${step.intent}" did not hold`, step, expected, w.detail, `Get the session to the state where ${expected}, then hand control back.`);
            if (res !== 'resumed') return res;
          } else if (step.onCheckpointFail === 'retry_step') {
            const retryReport = await executeStep(step, i);
            const retry = await waitForCondition(driver, step.checkpoint, step.timeoutMs);
            report = { ...retryReport, status: 'recovered', checkpoint: { ok: retry.ok, expected, observed: retry.detail, waitedMs: retry.waitedMs } };
            if (!retry.ok) {
              steps.push({ ...report, status: 'failed' });
              return fail('checkpoint_failed', `checkpoint did not hold after retry: ${retry.detail}`, step, expected, retry.detail);
            }
          } else {
            report.status = 'failed';
            steps.push(report);
            return fail('checkpoint_failed', w.detail, step, expected, w.detail);
          }
        } else {
          recorder.event('checkpoint.pass', { stepId: step.id, expected, waitedMs: w.waitedMs, polls: w.polls });
        }
      }

      // -- extract -----------------------------------------------------
      // A step that was skipped produced nothing, so there is nothing to read
      // off the screen. Attempting it anyway turns a correctly skipped optional
      // step into a hard failure.
      if (step.extract && report.status !== 'skipped') {
        const r = await runExtract(step.extract, obs);
        if (!r.ok) {
          report.status = 'failed';
          steps.push(report);
          return fail('checkpoint_failed', `extraction "${step.extract.as}" failed: ${r.detail}`, step, `a value for ${step.extract.as}`, r.detail);
        }
        outputs[step.extract.as] = r.value;
        const sens = capability.returns[step.extract.as]?.sensitivity ?? 'none';
        recorder.event('action.done', {
          stepId: step.id,
          extracted: step.extract.as,
          // The value itself is summarized according to its declared
          // sensitivity; it is returned to the caller but never written here.
          value: sens === 'none' ? r.value : `«${sens}»`,
        });
      }

      steps.push(report);
    }

    const issues = checkOutputs(capability.returns, outputs);
    if (issues.length > 0) {
      return fail('checkpoint_failed', `run finished but outputs are incomplete: ${issues.join('; ')}`);
    }

    await recorder.captureEvidence(driver, 'success');
    recorder.event('run.end', { status: 'success', outputs: Object.keys(outputs), degradedSteps });
    return { ...base(), status: 'success', outputs };
  } catch (err) {
    if (err instanceof PolicyViolation) return fail('policy_blocked', err.message);
    if (err instanceof ReplayAbort) return fail(err.cls, err.message, err.step, err.expected, err.observed);
    return fail('driver_error', String(err));
  }
}
