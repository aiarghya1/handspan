/**
 * Human-in-the-loop escalation and control transfer.
 *
 * The design question is not "how do we notify someone" - that part is a queue.
 * It is "what does it mean for a human to take over a session that automation
 * is halfway through". The answer here has three parts.
 *
 * **One session, one controller.** `SessionControl` is a token held by exactly
 * one actor. Automation holds it by default. Raising an intervention cedes it;
 * the operator's actions are refused until they claim it, and the automation's
 * actions are refused until it is handed back. Any action from an actor that is
 * not the controller throws. This is what stops the failure mode where the
 * agent retries a step while a person is mid-way through fixing it by hand.
 *
 * **One action pipeline, two actors.** The operator does not get a side door to
 * the browser. Their clicks go through the same `authorize -> act -> record`
 * path the agent uses, with `actor: 'operator'`. Two things fall out for free:
 * every manual step lands in the same run log in the same shape, and the origin
 * allowlist still applies to a human. Their *authority* is higher - an operator
 * may commit an irreversible action the agent may not - but their *boundary*
 * is the same.
 *
 * **A lease, not a promise.** An operator who closes their laptop must not wedge
 * a session forever. A claim carries a lease that heartbeats extend; when it
 * lapses, control returns to the broker and the run fails with a clear reason
 * rather than hanging.
 *
 * What is deliberately not built: a durable queue and a cross-process session
 * host. The broker is an in-process interface today, which is why the console
 * runs inside the same process as the run. Production would put a session host
 * behind this interface and a real work queue in front of it; the shape of
 * `raise()` - context in, resolution out - does not change.
 */

import { randomUUID } from 'node:crypto';
import type { Control, Observation, SurfaceDriver } from '../surface/types.js';
import type { RunRecorder } from '../obs/recorder.js';
import { PolicyEngine, type ActionRequest } from '../policy/policy.js';

export type Controller = 'automation' | 'operator';

export type StuckReason =
  | 'control-not-found'
  | 'ambiguous-control'
  | 'checkpoint-failed'
  | 'unexpected-dialog'
  | 'session-expired'
  | 'permission-denied'
  | 'irreversible-approval'
  | 'policy-blocked'
  | 'model-requested-help'
  /** Several actions in a row changed nothing on screen. */
  | 'no-progress'
  | 'budget-exhausted'
  | 'app-error';

export interface InterventionContext {
  runId: string;
  capabilityId?: string;
  capabilityVersion?: string;
  goal?: string;
  stepId?: string;
  stepIntent?: string;
  /** What replay expected to be true, in words a person can act on. */
  expected?: string;
  observed?: string;
  observationSummary?: unknown;
  screenshotPath?: string;
  snapshotPath?: string;
  /** What the operator is being asked to do. */
  askedToDo: string;
  /**
   * The action the automation wanted to perform but was not permitted to.
   *
   * Present for an approval escalation. It lets the console offer "do exactly
   * what the agent asked for" as one click instead of making the operator
   * re-find the control, and it is what a simulated operator replays in an
   * unattended demo.
   */
  intendedAction?: {
    kind: 'click' | 'fill' | 'select' | 'press';
    ref?: import('../surface/types.js').ControlRef;
    value?: string;
  };
}

export type ResolutionAction = 'resume' | 'abort' | 'outcome';

export interface InterventionResolution {
  /** The intervention this resolves. Carried so a caller can report it. */
  interventionId?: string;
  action: ResolutionAction;
  /** For `outcome`: the artifact outcome id the operator judged this to be. */
  outcomeId?: string;
  note?: string;
  by: string;
  at: string;
}

export interface OperatorActionRecord {
  at: string;
  kind: ActionRequest['kind'];
  target?: string;
  /** Never the value itself: operators type credentials and member data. */
  valueShape?: string;
  allowed: boolean;
  reason?: string;
}

export interface Intervention {
  id: string;
  reason: StuckReason;
  detail: string;
  context: InterventionContext;
  createdAt: string;
  state: 'pending' | 'claimed' | 'resolved' | 'expired';
  claimedBy?: string;
  leaseExpiresAt?: string;
  resolution?: InterventionResolution;
  operatorActions: OperatorActionRecord[];
}

export class NotControllerError extends Error {
  constructor(actor: string, controller: Controller) {
    super(`${actor} tried to act while control is held by ${controller}`);
    this.name = 'NotControllerError';
  }
}

export class EscalationTimeout extends Error {
  constructor(readonly interventionId: string) {
    super(`no operator resolved intervention ${interventionId} before its lease expired`);
    this.name = 'EscalationTimeout';
  }
}

/** The control token. Exactly one actor holds it at a time. */
export class SessionControl {
  private controller: Controller = 'automation';
  private heldFor?: string;

  get current(): Controller {
    return this.controller;
  }

  get interventionId(): string | undefined {
    return this.heldFor;
  }

  cedeToOperator(interventionId: string): void {
    this.controller = 'operator';
    this.heldFor = interventionId;
  }

  returnToAutomation(): void {
    this.controller = 'automation';
    this.heldFor = undefined;
  }

  assert(actor: Controller): void {
    if (this.controller !== actor) throw new NotControllerError(actor, this.controller);
  }
}

export interface BrokerOptions {
  driver: SurfaceDriver;
  policy: PolicyEngine;
  recorder: RunRecorder;
  /** How long an unclaimed or unattended intervention survives. */
  leaseMs?: number;
  /** Total wait before the run gives up on a human. */
  maxWaitMs?: number;
  /** Auto-resolver for unattended runs. Returns null to wait for a real human. */
  autoResolver?: (i: Intervention) => Promise<InterventionResolution | null>;
  /** Where an operator can attach a full browser UI to the same session. */
  liveSessionUrl?: string;
}

export class EscalationBroker {
  readonly control = new SessionControl();
  private readonly interventions = new Map<string, Intervention>();
  private readonly waiters = new Map<string, (r: InterventionResolution) => void>();
  private readonly leaseMs: number;
  private readonly maxWaitMs: number;

  constructor(private readonly deps: BrokerOptions) {
    this.leaseMs = deps.leaseMs ?? 5 * 60_000;
    this.maxWaitMs = deps.maxWaitMs ?? 15 * 60_000;
  }

  list(): Intervention[] {
    return [...this.interventions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Intervention | undefined {
    return this.interventions.get(id);
  }

  get liveSessionUrl(): string | undefined {
    return this.deps.liveSessionUrl;
  }

  /**
   * Raise an intervention and block until a human resolves it.
   *
   * Control is ceded before this returns to its caller's await, so from the
   * moment the request exists the automation can no longer touch the page.
   */
  async raise(reason: StuckReason, detail: string, context: InterventionContext): Promise<InterventionResolution> {
    const id = `int-${randomUUID().slice(0, 8)}`;
    const intervention: Intervention = {
      id,
      reason,
      detail,
      context,
      createdAt: new Date().toISOString(),
      state: 'pending',
      operatorActions: [],
    };
    this.interventions.set(id, intervention);
    this.control.cedeToOperator(id);

    this.deps.recorder.event('escalation.raised', {
      interventionId: id,
      reason,
      detail,
      stepId: context.stepId,
      expected: context.expected,
      observed: context.observed,
      askedToDo: context.askedToDo,
      screenshot: context.screenshotPath,
      liveSessionUrl: this.deps.liveSessionUrl,
    });

    if (this.deps.autoResolver) {
      const auto = await this.deps.autoResolver(intervention);
      if (auto) return this.applyResolution(id, auto);
    }

    const resolution = await new Promise<InterventionResolution>((resolve, reject) => {
      this.waiters.set(id, resolve);
      const timer = setTimeout(() => {
        if (this.interventions.get(id)?.state === 'resolved') return;
        intervention.state = 'expired';
        this.waiters.delete(id);
        this.control.returnToAutomation();
        this.deps.recorder.event('escalation.raised', { interventionId: id, note: 'lease expired with no resolution' });
        reject(new EscalationTimeout(id));
      }, this.maxWaitMs);
      timer.unref?.();
    });

    return resolution;
  }

  // -- operator side -------------------------------------------------------

  claim(id: string, by: string): Intervention {
    const i = this.require(id);
    if (i.state === 'resolved' || i.state === 'expired') throw new Error(`intervention ${id} is ${i.state}`);
    i.state = 'claimed';
    i.claimedBy = by;
    i.leaseExpiresAt = new Date(Date.now() + this.leaseMs).toISOString();
    this.control.cedeToOperator(id);
    this.deps.recorder.event('escalation.granted', { interventionId: id, operator: by, leaseExpiresAt: i.leaseExpiresAt });
    return i;
  }

  heartbeat(id: string): Intervention {
    const i = this.require(id);
    i.leaseExpiresAt = new Date(Date.now() + this.leaseMs).toISOString();
    return i;
  }

  /** The live session, as the operator currently sees it. */
  async observeForOperator(id: string): Promise<Observation> {
    this.requireClaimed(id);
    return this.deps.driver.observe();
  }

  async screenshotForOperator(id: string): Promise<Buffer> {
    this.requireClaimed(id);
    return this.deps.driver.screenshot({ maskSensitive: true });
  }

  /**
   * Perform an action on the live session on the operator's behalf.
   *
   * Same gate, same recorder, same driver as the agent - only the actor differs.
   */
  async operatorAct(
    id: string,
    req: { kind: 'click' | 'fill' | 'select' | 'press' | 'navigate'; handle?: string; value?: string; url?: string; key?: string },
  ): Promise<{ ok: boolean; reason?: string }> {
    const i = this.requireClaimed(id);
    this.control.assert('operator');

    const obs = await this.deps.driver.observe();
    const control: Control | undefined = req.handle ? obs.controls.find((c) => c.handle === req.handle) : undefined;
    if (!control && req.kind !== 'navigate' && req.kind !== 'press') {
      return { ok: false, reason: `control ${req.handle} is no longer on screen` };
    }

    const actionRequest: ActionRequest = {
      kind: req.kind,
      actor: 'operator',
      url: req.url,
      ref: control ? { role: control.role, name: control.name } : undefined,
    };
    const decision = this.deps.policy.authorize(actionRequest);

    const record: OperatorActionRecord = {
      at: new Date().toISOString(),
      kind: req.kind,
      target: control ? `${control.role}:"${control.name}"` : req.url ?? req.key,
      valueShape: req.value === undefined ? undefined : `${req.value.length} chars`,
      allowed: decision.allow,
      reason: decision.reason,
    };
    i.operatorActions.push(record);
    // `record.kind` is the action kind, which must not collide with the event
    // kind, or every operator action lands in the log labelled as a click.
    const { kind: actionKind, ...rest } = record;
    this.deps.recorder.event('operator.action', {
      interventionId: id,
      operator: i.claimedBy,
      action: actionKind,
      ...rest,
      risk: decision.risk,
    });

    if (!decision.allow) return { ok: false, reason: decision.reason };

    try {
      switch (req.kind) {
        case 'navigate':
          // The gate rejects a navigation without a valid url, so by here it
          // has one.
          await this.deps.driver.navigate(req.url!);
          break;
        case 'press':
          await this.deps.driver.press(req.key ?? 'Enter', control ? await this.resolveControl(control) : undefined);
          break;
        case 'click':
          await this.deps.driver.click(await this.resolveControl(control!));
          break;
        case 'fill':
          await this.deps.driver.fill(await this.resolveControl(control!), req.value ?? '');
          break;
        case 'select':
          await this.deps.driver.select(await this.resolveControl(control!), req.value ?? '');
          break;
      }
      this.deps.policy.assertLocationAllowed(this.deps.driver.currentUrl());
      return { ok: true };
    } catch (err) {
      this.deps.recorder.event('action.failed', { interventionId: id, actor: 'operator', error: String(err) });
      return { ok: false, reason: String(err) };
    }
  }

  private async resolveControl(control: Control) {
    // Round-trips through the same ladder the engine uses, so an operator's
    // click is recorded against a durable ref rather than a raw handle.
    return this.deps.driver.resolve({
      role: control.role,
      name: control.name || undefined,
      scope: {
        frame: control.framePath[control.framePath.length - 1],
        section: control.section,
      },
      ordinal: control.ordinal,
      hints: control.hints,
    });
  }

  resolve(id: string, resolution: InterventionResolution): Intervention {
    return this.applyResolutionSync(id, resolution);
  }

  private applyResolution(id: string, resolution: InterventionResolution): InterventionResolution {
    this.applyResolutionSync(id, resolution);
    return resolution;
  }

  private applyResolutionSync(id: string, resolution: InterventionResolution): Intervention {
    const i = this.require(id);
    i.state = 'resolved';
    i.resolution = { ...resolution, interventionId: id };
    resolution.interventionId = id;
    this.control.returnToAutomation();
    this.deps.recorder.event('escalation.resumed', {
      interventionId: id,
      action: resolution.action,
      outcomeId: resolution.outcomeId,
      by: resolution.by,
      note: resolution.note,
      operatorActionCount: i.operatorActions.length,
    });
    const waiter = this.waiters.get(id);
    if (waiter) {
      this.waiters.delete(id);
      waiter(resolution);
    }
    return i;
  }

  private require(id: string): Intervention {
    const i = this.interventions.get(id);
    if (!i) throw new Error(`no intervention ${id}`);
    return i;
  }

  private requireClaimed(id: string): Intervention {
    const i = this.require(id);
    if (i.state !== 'claimed') throw new Error(`intervention ${id} must be claimed before acting (state: ${i.state})`);
    if (i.leaseExpiresAt && Date.parse(i.leaseExpiresAt) < Date.now()) {
      i.state = 'expired';
      this.control.returnToAutomation();
      throw new Error(`lease on intervention ${id} has expired`);
    }
    return i;
  }
}
