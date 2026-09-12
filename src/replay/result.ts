/**
 * The replay result contract.
 *
 * This is the API an AI agent actually programs against, and the three-way
 * split at the top is the most important decision in the whole system.
 *
 *   success          the flow completed and here are the typed outputs
 *   business_outcome the flow completed and the answer is "no such member" -
 *                    an answer, not an error, with a stable machine-readable id
 *   escalated        a person was brought in and the run did not finish
 *                    unattended; the caller is told who holds it and why
 *   failed           something is wrong with the automation or the app, with
 *                    enough detail to debug it without re-running
 *
 * Collapsing `business_outcome` into `failed` is the mistake the brief warns
 * about, and it is not merely untidy: a calling agent that cannot distinguish
 * "this member does not exist" from "the automation is broken" will either
 * retry forever or tell a member their account is missing when the truth is
 * that a selector moved.
 *
 * Recoverable conditions are deliberately *not* a status. A dismissed
 * interstitial or a re-authenticated session is an implementation detail of a
 * successful run; it appears in `recoveries` for observability and changes
 * nothing about what the caller does next.
 */

import type { LocatorTier } from '../surface/types.js';

export type ReplayStatus = 'success' | 'business_outcome' | 'escalated' | 'failed';

export type FailureClass =
  /** The artifact did not pass static validation; nothing was executed. */
  | 'invalid_artifact'
  /** Supplied inputs did not satisfy the declared parameter schema. */
  | 'invalid_input'
  /** Unattended replay of an artifact that needs approval it does not have. */
  | 'not_approved'
  /** A ref matched nothing at any tier. */
  | 'target_not_found'
  /** A ref matched several controls and had no ordinal to choose with. */
  | 'ambiguous_target'
  /** The step ran but the screen it should have produced never appeared. */
  | 'checkpoint_failed'
  /** A step's precondition never became true. */
  | 'precondition_failed'
  /** The app reported an internal error. */
  | 'app_error'
  /** The session expired and re-authentication did not recover it. */
  | 'session_expired'
  /** An action tried to leave the allowlist, or was otherwise refused. */
  | 'policy_blocked'
  /** A human was asked for help and did not arrive in time. */
  | 'escalation_timeout'
  /** The browser or adapter itself failed. */
  | 'driver_error'
  /** A step budget or wall-clock budget was exhausted. */
  | 'budget_exhausted';

export interface StepReport {
  stepId: string;
  intent: string;
  action: string;
  status: 'ok' | 'skipped' | 'recovered' | 'failed';
  durationMs: number;
  /** Tier the target resolved at, against the tier recorded at discovery. */
  resolvedTier?: LocatorTier;
  recordedTier?: LocatorTier;
  /** True when this step resolved less confidently than when it was recorded. */
  degraded?: boolean;
  checkpoint?: { ok: boolean; expected: string; observed: string; waitedMs: number };
  note?: string;
}

export interface RecoveryReport {
  recoveryId: string;
  atStepId: string;
  trigger: string;
  appliedCount: number;
  succeeded: boolean;
}

export interface ReplayFailure {
  class: FailureClass;
  message: string;
  stepId?: string;
  stepIntent?: string;
  expected?: string;
  observed?: string;
  /** Paths under the run directory. */
  screenshot?: string;
  snapshot?: string;
}

export interface ReplayEvidence {
  runId: string;
  directory: string;
  log: string;
  screenshots: string[];
}

export interface ReplayResultBase {
  capabilityId: string;
  capabilityVersion: string;
  tenant?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepReport[];
  recoveries: RecoveryReport[];
  /** Steps that resolved below their recorded tier: the drift alarm. */
  degradedSteps: string[];
  evidence: ReplayEvidence;
}

export interface ReplaySuccess extends ReplayResultBase {
  status: 'success';
  outputs: Record<string, unknown>;
}

export interface ReplayBusinessOutcome extends ReplayResultBase {
  status: 'business_outcome';
  outcome: { id: string; description: string; detail: string; data: Record<string, unknown> };
}

export interface ReplayEscalated extends ReplayResultBase {
  status: 'escalated';
  escalation: {
    interventionId: string;
    reason: string;
    resolvedBy?: string;
    resolution?: string;
    note?: string;
  };
  outputs?: Record<string, unknown>;
}

export interface ReplayFailed extends ReplayResultBase {
  status: 'failed';
  failure: ReplayFailure;
  /** Whatever was successfully extracted before the failure. */
  partialOutputs?: Record<string, unknown>;
}

export type ReplayResult = ReplaySuccess | ReplayBusinessOutcome | ReplayEscalated | ReplayFailed;

/** One line a human (or an agent's log) can read to know what happened. */
export function describeResult(r: ReplayResult): string {
  switch (r.status) {
    case 'success':
      return `success: ${Object.keys(r.outputs).length} output(s) in ${r.durationMs}ms`;
    case 'business_outcome':
      return `business outcome ${r.outcome.id}: ${r.outcome.detail}`;
    case 'escalated':
      return `escalated (${r.escalation.reason}) -> ${r.escalation.resolution ?? 'unresolved'}`;
    case 'failed':
      return `failed [${r.failure.class}] at ${r.failure.stepId ?? 'setup'}: ${r.failure.message}`;
  }
}
