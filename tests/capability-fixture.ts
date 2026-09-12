/**
 * A parsed capability fixture shared by the artifact tests.
 *
 * Overrides are parsed rather than typed, so a fixture can be written the way
 * it appears in a real artifact file.
 */

import { API_VERSION, zCapability, type Capability } from '../src/artifact/schema.js';

// it appears in a real artifact file.
export function capability(over: Record<string, unknown> = {}): Capability {
  return zCapability.parse({
    apiVersion: API_VERSION,
    id: 'meridian.member.balance',
    version: '1.0.0',
    title: 'Read a balance',
    summary: 'Look up a member and read their savings balance.',
    surface: 'web-legacy',
    app: { id: 'meridian-core-servicing', recordedForTenant: 'tenant-a' },
    entryUrlTemplate: '{{baseUrl}}/',
    params: { memberId: { type: 'string', description: 'member number', pattern: '^\\d{5}$', sensitivity: 'pii-id' } },
    returns: { savingsBalance: { type: 'money', description: 'ledger balance' } },
    secrets: ['meridian.password'],
    steps: [
      {
        id: 's1',
        intent: 'enter the member number',
        action: 'fill',
        phase: 'input',
        ref: { role: 'textbox', name: 'Member Number' },
        value: '{{memberId}}',
        checkpoint: { kind: 'valueMatches', ref: { role: 'textbox', name: 'Member Number' }, pattern: '\\d' },
      },
      {
        id: 's2',
        intent: 'retrieve the record',
        action: 'click',
        phase: 'input',
        ref: { role: 'button', name: 'Retrieve' },
        checkpoint: { kind: 'textPresent', text: 'MEMBER DETAIL' },
      },
      {
        id: 's3',
        intent: 'read the balance',
        action: 'extract',
        phase: 'read',
        extract: {
          as: 'savingsBalance',
          source: { kind: 'control', ref: { role: 'cell', name: 'Balance', scope: { rowContaining: 'REGULAR SHARE SAVINGS' } } },
          transform: 'money',
        },
      },
    ],
    outcomes: [{ id: 'MEMBER_NOT_FOUND', description: 'no such member', detect: { kind: 'textPresent', text: 'No member found' } }],
    policy: { riskTier: 'read_only', allowedOrigins: ['http://a.test'] },
    provenance: { discoveredBy: { model: 'test', runId: 'r1', at: '2026-01-01T00:00:00Z', goal: 'g' } },
    ...over,
  }) as Capability;
}

