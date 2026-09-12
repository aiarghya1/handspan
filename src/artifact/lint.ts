/**
 * Static checks a reviewer would otherwise have to do by hand.
 *
 * Errors are blocking: replay refuses an artifact with any, before a browser is
 * opened. Warnings are review signals. The point of the split is that a bad
 * artifact costs milliseconds rather than a browser session and a confusing
 * timeout.
 */

import { createRedactor } from '../policy/redact.js';
import { templateReferences, templateTouchesSecret } from './template.js';
import { API_VERSION, type Capability, type Risk, type Step } from './schema.js';
import { computeContentHash, maxRisk, riskRank } from './store.js';

export interface LintFinding {
  severity: 'error' | 'warn';
  code: string;
  message: string;
  stepId?: string;
}

/**
 * Static checks a reviewer would otherwise have to do by hand. Errors are
 * blocking: `handspan replay` refuses to run an artifact with any.
 */
export function lintCapability(cap: Capability): LintFinding[] {
  const findings: LintFinding[] = [];
  const redactor = createRedactor();
  const err = (code: string, message: string, stepId?: string) =>
    findings.push({ severity: 'error', code, message, stepId });
  const warn = (code: string, message: string, stepId?: string) =>
    findings.push({ severity: 'warn', code, message, stepId });

  if (cap.apiVersion !== API_VERSION) err('api-version', `unexpected apiVersion ${cap.apiVersion}`);

  const ids = new Set<string>();
  for (const s of cap.steps) {
    if (ids.has(s.id)) err('duplicate-step-id', `step id "${s.id}" appears more than once`, s.id);
    ids.add(s.id);
  }

  const outcomeIds = new Set<string>();
  for (const o of cap.outcomes) {
    if (outcomeIds.has(o.id)) err('duplicate-outcome-id', `outcome "${o.id}" appears more than once`);
    outcomeIds.add(o.id);
    for (const after of o.checkAfter) {
      if (!ids.has(after)) warn('unknown-step-ref', `outcome ${o.id} checks after unknown step "${after}"`);
    }
  }

  // Templates must only reference declared parameters, declared secrets, and
  // outputs that an earlier step actually produces.
  const producedBy = new Map<string, number>();
  cap.steps.forEach((s, i) => {
    if (s.extract) producedBy.set(s.extract.as, i);
  });
  // Outcome extracts populate the outcome's own `data`, not the capability's
  // declared returns, so they are readable by templates but are not expected to
  // appear in `returns`.
  const outcomeData = new Set<string>();
  for (const o of cap.outcomes) for (const e of o.extract) outcomeData.add(e.as);

  cap.steps.forEach((s, i) => {
    for (const tmpl of [s.value, s.url].filter((v): v is string => typeof v === 'string')) {
      for (const ref of templateReferences(tmpl)) {
        if (ref === 'baseUrl') continue;
        if (ref.startsWith('secret:')) {
          const key = ref.slice(7);
          if (!cap.secrets.includes(key)) {
            err('undeclared-secret', `step ${s.id} uses secret "${key}" which is not in secrets[]`, s.id);
          }
          continue;
        }
        if (ref.startsWith('out:')) {
          const key = ref.slice(4);
          const at = producedBy.get(key);
          if (at === undefined && !outcomeData.has(key)) {
            err('unknown-output-ref', `step ${s.id} reads unproduced output "${key}"`, s.id);
          } else if (at !== undefined && at >= i) {
            err('forward-output-ref', `step ${s.id} reads output "${key}" produced later`, s.id);
          }
          continue;
        }
        if (!(ref in cap.params)) {
          err('undeclared-param', `step ${s.id} references undeclared parameter "${ref}"`, s.id);
        }
      }
    }

    // A literal that looks like regulated data means discovery baked a real
    // value into the artifact instead of parameterizing it.
    for (const literal of [s.value, s.url].filter((v): v is string => typeof v === 'string')) {
      if (/\{\{/.test(literal)) continue;
      const hits = redactor.findings(literal);
      if (hits.length > 0) {
        err('literal-sensitive-value', `step ${s.id} has a literal matching ${hits.join(', ')}`, s.id);
      }
    }

    const mutates = s.action === 'click' || s.action === 'fill' || s.action === 'select' || s.action === 'press';
    // A credential field is write-only: there is nothing we are willing to read
    // back off it, so the absence of a checkpoint is correct rather than a gap.
    const writeOnly = templateTouchesSecret(s.value);
    if (mutates && !s.checkpoint && !s.optional && !writeOnly) {
      warn('unverified-step', `step ${s.id} (${s.action}) has no checkpoint, so replay cannot prove it worked`, s.id);
    }
    if (s.action === 'extract' && !s.extract) err('extract-without-spec', `step ${s.id} extracts nothing`, s.id);
    if (s.action === 'navigate' && !s.url) err('navigate-without-url', `step ${s.id} has no url`, s.id);
    if (s.ref === undefined && ['click', 'fill', 'select'].includes(s.action)) {
      err('action-without-target', `step ${s.id} (${s.action}) has no ref`, s.id);
    }
  });

  // Declared returns must actually be produced somewhere.
  for (const [name, spec] of Object.entries(cap.returns)) {
    if (!producedBy.has(name) && spec.required) {
      err('unproduced-return', `returns.${name} is required but no step extracts it`);
    }
  }
  for (const [name] of producedBy) {
    if (!(name in cap.returns)) {
      warn('undeclared-return', `a step extracts "${name}" which is not declared in returns`);
    }
  }

  // Risk tier must dominate every step, and irreversible work should be gated.
  const worst = cap.steps.reduce<Risk>((acc, s) => maxRisk(acc, s.risk), 'read_only');
  if (riskRank(cap.policy.riskTier) < riskRank(worst)) {
    err('risk-understated', `policy.riskTier is ${cap.policy.riskTier} but a step is ${worst}`);
  }
  if (worst === 'irreversible' && !cap.policy.requiresApproval) {
    warn('ungated-irreversible', 'an irreversible step is present but requiresApproval is false');
  }
  for (const a of cap.steps.map((s) => s.action)) {
    if (!cap.policy.allowedActions.includes(a)) {
      err('action-not-allowed', `step action "${a}" is not in policy.allowedActions`);
    }
  }

  for (const [name, p] of Object.entries(cap.params)) {
    if (p.example && redactor.findings(p.example).length > 0) {
      warn('sensitive-example', `params.${name}.example looks like real data`);
    }
    if (p.sensitivity === 'secret') {
      err('secret-as-param', `params.${name} is a secret; use secrets[] and {{secret:...}} instead`);
    }
  }

  const phases = new Set(cap.steps.map((s) => s.phase));
  for (const r of cap.recoveries) {
    for (const a of r.do) {
      if (a.kind === 'replayFrom' && !phases.has(a.phase)) {
        warn('recovery-empty-phase', `recovery ${r.id} replays from phase "${a.phase}" which has no steps`);
      }
    }
  }

  if (cap.contentHash && cap.contentHash !== computeContentHash(cap)) {
    err('hash-mismatch', 'contentHash does not match the artifact body');
  }

  return findings;
}

export function lintErrors(findings: LintFinding[]): LintFinding[] {
  return findings.filter((f) => f.severity === 'error');
}
