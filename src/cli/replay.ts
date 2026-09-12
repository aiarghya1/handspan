/**
 * handspan replay - the production execution path.
 *
 *   handspan replay <capability.yaml> --input memberId=12345
 *
 * No model is involved. This is what an AI agent triggers when it needs the
 * work done, and the JSON on stdout plus the exit code are shaped for a machine
 * reading the result contract rather than for a person.
 */

import { dirname } from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadAppProfile } from '../artifact/app-profile.js';
import { computeContentHash, loadCapabilityFile, saveCapability } from '../artifact/store.js';
import { precheckCapability, replay } from '../replay/engine.js';
import { describeResult, type ReplayResult } from '../replay/result.js';
import { bool, num, parseArgs, repeatedPairs, str } from './args.js';
import { EXIT, type Io } from './io.js';
import { appProfilePathFor, loadPolicyConfig, openSession, resolveTenant, type SessionFactory } from './shared.js';

const USAGE = `usage: handspan replay <capability.yaml> --input k=v [--input k=v ...]
       [--tenant <id>] [--attended] [--operator-port 8100] [--auto-operator]
       [--lenient-tenant] [--repeat N] [--headed] [--json <file>] [--record-stability]
`;

export async function run(argv: string[], io: Io, openSessionFn: SessionFactory = openSession): Promise<number> {
  const args = parseArgs(argv);
  const capPath = args.positional[0];
  if (!capPath) {
    io.err(USAGE);
    return EXIT.usage;
  }

  const capability = loadCapabilityFile(capPath);
  const app = loadAppProfile(str(args, 'app-profile', appProfilePathFor(capability.app.id))!);
  const policyConfig = loadPolicyConfig(str(args, 'policy', 'config/policy.yaml'));
  const tenantId = str(args, 'tenant', capability.app.recordedForTenant ?? Object.keys(app.tenants)[0])!;
  const { baseUrl } = resolveTenant(app, tenantId);
  const inputs = repeatedPairs(args, 'input');
  const attended = bool(args, 'attended');

  // Static gates first. A malformed input or an unapproved artifact should not
  // cost a browser launch, and the message is clearer without one.
  const pre = precheckCapability(capability, inputs, {
    tenant: tenantId,
    attended,
    lenientTenant: bool(args, 'lenient-tenant'),
  });
  if (!pre.ok) {
    io.err(`\n  refused before starting: [${pre.failure.class}] ${pre.failure.message}\n\n`);
    io.out(`${JSON.stringify({ status: 'failed', failure: pre.failure }, null, 2)}\n`);
    return EXIT.failed;
  }

  const repeat = num(args, 'repeat', 1)!;
  const results: ReplayResult[] = [];

  for (let attempt = 1; attempt <= repeat; attempt++) {
    const session = await openSessionFn({
      kind: 'replay',
      app,
      policyConfig,
      headless: !bool(args, 'headed'),
      verbose: true,
      operatorPort: num(args, 'operator-port'),
      autoOperator: bool(args, 'auto-operator'),
      debugPort: num(args, 'debug-port'),
    });

    io.err(`\n  capability: ${capability.id}@${capability.version} (${computeContentHash(capability)})\n`);
    io.err(`  tenant:     ${tenantId} -> ${baseUrl}\n`);
    io.err(`  inputs:     ${Object.keys(inputs).join(', ') || '(none)'}\n`);
    io.err(`  run:        ${session.recorder.dir}${repeat > 1 ? `  [${attempt}/${repeat}]` : ''}\n\n`);

    try {
      const result = await replay({
        capability,
        inputs,
        driver: session.driver,
        recorder: session.recorder,
        basePolicy: policyConfig,
        baseUrl,
        tenant: tenantId,
        secrets: session.secrets,
        broker: session.hasOperator ? session.broker : undefined,
        attended,
        lenientTenant: bool(args, 'lenient-tenant'),
      });

      session.recorder.writeSummary(result);
      results.push(result);
      io.err(describeResultBlock(result, session.recorder.dir));
    } finally {
      await session.close();
    }
  }

  // Stability is a property of the artifact, so it is written back to it. A
  // capability that has replayed cleanly twenty times is a different risk from
  // one recorded five minutes ago, and the catalog should say so.
  if (bool(args, 'record-stability')) {
    const successes = results.filter((r) => r.status === 'success' || r.status === 'business_outcome').length;
    capability.provenance.stability = {
      runs: capability.provenance.stability.runs + results.length,
      successes: capability.provenance.stability.successes + successes,
      lastRunAt: new Date().toISOString(),
      degradedSteps: [...new Set(results.flatMap((r) => r.degradedSteps))],
    };
    saveCapability(dirname(capPath), capability);
    io.err(`  stability recorded: ${capability.provenance.stability.successes}/${capability.provenance.stability.runs} runs clean\n\n`);
  }

  const payload = repeat > 1 ? results : results[0];
  const jsonPath = str(args, 'json');
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  io.out(`${JSON.stringify(payload, null, 2)}\n`);

  const failed = results.find((r) => r.status === 'failed');
  if (failed) return EXIT.failed;
  return results.some((r) => r.status === 'escalated') ? EXIT.escalated : EXIT.ok;
}

function describeResultBlock(result: ReplayResult, dir: string): string {
  const lines = [`\n  ${describeResult(result)}`];
  if (result.status === 'success') lines.push(`  outputs: ${JSON.stringify(result.outputs)}`);
  if (result.status === 'business_outcome') lines.push(`  data:    ${JSON.stringify(result.outcome.data)}`);
  if (result.status === 'failed') {
    lines.push(`  expected: ${result.failure.expected ?? '-'}`);
    lines.push(`  observed: ${result.failure.observed ?? '-'}`);
    if (result.failure.screenshot) lines.push(`  screenshot: ${result.failure.screenshot}`);
    if (result.failure.snapshot) lines.push(`  snapshot:   ${result.failure.snapshot}`);
  }
  if (result.degradedSteps.length > 0) {
    lines.push(`  locator drift on steps: ${result.degradedSteps.join(', ')} (artifact should be re-reviewed)`);
  }
  lines.push(`  evidence: ${dir}\n`);
  return `${lines.join('\n')}\n`;
}
