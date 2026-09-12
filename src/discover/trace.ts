/**
 * What a discovery run records.
 *
 * The trace is deliberately not the model transcript. A transcript is a record
 * of a conversation; this is a record of what was done to the application, with
 * each action already expressed in the durable vocabulary the artifact uses.
 * The ControlRef is derived at the moment of the action, while the full
 * observation is still in hand, because that is the only time we know what else
 * was on screen and therefore what the minimum unambiguous ref is.
 *
 * Keeping these separate is what lets the compiler be a pure function and lets
 * the artifact be reviewed without reading the model's reasoning.
 */

import type { ControlRef, LocatorTier } from '../surface/types.js';
import type { Phase, Risk } from '../artifact/schema.js';

export interface TraceEntry {
  seq: number;
  at: string;
  action: 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'extract';
  intent: string;
  phase: Phase;
  risk: Risk;

  ref?: ControlRef;
  resolvedTier?: LocatorTier;

  /** Raw typed value. Never persisted when `secretKey` is set. */
  value?: string;
  /** Set when the value came from a declared goal parameter. */
  parameter?: string;
  /** Set when the value came from the vault; the value itself is not recorded. */
  secretKey?: string;
  url?: string;
  key?: string;

  /** The model's stated post-condition, turned into a checkpoint by the compiler. */
  expect?: string;

  extract?: {
    as: string;
    /** Which return this satisfies. */
    source: { kind: 'control'; ref: ControlRef } | { kind: 'text'; pattern: string };
    /** The value read during discovery, used only to sanity-check the recording. */
    sampleShape?: string;
  };

  /**
   * Ids of app-level recoveries whose trigger condition held on screen at the
   * moment of this action.
   *
   * This is what lets the compiler tell "the agent is dismissing the
   * maintenance notice, which a recovery also handles" apart from "the agent is
   * clicking a button that merely happens to be called Continue". Comparing
   * references alone cannot: both are a button named Continue.
   */
  triggeredRecoveries?: string[];

  /** True when an operator performed this action instead of the agent. */
  humanAssisted?: boolean;
  urlAfter?: string;
  sectionAfter?: string;
}

export interface DeclaredOutcome {
  id: string;
  description: string;
  whenText: string;
  disposition: 'return' | 'escalate';
}

export interface DiscoveryTrace {
  goalId: string;
  goal: string;
  model: string;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  entries: TraceEntry[];
  declaredOutcomes: DeclaredOutcome[];
  summary?: string;
  successText?: string;
  humanAssisted: boolean;
  blockedActions: number;
  turns: number;
}

/**
 * A fresh, empty trace. Lives here rather than inline in the agent so the
 * shape and its initial state are defined in one place.
 */
export function newTrace(init: { goalId: string; goal: string; model: string; runId: string }): DiscoveryTrace {
  return {
    ...init,
    startedAt: new Date().toISOString(),
    entries: [],
    declaredOutcomes: [],
    humanAssisted: false,
    blockedActions: 0,
    turns: 0,
  };
}

/** What a trace did, in one line, for a run summary. */
export function summarizeTrace(trace: DiscoveryTrace): string {
  const actions = trace.entries.length;
  const human = trace.humanAssisted ? ', human-assisted' : '';
  return `${actions} action${actions === 1 ? '' : 's'} over ${trace.turns} turn${trace.turns === 1 ? '' : 's'}, ${trace.blockedActions} blocked${human}`;
}
