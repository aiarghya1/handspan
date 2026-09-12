/**
 * The discovery loop: observe -> decide -> act, with the model in the loop.
 *
 * The loop itself is ordinary. What is load-bearing is what happens around each
 * action:
 *
 *   - the same policy gate replay uses authorizes it, so the model cannot
 *     record a step that replay would later be refused;
 *   - a ControlRef is derived *at the moment of the action*, while the full
 *     observation is in hand, because that is the only point at which we know
 *     what else was on screen and therefore what the minimum unambiguous ref
 *     is;
 *   - an irreversible action is not performed by the model at all. It is routed
 *     to a human, who does it in the same session and hands control back, and
 *     the step is recorded as human-assisted.
 *
 * A model that gets stuck is a first-class outcome rather than a timeout: it can
 * ask for help explicitly, and the loop also watches for the implicit version -
 * several actions in a row that changed nothing on screen.
 */

import type { ControlRef, SurfaceDriver } from '../surface/types.js';
import { deriveRef } from '../surface/match.js';
import { resolveFromControls } from '../surface/match.js';
import type { AppProfile } from '../artifact/app-profile.js';
import type { Phase, Risk } from '../artifact/schema.js';
import type { SecretResolver } from '../artifact/template.js';
import type { RunRecorder } from '../obs/recorder.js';
import { PolicyEngine, type ActionRequest } from '../policy/policy.js';
import { EscalationBroker, EscalationTimeout } from '../escalation/broker.js';
import type { Planner, ToolResult } from '../llm/planner.js';
import { evaluateCondition } from '../replay/conditions.js';
import { observationSignature, renderObservation } from './render.js';
import type { GoalSpec } from './goal.js';
import { newTrace, type DeclaredOutcome, type DiscoveryTrace, type TraceEntry } from './trace.js';

export interface DiscoverOptions {
  goal: GoalSpec;
  app: AppProfile;
  planner: Planner;
  driver: SurfaceDriver;
  recorder: RunRecorder;
  policy: PolicyEngine;
  secrets: SecretResolver;
  baseUrl: string;
  broker?: EscalationBroker;
  maxTurns?: number;
  /** Send screenshots to the model. Off makes runs cheaper and text-only. */
  vision?: boolean;
}

export interface DiscoverResult {
  status: 'success' | 'stopped' | 'failed';
  reason?: string;
  trace: DiscoveryTrace;
}

const NO_PROGRESS_LIMIT = 3;

export async function discover(opts: DiscoverOptions): Promise<DiscoverResult> {
  const { goal, driver, recorder, policy, planner } = opts;
  const entryUrl = new URL(goal.entryPath, opts.baseUrl).toString();

  const trace = newTrace({
    goalId: goal.id,
    goal: goal.goal,
    model: planner.model,
    runId: recorder.runId,
  });

  recorder.event('run.start', {
    mode: 'discovery',
    goalId: goal.id,
    goal: goal.goal,
    model: planner.model,
    app: opts.app.id,
    tenant: goal.tenant,
    entryUrl,
  });

  let seq = 0;
  let lastSignature = '';
  let noProgress = 0;
  let finished: { summary: string; successText: string } | null = null;
  let failure: string | undefined;

  const push = (e: Omit<TraceEntry, 'seq' | 'at'>): TraceEntry => {
    const entry: TraceEntry = { seq: seq++, at: new Date().toISOString(), ...e };
    trace.entries.push(entry);
    return entry;
  };

  // Records the entry point as the first step, so replay starts the same way.
  await driver.navigate(entryUrl);
  policy.assertLocationAllowed(driver.currentUrl());

  const escalateAndWait = async (
    reason: Parameters<EscalationBroker['raise']>[0],
    detail: string,
    askedToDo: string,
    intendedAction?: { kind: 'click' | 'fill' | 'select' | 'press'; ref?: ControlRef; value?: string },
  ): Promise<{ resumed: boolean; note?: string; by?: string }> => {
    if (!opts.broker) return { resumed: false, note: 'no operator broker is configured for this run' };
    const ev = await recorder.captureEvidence(driver, `escalate-${reason}`, { snapshot: true });
    const obs = await driver.observe();
    try {
      const res = await opts.broker.raise(reason, detail, {
        runId: recorder.runId,
        goal: goal.goal,
        capabilityId: goal.id,
        observationSummary: recorder.summarizeObservation(obs),
        screenshotPath: ev.screenshot,
        snapshotPath: ev.snapshot,
        askedToDo,
        intendedAction,
      });
      trace.humanAssisted = true;
      return { resumed: res.action === 'resume', note: res.note, by: res.by };
    } catch (err) {
      if (err instanceof EscalationTimeout) return { resumed: false, note: err.message };
      throw err;
    }
  };

  /**
   * Look up a handle from the current observation.
   *
   * A model always passes a real handle it just read. Scripted runs may instead
   * pass a descriptor - `button|Retrieve`, `cell|Balance|row=REGULAR SHARE
   * SAVINGS`, `cell|Name#0` - so that a script stays readable and does not break
   * when handle numbering shifts. This descriptor form exists only for scripted
   * and test runs; it is not part of the model's tool surface.
   */
  const findControl = async (handle: string) => {
    const obs = await driver.observe();
    const direct = obs.controls.find((c) => c.handle === handle);
    if (direct) return { obs, control: direct };
    if (!handle.includes('|')) return { obs, control: undefined };

    const [role, rawName, ...qualifiers] = handle.split('|');
    let name: string | undefined = rawName;
    let ordinal: number | undefined;
    if (name?.includes('#')) {
      const [n, o] = name.split('#');
      name = n;
      ordinal = Number(o);
    }
    const scope: { frame?: { name: string }; section?: string; rowContaining?: string } = {};
    for (const q of qualifiers) {
      const [k, ...v] = q.split('=');
      const value = v.join('=');
      if (k === 'row') scope.rowContaining = value;
      else if (k === 'section') scope.section = value;
      else if (k === 'frame') scope.frame = { name: value };
    }
    const res = resolveFromControls(
      {
        role: role as never,
        name: name || undefined,
        ordinal,
        scope: Object.keys(scope).length > 0 ? scope : undefined,
      },
      obs.controls,
    );
    return { obs, control: res.control };
  };

  const maxTurns = opts.maxTurns ?? 40;
  let results: ToolResult[] | null = null;

  for (let turn = 0; turn < maxTurns && !finished && !failure; turn++) {
    trace.turns = turn + 1;
    const decision = await planner.next(results);

    if (decision.text) recorder.event('model.decision', { turn, text: decision.text, usage: decision.usage });
    if (decision.stop === 'refusal') {
      failure = 'the model declined to continue';
      break;
    }
    if (decision.calls.length === 0) {
      failure = decision.stop === 'end_turn' ? 'the model stopped without calling finish' : `model stop reason: ${decision.stop}`;
      break;
    }

    const next: ToolResult[] = [];

    for (const call of decision.calls) {
      const input = call.input as Record<string, string | undefined>;
      const intent = input['intent'] ?? call.name;
      const phase = (input['phase'] as Phase | undefined) ?? 'input';

      try {
        switch (call.name) {
          case 'observe': {
            const obs = await driver.observe();
            const sig = observationSignature(obs);
            noProgress = sig === lastSignature ? noProgress + 1 : 0;
            lastSignature = sig;
            recorder.event('observe', recorder.summarizeObservation(obs));
            const shot = opts.vision === false ? undefined : await driver.screenshot({ maskSensitive: true });
            next.push({ id: call.id, text: renderObservation(obs), imagePng: shot });
            break;
          }

          case 'declare_outcome': {
            const o: DeclaredOutcome = {
              id: String(input['id']),
              description: String(input['description']),
              whenText: String(input['when_text']),
              disposition: (input['disposition'] as 'return' | 'escalate') ?? 'return',
            };
            trace.declaredOutcomes.push(o);
            recorder.event('note', { note: 'model declared a business outcome', ...o });
            next.push({ id: call.id, text: `Recorded outcome ${o.id}. It will be reported to the caller as a result, not an error.` });
            break;
          }

          case 'request_help': {
            const r = await escalateAndWait(
              'model-requested-help',
              String(input['reason'] ?? 'the agent asked for help'),
              String(input['what_you_need'] ?? 'unspecified'),
            );
            next.push({
              id: call.id,
              text: r.resumed
                ? `An operator worked on the session and handed control back${r.note ? `. They noted: ${r.note}` : ''}. Call observe to see the current screen.`
                : `No operator resolved this${r.note ? `: ${r.note}` : ''}. Stop and call finish only if the goal is genuinely met.`,
              isError: !r.resumed,
            });
            break;
          }

          case 'finish': {
            finished = {
              summary: String(input['summary'] ?? ''),
              successText: String(input['success_text'] ?? ''),
            };
            next.push({ id: call.id, text: 'Recorded. The run is complete.' });
            break;
          }

          case 'read_value': {
            const name = String(input['name']);
            if (!(name in goal.returns)) {
              const text = `"${name}" is not a declared return. Declared: ${Object.keys(goal.returns).join(', ')}`;
              recorder.event('action.failed', { tool: 'read_value', name, reason: text });
              next.push({ id: call.id, text, isError: true });
              break;
            }
            if (input['handle']) {
              const { obs, control: found } = await findControl(input['handle']);
              if (!found) {
                const text = `handle ${input['handle']} is not on the current screen; call observe again`;
                recorder.event('action.failed', { tool: 'read_value', name, reason: text });
                next.push({ id: call.id, text, isError: true });
                break;
              }
              const res = resolveFromControls(deriveRef(found, obs.controls), obs.controls);
              const value = await driver.readText(res);
              const ref = deriveRef(found, obs.controls);
              push({ action: 'extract', intent, phase: 'read', risk: 'read_only', ref, resolvedTier: res.tier, extract: { as: name, source: { kind: 'control', ref }, sampleShape: `${value.length} chars` } });
              recorder.event('action.done', { action: 'extract', name, tier: res.tier });
              next.push({ id: call.id, text: `Read ${name} = "${value}". Recorded as a durable reference: ${ref.role} "${ref.name ?? ''}"${ref.scope?.rowContaining ? ` in the row containing "${ref.scope.rowContaining}"` : ''}.` });
              break;
            }
            const obs = await driver.observe();
            const pattern = String(input['text_pattern'] ?? '');
            const hay = obs.frames.map((f) => `${f.text} ${f.alerts.join(' ')}`).join('\n');
            const m = pattern ? new RegExp(pattern).exec(hay) : null;
            if (!m) {
              const text = `Give either a handle or a text_pattern that matches. /${pattern}/ matched nothing.`;
              recorder.event('action.failed', { tool: 'read_value', name, reason: text });
              next.push({ id: call.id, text, isError: true });
              break;
            }
            const value = m[1] ?? m[0];
            push({ action: 'extract', intent, phase: 'read', risk: 'read_only', extract: { as: name, source: { kind: 'text', pattern }, sampleShape: `${value.length} chars` } });
            next.push({ id: call.id, text: `Read ${name} = "${value}" using /${pattern}/.` });
            break;
          }

          case 'click':
          case 'type_text':
          case 'type_secret':
          case 'select_option':
          case 'press_key': {
            const r = await performAction(call.name, input, intent, phase);
            // Anything handed back to the model as an error is also a run event:
            // a refusal the model routed around is exactly what a reviewer wants
            // to see, and it is invisible if it only exists in the transcript.
            if (r.isError) recorder.event('action.failed', { tool: call.name, intent, reason: r.text });
            next.push({ id: call.id, text: r.text, isError: r.isError });
            break;
          }

          default:
            next.push({ id: call.id, text: `unknown tool "${call.name}"`, isError: true });
        }
      } catch (err) {
        recorder.event('action.failed', { tool: call.name, error: String(err) });
        next.push({ id: call.id, text: `That failed: ${String(err)}`, isError: true });
      }
    }

    if (noProgress >= NO_PROGRESS_LIMIT) {
      const r = await escalateAndWait(
        'no-progress',
        `${noProgress} observations in a row showed an identical screen`,
        'The agent appears to be stuck on this screen. Move the session forward, or abort the run.',
      );
      noProgress = 0;
      if (!r.resumed) {
        failure = 'the agent made no progress and no operator was able to help';
        break;
      }
    }

    const budget = policy.budgetRemaining;
    if (budget.steps <= 0 || budget.ms <= 0) {
      failure = `budget exhausted (${policy.stepsUsed} actions used)`;
      break;
    }

    results = next;
  }

  // -- action execution ----------------------------------------------------

  async function performAction(
    tool: string,
    input: Record<string, string | undefined>,
    intent: string,
    phase: Phase,
  ): Promise<{ text: string; isError?: boolean }> {
    const handle = input['handle'];
    const { obs, control } = handle ? await findControl(handle) : { obs: await driver.observe(), control: undefined };

    if (!control && tool !== 'press_key') {
      return { text: `handle ${handle} is not on the current screen. Call observe and use a current handle.`, isError: true };
    }

    const ref = control ? deriveRef(control, obs.controls) : undefined;
    // Which of the application's known transient conditions are on screen right
    // now. Recorded with the action so the compiler knows whether this action
    // was the agent doing the recovery's job.
    const triggeredRecoveries = opts.app.recoveries
      .filter((r) => evaluateCondition(r.when, obs).ok)
      .map((r) => r.id);
    const kind =
      tool === 'click' ? 'click' : tool === 'select_option' ? 'select' : tool === 'press_key' ? 'press' : 'fill';

    const request: ActionRequest = { kind, actor: 'discovery-agent', ref };
    const decision = policy.authorize(request);
    recorder.event('action.request', {
      tool,
      intent,
      phase,
      target: ref ? `${ref.role}:"${ref.name ?? ''}"` : input['key'],
      risk: decision.risk,
      allowed: decision.allow,
    });

    if (!decision.allow) {
      trace.blockedActions += 1;
      recorder.event('action.blocked', { tool, code: decision.code, reason: decision.reason, risk: decision.risk });

      if (!decision.escalate) {
        return { text: `Refused by policy: ${decision.reason}. Find another way, or call request_help.`, isError: true };
      }

      // The irreversible path: a human performs it in the same session.
      //
      // Only a *named* control can be classified irreversible - the classifier
      // reads the control's label - so a refusal that escalates always has a
      // named ref, and the policy always states a reason for refusing.
      const target = ref!;
      const r = await escalateAndWait(
        'irreversible-approval',
        decision.reason!,
        `The agent wants to ${intent} by clicking ${target.role} "${target.name}". If that is correct, perform it in the session and hand control back; otherwise abort.`,
        { kind: kind as 'click' | 'fill' | 'select' | 'press', ref: target, value: input['value'] ?? input['text'] },
      );
      if (!r.resumed) {
        return { text: `A human declined or did not arrive: ${r.note ?? 'unresolved'}. Do not retry.`, isError: true };
      }
      // Recorded as a real step: replay can perform it, gated on approval.
      push({
        action: kind as TraceEntry['action'],
        intent,
        phase: phase === 'input' ? 'commit' : phase,
        risk: 'irreversible',
        ref,
        expect: input['expect'],
        triggeredRecoveries,
        humanAssisted: true,
        urlAfter: driver.currentUrl(),
      });
      return { text: `An operator performed that step and handed control back. Call observe to continue.` };
    }

    policy.countStep();
    // A bare keystroke has no control to focus, so there is nothing to resolve.
    const resolution = ref ? await driver.resolve(ref) : undefined;

    let value: string | undefined;
    let parameter: string | undefined;
    let secretKey: string | undefined;

    try {
      switch (tool) {
        case 'click':
          await driver.click(resolution!);
          break;
        case 'type_text': {
          value = String(input['text'] ?? '');
          parameter = input['parameter'];
          // Trust but verify: if the typed value is exactly a declared
          // parameter's value, record it as that parameter even when the model
          // forgot to say so. Otherwise the artifact hard-codes today's member.
          if (!parameter) {
            const match = Object.entries(goal.params).find(([, p]) => p.value === value);
            if (match) {
              parameter = match[0];
              recorder.event('note', { note: 'inferred parameterization the model did not declare', parameter });
            }
          }
          await driver.fill(resolution!, value);
          break;
        }
        case 'type_secret': {
          secretKey = String(input['secret_key'] ?? '');
          const secret = opts.secrets.get(secretKey);
          if (secret === undefined) {
            return { text: `No credential is available under the key "${secretKey}".`, isError: true };
          }
          recorder.secrets.register(secretKey, secret);
          await driver.fill(resolution!, secret);
          break;
        }
        case 'select_option':
          value = String(input['value'] ?? '');
          parameter = input['parameter'];
          await driver.select(resolution!, value);
          break;
        case 'press_key':
          await driver.press(String(input['key'] ?? 'Enter'), resolution);
          break;
      }
    } catch (err) {
      recorder.event('action.failed', { tool, error: String(err) });
      return { text: `The action failed: ${String(err)}`, isError: true };
    }

    try {
      policy.assertLocationAllowed(driver.currentUrl());
    } catch (err) {
      return { text: `That navigated outside the allowed origin and the run cannot continue there: ${String(err)}`, isError: true };
    }

    const after = await driver.observe();
    push({
      action: kind as TraceEntry['action'],
      intent,
      phase: secretKey ? 'signon' : phase,
      risk: decision.risk as Risk,
      ref,
      resolvedTier: resolution?.tier,
      value: secretKey ? undefined : value,
      parameter,
      secretKey,
      key: input['key'],
      expect: input['expect'],
      triggeredRecoveries,
      urlAfter: driver.currentUrl(),
      sectionAfter: after.controls.find((c) => c.section)?.section,
    });
    recorder.event('action.done', { tool, intent, tier: resolution?.tier, url: driver.currentUrl() });
    await recorder.captureEvidence(driver, `${seq}-${kind}`);

    return { text: `Done. Call observe to see the result.` };
  }

  trace.finishedAt = new Date().toISOString();
  trace.summary = finished?.summary;
  trace.successText = finished?.successText;

  const status: DiscoverResult['status'] = finished ? 'success' : failure ? 'failed' : 'stopped';
  recorder.event('run.end', {
    status,
    reason: failure,
    actions: trace.entries.length,
    turns: trace.turns,
    blockedActions: trace.blockedActions,
    humanAssisted: trace.humanAssisted,
  });

  return { status, reason: failure, trace };
}
