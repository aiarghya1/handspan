/**
 * App profile: the runtime conditions that belong to an application rather
 * than to any one flow.
 *
 * This split matters. A discovery run can only record the conditions it
 * happened to meet, and the happy path meets almost none of them - the model
 * will never see a session timeout in a ninety-second run. But "this app
 * signs you out after fifteen minutes and shows a red banner saying so" is a
 * fact about the app, true for all twenty capabilities recorded against it, and
 * it should be written down once.
 *
 * So runtime handling in a finished artifact comes from three places:
 *
 *   1. the app profile, merged in at compile time (session expiry, app aborts,
 *      entitlement denials, the maintenance interstitial)
 *   2. anything the model actually hit and declared during discovery
 *   3. anything a reviewer adds before approving it
 *
 * Only (1) scales. Writing these per capability would mean writing them
 * hundreds of times per tenant and getting them subtly wrong each time.
 */

import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { zOutcome, zRecovery, zStepAction } from './schema.js';

export const zAppProfile = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    vendor: z.string().optional(),
    vendorVersion: z.string().optional(),
    surface: z.enum(['web', 'web-legacy', 'desktop']),

    /** Vault keys needed to sign on to this app. */
    secrets: z.array(z.string()).default([]),

    /** Merged into every capability recorded against this app. */
    outcomes: z.array(zOutcome).default([]),
    recoveries: z.array(zRecovery).default([]),

    policy: z
      .object({
        allowedPathPrefixes: z.array(z.string()).default([]),
        allowedActions: z.array(zStepAction).optional(),
        sensitivePatterns: z.array(z.string()).default([]),
      })
      .strict()
      .default({ allowedPathPrefixes: [], sensitivePatterns: [] }),

    /** Tenants running this app, and where each one lives. */
    tenants: z
      .record(
        z
          .object({
            baseUrl: z.string().min(1),
            appVersion: z.string().optional(),
            note: z.string().optional(),
            /** canonical control name -> the label this tenant's build uses */
            nameAliases: z.record(z.string()).default({}),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();

export type AppProfile = z.output<typeof zAppProfile>;

export function loadAppProfile(path: string): AppProfile {
  return zAppProfile.parse(YAML.parse(readFileSync(path, 'utf8')));
}
