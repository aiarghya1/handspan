/**
 * The agent-facing view of the catalog.
 *
 * A saved artifact already contains everything a calling agent needs - a
 * summary written for it, typed parameters, typed returns, and the enumerated
 * outcomes it might get back - so the tool definition is a projection of the
 * artifact rather than a second thing to maintain. Nobody writes a tool schema
 * by hand; if the capability's contract changes, the tool changes with it.
 *
 * Two deliberate choices in what gets projected.
 *
 * The description tells the agent what it will get *back*, including each named
 * business outcome. An agent that knows `MEMBER_NOT_FOUND` is a possible answer
 * writes different code from one that only knows the call can fail.
 *
 * Capabilities that are not cleared for unattended use are still listed, but
 * marked, and the invoke path refuses them. Hiding them would make an approval
 * queue invisible; letting them run would make approval decorative.
 */

import type { Capability, ParamSpec } from '../artifact/schema.js';
import { isApprovedForUnattended } from '../artifact/store.js';

export interface CapabilityTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
  /** Not part of the tool contract; shown in the catalog listing. */
  handspan: {
    capabilityId: string;
    version: string;
    riskTier: string;
    invocable: boolean;
    invocableReason?: string;
    returns: Record<string, { type: string; description: string; sensitivity: string }>;
    outcomes: Array<{ id: string; description: string; disposition: string }>;
    stability: { runs: number; successes: number };
  };
}

/** Total over the declared value types, so there is no fallback to get wrong. */
const JSON_TYPE: Record<ParamSpec['type'], string> = {
  string: 'string',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
  money: 'number',
  date: 'string',
};

export function toolForCapability(cap: Capability): CapabilityTool {
  const approval = isApprovedForUnattended(cap);

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, p] of Object.entries(cap.params)) {
    const schema: Record<string, unknown> = {
      type: JSON_TYPE[p.type],
      description: p.sensitivity === 'none' ? p.description : `${p.description} (${p.sensitivity})`,
    };
    if (p.pattern) schema['pattern'] = p.pattern;
    if (p.enum) schema['enum'] = p.enum;
    if (p.minimum !== undefined) schema['minimum'] = p.minimum;
    if (p.maximum !== undefined) schema['maximum'] = p.maximum;
    properties[name] = schema;
    if (p.required) required.push(name);
  }

  const returnLines = Object.entries(cap.returns).map(
    ([n, r]) => `  ${n} (${r.type}): ${r.description}`,
  );
  const outcomeLines = cap.outcomes
    .filter((o) => o.disposition === 'return')
    .map((o) => `  ${o.id}: ${o.description}`);

  const description = [
    cap.summary,
    '',
    `Returns on success:`,
    ...(returnLines.length > 0 ? returnLines : ['  (no values)']),
    ...(outcomeLines.length > 0
      ? ['', 'May instead return one of these business outcomes, which are answers rather than errors:', ...outcomeLines]
      : []),
    '',
    `Risk tier: ${cap.policy.riskTier}.${cap.policy.riskTier === 'irreversible' ? ' This capability commits changes that cannot be undone from the screen.' : ''}`,
    approval.ok ? '' : `Not currently invocable: ${approval.reason}.`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  return {
    name: cap.id.replace(/\./g, '__'),
    description,
    input_schema: { type: 'object', properties, required, additionalProperties: false },
    handspan: {
      capabilityId: cap.id,
      version: cap.version,
      riskTier: cap.policy.riskTier,
      invocable: approval.ok,
      invocableReason: approval.reason,
      returns: Object.fromEntries(
        Object.entries(cap.returns).map(([n, r]) => [n, { type: r.type, description: r.description, sensitivity: r.sensitivity }]),
      ),
      outcomes: cap.outcomes.map((o) => ({ id: o.id, description: o.description, disposition: o.disposition })),
      stability: { runs: cap.provenance.stability.runs, successes: cap.provenance.stability.successes },
    },
  };
}
