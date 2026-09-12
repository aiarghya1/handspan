/**
 * Typed inputs and outputs.
 *
 * Inputs are validated before a browser is opened. That ordering matters for
 * more than tidiness: a malformed member number that reaches the screen comes
 * back as an application validation error, which is indistinguishable from a
 * genuine one, so a bad caller argument would be reported as a business
 * outcome. Checking the declared `pattern` up front keeps the two apart.
 *
 * Outputs are coerced to their declared type, so `money` reaches the caller as
 * a number rather than as whatever the grid cell happened to render.
 */

import type { ParamSpec, ReturnSpec } from '../artifact/schema.js';

export class InputValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`inputs are not valid: ${issues.join('; ')}`);
    this.name = 'InputValidationError';
  }
}

export function validateInputs(
  params: Record<string, ParamSpec>,
  supplied: Record<string, unknown>,
): Record<string, unknown> {
  const issues: string[] = [];
  const out: Record<string, unknown> = {};

  for (const [name, spec] of Object.entries(params)) {
    const raw = supplied[name];
    if (raw === undefined || raw === null || raw === '') {
      if (spec.required) issues.push(`"${name}" is required`);
      continue;
    }
    const s = String(raw);
    if (spec.pattern && !new RegExp(spec.pattern).test(s)) {
      // The pattern is echoed, never the value: parameters are often PII.
      issues.push(`"${name}" does not match ${spec.pattern}`);
      continue;
    }
    if (spec.enum && !spec.enum.includes(s)) {
      issues.push(`"${name}" must be one of ${spec.enum.join(', ')}`);
      continue;
    }
    if (spec.type === 'number' || spec.type === 'integer' || spec.type === 'money') {
      const n = Number(s);
      if (!Number.isFinite(n)) {
        issues.push(`"${name}" must be a number`);
        continue;
      }
      if (spec.type === 'integer' && !Number.isInteger(n)) {
        issues.push(`"${name}" must be an integer`);
        continue;
      }
      if (spec.minimum !== undefined && n < spec.minimum) issues.push(`"${name}" is below minimum ${spec.minimum}`);
      if (spec.maximum !== undefined && n > spec.maximum) issues.push(`"${name}" is above maximum ${spec.maximum}`);
      out[name] = s;
      continue;
    }
    out[name] = s;
  }

  const declared = new Set(Object.keys(params));
  for (const name of Object.keys(supplied)) {
    if (!declared.has(name)) issues.push(`"${name}" is not a declared parameter`);
  }

  if (issues.length > 0) throw new InputValidationError(issues);
  return out;
}

export type Transform = 'trim' | 'money' | 'integer' | 'number' | 'upper';

export function applyTransform(raw: string, transform: Transform): unknown {
  const t = raw.replace(/[\s ]+/g, ' ').trim();
  switch (transform) {
    case 'trim':
      return t;
    case 'upper':
      return t.toUpperCase();
    // A cell with no digits in it has no value, and must not become 0. A
    // balance silently read as zero is the worst possible extraction failure.
    case 'money':
    case 'number': {
      if (!/\d/.test(t)) return null;
      const n = Number(t.replace(/[^0-9.\-]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'integer': {
      // The digit guard is what makes the parse safe: a string containing a
      // digit always yields a number once the non-numeric characters are gone.
      if (!/\d/.test(t)) return null;
      return Number.parseInt(t.replace(/[^0-9\-]/g, ''), 10);
    }
  }
}

export function checkOutputs(
  returns: Record<string, ReturnSpec>,
  outputs: Record<string, unknown>,
): string[] {
  const issues: string[] = [];
  for (const [name, spec] of Object.entries(returns)) {
    const v = outputs[name];
    if (v === undefined || v === null) {
      if (spec.required) issues.push(`declared return "${name}" was not produced`);
      continue;
    }
    if ((spec.type === 'money' || spec.type === 'number' || spec.type === 'integer') && typeof v !== 'number') {
      issues.push(`return "${name}" should be a ${spec.type} but is ${typeof v}`);
    }
  }
  return issues;
}
