/**
 * handspan discover - run the LLM against a live surface and record the result.
 *
 *   handspan discover config/goals/member-savings-balance.goal.yaml
 *   handspan discover <goal.yaml> --script config/scripts/<name>.json
 *
 * With a script instead of a model, the identical pipeline runs offline and
 * deterministically. That is how the discovery path is tested and how the demo
 * works without an API key; the artifact is produced by the same compiler
 * either way.
 */

import { readFileSync } from 'node:fs';
import { loadAppProfile } from '../artifact/app-profile.js';
import { compareVersions, loadCatalog, saveCapability } from '../artifact/store.js';
import { lintCapability } from '../artifact/lint.js';
import { discover } from '../discover/agent.js';
import { compileCapability } from '../discover/compile.js';
import { loadGoalSpec } from '../discover/goal.js';
import { firstMessage, systemPrompt } from '../discover/prompts.js';
import { AnthropicPlanner, ScriptedPlanner, type Planner, type ScriptedStep } from '../llm/planner.js';
import { bool, num, parseArgs, str } from './args.js';
import { EXIT, type Io } from './io.js';
import { appProfilePathFor, loadPolicyConfig, openSession, resolveTenant, type SessionFactory } from './shared.js';

const USAGE = `usage: handspan discover <goal.yaml> [--script <file.json>] [--tenant <id>]
       [--operator-port 8100] [--auto-operator] [--headed] [--out capabilities]
`;

const NO_CREDENTIALS =
  '\n  No model credentials found. Set ANTHROPIC_API_KEY (or run `ant auth login`),\n' +
  '  or pass --script config/scripts/<name>.json to run the same pipeline offline.\n\n';

/**
 * Re-recording an existing capability produces a new minor version rather than
 * overwriting: the one on disk may be approved and in production use.
 */
export function nextVersion(dir: string, id: string): string {
  const existing = loadCatalog(dir)
    .filter((e) => e.capability.id === id)
    .sort((a, b) => compareVersions(a.capability.version, b.capability.version));
  const latest = existing[existing.length - 1];
  if (!latest) return '1.0.0';
  // The schema requires major.minor.patch, so the minor is always present.
  const [major, minor] = latest.capability.version.split('.').map(Number) as [number, number, number];
  return `${major}.${minor + 1}.0`;
}

export async function run(argv: string[], io: Io, openSessionFn: SessionFactory = openSession): Promise<number> {
  const args = parseArgs(argv);
  const goalPath = args.positional[0];
  if (!goalPath) {
    io.err(USAGE);
    return EXIT.usage;
  }

  const goal = loadGoalSpec(goalPath);
  const app = loadAppProfile(str(args, 'app-profile', appProfilePathFor(goal.app))!);
  const policyConfig = loadPolicyConfig(str(args, 'policy', 'config/policy.yaml'));
  const tenantId = str(args, 'tenant', goal.tenant)!;
  const { baseUrl } = resolveTenant(app, tenantId);
  const outDir = str(args, 'out', 'capabilities')!;
  const scriptPath = str(args, 'script');

  const hasCredentials = Boolean(process.env['ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_AUTH_TOKEN']);
  if (!scriptPath && !hasCredentials) {
    io.err(NO_CREDENTIALS);
    return EXIT.usage;
  }

  const session = await openSessionFn({
    kind: 'discovery',
    app,
    policyConfig: { ...policyConfig, maxSteps: goal.maxSteps + 10 },
    headless: !bool(args, 'headed'),
    verbose: true,
    operatorPort: num(args, 'operator-port'),
    autoOperator: bool(args, 'auto-operator'),
    debugPort: num(args, 'debug-port'),
  });

  const entryUrl = new URL(goal.entryPath, baseUrl).toString();
  let planner: Planner;
  if (scriptPath) {
    const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as ScriptedStep[];
    planner = new ScriptedPlanner(script);
    io.err(`\n  planner: scripted (${script.length} turns from ${scriptPath})\n`);
  } else {
    // Loaded only when a model is going to be used: the SDK's module graph is
    // large, and a scripted run has no business paying for it.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    planner = new AnthropicPlanner({
      client: new Anthropic(),
      model: str(args, 'model', process.env['HANDSPAN_MODEL'] ?? 'claude-opus-5'),
      effort: str(args, 'effort', process.env['HANDSPAN_EFFORT'] ?? 'high') as 'high',
      system: systemPrompt(app),
      firstMessage: firstMessage(goal, app, baseUrl, entryUrl),
      onText: (t) => session.recorder.event('note', { source: 'model', text: t }),
    });
    io.err(`\n  planner: ${planner.model}\n`);
  }

  io.err(`  goal:    ${goal.id}\n`);
  io.err(`  target:  ${entryUrl} (tenant ${tenantId})\n`);
  io.err(`  run:     ${session.recorder.dir}\n\n`);

  try {
    const result = await discover({
      goal,
      app,
      planner,
      driver: session.driver,
      recorder: session.recorder,
      policy: session.policy,
      secrets: session.secrets,
      baseUrl,
      broker: session.hasOperator ? session.broker : undefined,
      maxTurns: num(args, 'max-turns', 40),
      vision: !bool(args, 'no-vision'),
    });

    session.recorder.writeFile('trace.json', JSON.stringify(result.trace, null, 2));

    if (result.status !== 'success') {
      io.err(`\n  discovery did not complete: ${result.status}${result.reason ? ` - ${result.reason}` : ''}\n`);
      io.err(`  evidence: ${session.recorder.dir}\n\n`);
      session.recorder.writeSummary({ status: result.status, reason: result.reason, trace: result.trace });
      return EXIT.failed;
    }

    const version = nextVersion(outDir, goal.id);
    const capability = compileCapability({ trace: result.trace, goal, app, baseUrl, version });
    const findings = lintCapability(capability);
    const path = saveCapability(outDir, capability);
    session.recorder.event('artifact.written', {
      path,
      version,
      findings: findings.map((f) => `${f.severity}:${f.code}`),
    });

    io.err(
      `\n  recorded ${capability.steps.length} steps, ${capability.outcomes.length} outcomes, ${capability.recoveries.length} recoveries\n`,
    );
    io.err(
      `  risk tier: ${capability.policy.riskTier}${capability.policy.requiresApproval ? ' (approval required before unattended replay)' : ''}\n`,
    );
    for (const f of findings) io.err(`  lint ${f.severity}: ${f.code} - ${f.message}\n`);
    io.err(`\n  artifact: ${path}\n  evidence: ${session.recorder.dir}\n\n`);

    session.recorder.writeSummary({
      status: 'success',
      capabilityId: capability.id,
      version: capability.version,
      artifactPath: path,
      contentHash: capability.contentHash,
      model: result.trace.model,
      turns: result.trace.turns,
      actions: result.trace.entries.length,
      blockedActions: result.trace.blockedActions,
      humanAssisted: result.trace.humanAssisted,
      summary: result.trace.summary,
      lint: findings,
    });
    return EXIT.ok;
  } finally {
    await session.close();
  }
}
