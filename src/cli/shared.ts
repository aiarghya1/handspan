/**
 * Wiring shared by every command.
 *
 * The dependency graph is assembled here and nowhere else: driver, policy,
 * recorder, broker, console. Keeping it in one place is what lets `discover`
 * and `replay` be genuinely the same system - same perception, same guardrail,
 * same escalation path - rather than two programs that happen to share a
 * schema.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { WebSurfaceDriver } from '../surface/web/driver.js';
import { tryResolveFromControls } from '../surface/match.js';
import { loadAppProfile, type AppProfile } from '../artifact/app-profile.js';
import { EnvSecretResolver } from '../artifact/template.js';
import { RunRecorder } from '../obs/recorder.js';
import { DEFAULT_POLICY, PolicyEngine, type PolicyConfig } from '../policy/policy.js';
import { zStepAction } from '../artifact/schema.js';
import {
  EscalationBroker,
  type Intervention,
  type InterventionResolution,
} from '../escalation/broker.js';
import { startOperatorConsole, type ConsoleHandle } from '../escalation/console.js';

const zPolicyFile = z
  .object({
    allowedOrigins: z.array(z.string()).default([]),
    allowedPathPrefixes: z.array(z.string()).default([]),
    allowedActions: z.array(zStepAction).optional(),
    irreversiblePatterns: z.array(z.string()).optional(),
    reversibleWritePatterns: z.array(z.string()).optional(),
    onIrreversible: z.enum(['block', 'escalate', 'allow']).optional(),
    operatorMayCommit: z.boolean().optional(),
    maxSteps: z.number().int().positive().optional(),
    maxDurationMs: z.number().int().positive().optional(),
    sensitivePatterns: z.array(z.string()).optional(),
  })
  .strict();

export function loadPolicyConfig(path = 'config/policy.yaml'): PolicyConfig {
  const raw = zPolicyFile.parse(YAML.parse(readFileSync(path, 'utf8')));
  return {
    ...DEFAULT_POLICY,
    ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)),
  } as PolicyConfig;
}

/**
 * Where an app's profile lives, by convention: the first segment of its id.
 * Overridable with --app-profile when a deployment organizes them differently.
 */
export function appProfilePathFor(appId: string): string {
  return `config/apps/${appId.split('-')[0]}.app.yaml`;
}

export function resolveTenant(app: AppProfile, tenant: string): { tenant: string; baseUrl: string } {
  const cfg = app.tenants[tenant];
  if (!cfg) {
    throw new Error(
      `tenant "${tenant}" is not in the app profile for ${app.id}. Known: ${Object.keys(app.tenants).join(', ')}`,
    );
  }
  return { tenant, baseUrl: cfg.baseUrl };
}

export interface SessionOptions {
  kind: 'discovery' | 'replay';
  app: AppProfile;
  policyConfig: PolicyConfig;
  headless?: boolean;
  verbose?: boolean;
  /** Serve the operator console on this port for the life of the run. */
  operatorPort?: number;
  /** Attach a simulated operator so escalations resolve without a human. */
  autoOperator?: boolean;
  /** Expose CDP so a human can attach a full browser to the same session. */
  debugPort?: number;
  runId?: string;
}

/**
 * How a command obtains a live session. Injected so the commands can be tested
 * without launching a browser, and so nothing in this directory has a hard
 * dependency on Playwright.
 */
export type SessionFactory = (opts: SessionOptions) => Promise<Session>;

export interface Session {
  driver: WebSurfaceDriver;
  recorder: RunRecorder;
  policy: PolicyEngine;
  broker: EscalationBroker;
  /**
   * True when there is somewhere for an intervention to actually go - a console
   * a person can open, or a simulated operator. When false, callers pass no
   * broker, so a stuck run reports the real failure class instead of waiting
   * out a lease and reporting `escalation_timeout` to nobody.
   */
  hasOperator: boolean;
  secrets: EnvSecretResolver;
  console?: ConsoleHandle;
  close(): Promise<void>;
}

/**
 * A stand-in operator for unattended runs.
 *
 * It is not a stub that rubber-stamps: it claims the intervention, performs the
 * exact action the automation was refused, and hands control back - all through
 * the broker's real API and the real policy gate. So an unattended demo
 * exercises the whole handoff, and the run log shows a simulated operator
 * rather than pretending a person was there.
 */
export function createSimulatedOperator(
  getBroker: () => EscalationBroker,
  name = 'simulated-operator',
): (i: Intervention) => Promise<InterventionResolution | null> {
  return async (intervention: Intervention): Promise<InterventionResolution> => {
    const broker = getBroker();
    broker.claim(intervention.id, name);
    const intended = intervention.context.intendedAction;

    if (intended?.ref) {
      const obs = await broker.observeForOperator(intervention.id);
      const found = tryResolveFromControls(intended.ref, obs.controls);
      if (found) {
        const done = await broker.operatorAct(intervention.id, {
          kind: intended.kind,
          handle: found.control.handle,
          value: intended.value,
        });
        return {
          action: done.ok ? 'resume' : 'abort',
          by: name,
          at: new Date().toISOString(),
          note: done.ok
            ? `performed ${intended.kind} on ${intended.ref.role} "${intended.ref.name ?? ''}" and handed control back`
            : `could not perform the requested action: ${done.reason}`,
        };
      }
      return {
        action: 'abort',
        by: name,
        at: new Date().toISOString(),
        note: `the control the agent asked for is no longer on screen`,
      };
    }

    return {
      action: 'abort',
      by: name,
      at: new Date().toISOString(),
      note: 'a simulated operator cannot resolve this; a person is needed',
    };
  };
}

export async function openSession(opts: SessionOptions): Promise<Session> {
  const policyConfig: PolicyConfig = {
    ...opts.policyConfig,
    allowedPathPrefixes:
      opts.policyConfig.allowedPathPrefixes.length > 0
        ? opts.policyConfig.allowedPathPrefixes
        : opts.app.policy.allowedPathPrefixes,
    sensitivePatterns: [
      ...new Set([...opts.policyConfig.sensitivePatterns, ...opts.app.policy.sensitivePatterns]),
    ],
  };

  const recorder = new RunRecorder({ kind: opts.kind, verbose: opts.verbose, runId: opts.runId });
  const policy = new PolicyEngine(policyConfig);

  const driver = await WebSurfaceDriver.launch({
    headless: opts.headless ?? true,
    sensitivePatterns: policyConfig.sensitivePatterns.map((p) => new RegExp(p)),
    remoteDebuggingPort: opts.debugPort,
  });

  // Port 0 means "pick a free one", so presence is tested explicitly rather
  // than for truthiness.
  const hasOperator = opts.operatorPort !== undefined || Boolean(opts.autoOperator);

  let broker!: EscalationBroker;
  broker = new EscalationBroker({
    driver,
    policy,
    recorder,
    liveSessionUrl: opts.debugPort === undefined ? undefined : `http://localhost:${opts.debugPort}`,
    autoResolver: opts.autoOperator ? createSimulatedOperator(() => broker) : undefined,
    // Without a console there is nobody to answer, so do not hang the run.
    maxWaitMs: hasOperator ? 15 * 60_000 : 5_000,
  });

  const consoleHandle = opts.operatorPort === undefined ? undefined : await startOperatorConsole(broker, opts.operatorPort);
  if (consoleHandle) {
    process.stderr.write(`\n  operator console: ${consoleHandle.url}\n\n`);
  }

  return {
    driver,
    recorder,
    policy,
    broker,
    hasOperator,
    secrets: new EnvSecretResolver(),
    console: consoleHandle,
    async close() {
      await consoleHandle?.close();
      await driver.close();
    },
  };
}
