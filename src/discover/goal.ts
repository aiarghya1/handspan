/**
 * The discovery request.
 *
 * The public contract of a capability - its parameters, its return values,
 * their types and their sensitivity - is declared by a person here, not
 * invented by the model. That is a deliberate limit on what discovery is for.
 *
 * The model's job is the genuinely hard part: working out which screens to
 * visit and which controls to drive. The interface an AI agent will later bind
 * to, and the classification of which returned fields are regulated data, is a
 * design decision with compliance consequences, and it is cheap for a human to
 * write and expensive to get silently wrong.
 *
 * A useful side effect: because the parameter *values* are supplied here, the
 * compiler can tell the difference between a value the model typed because the
 * goal supplied it (parameterize it) and a value the model typed because the
 * screen required it (keep it literal).
 */

import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { zParamSpec, zReturnSpec } from '../artifact/schema.js';

export const zGoalSpec = z
  .object({
    /** Becomes the capability id. */
    id: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/),
    title: z.string().min(1),
    /** The description a calling agent will see. */
    summary: z.string().min(1),
    /** The natural-language instruction handed to the model. */
    goal: z.string().min(10),

    app: z.string().min(1),
    tenant: z.string().min(1),
    entryPath: z.string().default('/'),

    /** Declared inputs, each with the concrete value to use for this run. */
    params: z.record(zParamSpec.extend({ value: z.string() })).default({}),
    returns: z.record(zReturnSpec).default({}),

    /** Extra vault keys beyond the app profile's sign-on secrets. */
    secrets: z.array(z.string()).default([]),

    maxSteps: z.number().int().positive().max(80).default(30),
  })
  .strict();

export type GoalSpec = z.output<typeof zGoalSpec>;

export function loadGoalSpec(path: string): GoalSpec {
  return zGoalSpec.parse(YAML.parse(readFileSync(path, 'utf8')));
}
