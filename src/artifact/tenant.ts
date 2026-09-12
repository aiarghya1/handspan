/**
 * Tenant specialization.
 *
 * Hundreds of tenants run roughly twenty applications, and many of them run the
 * same vendor product with different labels. One artifact per flow with
 * per-tenant specialization is the only shape that scales; re-recording a flow
 * per tenant is not.
 *
 * The aliases are applied through `mapAllRefs`, which walks *every* reference in
 * the artifact - steps, checkpoints, preconditions, outcome detection, recovery
 * triggers and recovery actions. Rewriting only step refs leaves checkpoints
 * pointing at the other tenant's labels, which fails in the most confusing
 * possible way: the action works and the verification does not.
 */

import type { Condition, ControlRef } from '../surface/types.js';
import type { Capability, Step } from './schema.js';

// -- ref traversal ----------------------------------------------------------

function mapConditionRefs(c: Condition, fn: (r: ControlRef) => ControlRef): Condition {
  switch (c.kind) {
    case 'controlPresent':
    case 'controlAbsent':
      return { ...c, ref: fn(c.ref) };
    case 'valueMatches':
      return { ...c, ref: fn(c.ref) };
    case 'allOf':
    case 'anyOf':
      return { ...c, of: c.of.map((x) => mapConditionRefs(x, fn)) };
    case 'not':
      return { ...c, of: mapConditionRefs(c.of, fn) };
    default:
      return c;
  }
}

/** Every ControlRef the artifact contains, wherever it appears. */
export function mapAllRefs(cap: Capability, fn: (r: ControlRef) => ControlRef): Capability {
  const step = (s: Step): Step => ({
    ...s,
    ref: s.ref ? fn(s.ref) : undefined,
    waitFor: s.waitFor ? mapConditionRefs(s.waitFor, fn) : undefined,
    checkpoint: s.checkpoint ? mapConditionRefs(s.checkpoint, fn) : undefined,
    extract:
      s.extract && s.extract.source.kind === 'control'
        ? { ...s.extract, source: { kind: 'control', ref: fn(s.extract.source.ref) } }
        : s.extract,
  });

  return {
    ...cap,
    steps: cap.steps.map(step),
    outcomes: cap.outcomes.map((o) => ({
      ...o,
      detect: mapConditionRefs(o.detect, fn),
      extract: o.extract.map((e) =>
        e.source.kind === 'control' ? { ...e, source: { kind: 'control', ref: fn(e.source.ref) } } : e,
      ),
    })),
    recoveries: cap.recoveries.map((r) => ({
      ...r,
      when: mapConditionRefs(r.when, fn),
      do: r.do.map((a) => ('ref' in a && a.ref ? { ...a, ref: fn(a.ref) } : a)),
    })),
  };
}

// -- tenant specialization --------------------------------------------------

export class TenantNotSupportedError extends Error {
  constructor(capabilityId: string, tenant: string) {
    super(`capability ${capabilityId} has no override for tenant "${tenant}" and was not recorded against it`);
    this.name = 'TenantNotSupportedError';
  }
}

/**
 * Resolve one shared artifact against a tenant.
 *
 * A capability recorded against tenant A runs unmodified for tenant A. For any
 * other tenant it runs only if there is an override, because silently pointing
 * a recorded flow at a different institution's build is exactly the class of
 * mistake that produces a wrong posting.
 *
 * `strict: false` relaxes that to "try it anyway and report the tier drift",
 * which is how a new tenant gets qualified: run it, watch which steps degrade,
 * write the aliases those steps need.
 */
export function specializeForTenant(
  cap: Capability,
  tenant: string | undefined,
  opts: { strict?: boolean } = {},
): { capability: Capability; override?: Capability['tenantOverrides'][number] } {
  // An artifact that does not say which tenant it was recorded against makes no
  // claim to protect, so there is no mismatch to fail closed on. The compiler
  // always records one; this covers a hand-written artifact.
  if (!tenant || !cap.app.recordedForTenant || tenant === cap.app.recordedForTenant) return { capability: cap };

  const override = cap.tenantOverrides.find((o) => o.tenant === tenant);
  if (!override) {
    if (opts.strict === false) return { capability: cap };
    throw new TenantNotSupportedError(cap.id, tenant);
  }

  let out: Capability = { ...cap, app: { ...cap.app, recordedForTenant: tenant } };

  if (override.entryUrlTemplate) out.entryUrlTemplate = override.entryUrlTemplate;
  if (override.allowedOrigins) out.policy = { ...out.policy, allowedOrigins: override.allowedOrigins };

  // Aliases apply to every label in every ref at once: the control's own name
  // and the section and row labels it is scoped by. This is the common case at
  // scale - the same vendor screen with two things relabelled - and handling it
  // as a label map keeps one artifact serving the whole estate instead of one
  // per institution.
  if (Object.keys(override.nameAliases).length > 0) {
    const aliases = new Map(
      Object.entries(override.nameAliases).map(([k, v]) => [k.toLowerCase().trim(), v]),
    );
    const alias = (v: string | undefined): string | undefined =>
      v === undefined ? v : (aliases.get(v.toLowerCase().trim()) ?? v);
    out = mapAllRefs(out, (r) => ({
      ...r,
      name: alias(r.name),
      scope: r.scope
        ? { ...r.scope, section: alias(r.scope.section), rowContaining: alias(r.scope.rowContaining) }
        : r.scope,
    }));
  }

  // Surgical patches for a control that genuinely moved rather than just got
  // renamed.
  if (override.refPatches.length > 0) {
    const byStep = new Map(override.refPatches.map((p) => [p.stepId, p.ref]));
    out = {
      ...out,
      steps: out.steps.map((s) => {
        const patch = byStep.get(s.id);
        return patch && s.ref ? { ...s, ref: { ...s.ref, ...patch } } : s;
      }),
    };
  }

  if (override.disabledSteps.length > 0) {
    const drop = new Set(override.disabledSteps);
    out = { ...out, steps: out.steps.filter((s) => !drop.has(s.id)) };
  }

  if (override.extraRecoveries.length > 0) {
    out = { ...out, recoveries: [...out.recoveries, ...override.extraRecoveries] };
  }

  return { capability: out, override };
}

// -- lint -------------------------------------------------------------------

