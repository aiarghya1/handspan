/**
 * handspan catalog - the surface an AI agent binds to.
 *
 *   handspan catalog list | tools | show <id> | lint
 *   handspan catalog approve <file> --by "R. Okafor" --note "..."
 *   handspan catalog invoke <capability-id> --input memberId=12345
 *   handspan catalog serve --port 8101
 *
 * `invoke` takes a capability *name*, not a file path, and resolves the highest
 * version - which is what a calling agent actually has: a name and typed args.
 */

import express from 'express';
import { writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import YAML from 'yaml';
import { loadAppProfile } from '../artifact/app-profile.js';
import {
  computeContentHash,
  isApprovedForUnattended,
  latestById,
  loadCapabilityFile,
  loadCatalog,
  serializeCapability,
  type CatalogEntry,
} from '../artifact/store.js';
import { lintCapability } from '../artifact/lint.js';
import { toolForCapability } from '../catalog/tools.js';
import { precheckCapability, replay } from '../replay/engine.js';
import { describeResult, type ReplayResult } from '../replay/result.js';
import { bool, num, parseArgs, repeatedPairs, str, type Args } from './args.js';
import { EXIT, type Io } from './io.js';
import { appProfilePathFor, loadPolicyConfig, openSession, resolveTenant, type SessionFactory } from './shared.js';

const USAGE = `usage: handspan catalog <list|tools|show|lint|approve|invoke|serve> [options]
`;

export function renderListing(entries: CatalogEntry[]): string {
  if (entries.length === 0) return 'no capabilities on disk yet - run discovery first\n';
  const lines: string[] = [];
  for (const { path, capability } of entries) {
    const approval = isApprovedForUnattended(capability);
    const s = capability.provenance.stability;
    const tenants = [capability.app.recordedForTenant, ...capability.tenantOverrides.map((t) => t.tenant)].filter(Boolean);
    lines.push(`${capability.id}@${capability.version}`);
    lines.push(`  ${capability.title}`);
    lines.push(
      `  risk ${capability.policy.riskTier}  approval ${capability.provenance.approval.state}  ${approval.ok ? 'invocable' : `blocked: ${approval.reason}`}`,
    );
    lines.push(`  in  ${Object.keys(capability.params).join(', ') || '-'}`);
    lines.push(`  out ${Object.keys(capability.returns).join(', ') || '-'}`);
    lines.push(`  outcomes ${capability.outcomes.map((o) => o.id).join(', ') || '-'}`);
    lines.push(`  steps ${capability.steps.length}  replays ${s.successes}/${s.runs}  tenants ${tenants.join(', ')}`);
    lines.push(`  ${path}`);
    lines.push('');
  }
  return lines.join('\n');
}

interface InvokeOutcome {
  code: number;
  /** Present when the capability ran. */
  result?: ReplayResult;
  /** Present when it was refused before running: bad input, no approval. */
  refused?: { class: string; message: string };
  /** True when there is no capability by that name at all. */
  unknown?: boolean;
}

async function invoke(
  args: Args,
  entries: CatalogEntry[],
  capabilityId: string,
  inputs: Record<string, string>,
  io: Io,
  openSessionFn: SessionFactory,
): Promise<InvokeOutcome> {
  const latest = latestById(entries).get(capabilityId);
  if (!latest) {
    io.err(`no capability named "${capabilityId}". Known: ${[...latestById(entries).keys()].join(', ') || '(none)'}\n`);
    return { code: EXIT.usage, unknown: true };
  }

  const capability = latest.capability;
  const app = loadAppProfile(str(args, 'app-profile', appProfilePathFor(capability.app.id))!);
  const policyConfig = loadPolicyConfig(str(args, 'policy', 'config/policy.yaml'));
  const tenantId = str(args, 'tenant', capability.app.recordedForTenant ?? Object.keys(app.tenants)[0])!;
  const { baseUrl } = resolveTenant(app, tenantId);
  const attended = bool(args, 'attended');

  const pre = precheckCapability(capability, inputs, { tenant: tenantId, attended });
  if (!pre.ok) {
    io.err(`\n  refused before starting: [${pre.failure.class}] ${pre.failure.message}\n\n`);
    io.out(`${JSON.stringify({ status: 'failed', failure: pre.failure }, null, 2)}\n`);
    return { code: EXIT.failed, refused: pre.failure };
  }

  const session = await openSessionFn({
    kind: 'replay',
    app,
    policyConfig,
    headless: !bool(args, 'headed'),
    verbose: bool(args, 'verbose'),
    autoOperator: bool(args, 'auto-operator'),
    operatorPort: num(args, 'operator-port'),
  });
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
    });
    session.recorder.writeSummary(result);
    return { code: result.status === 'failed' ? EXIT.failed : EXIT.ok, result };
  } finally {
    await session.close();
  }
}

/** Extracted so the HTTP surface can be tested without binding a port. */
export function buildCatalogApp(
  args: Args,
  entries: CatalogEntry[],
  io: Io,
  openSessionFn: SessionFactory,
): express.Express {
  const app = express();
  app.use(express.json());
  app.get('/capabilities', (_req, res) => {
    res.json([...latestById(entries).values()].map((e) => toolForCapability(e.capability)));
  });
  app.post('/capabilities/:id/invoke', async (req, res) => {
    const outcome = await invoke(args, entries, req.params.id, req.body as Record<string, string>, io, openSessionFn);
    // Three distinct answers, because a caller does different things with each:
    // there is no such capability, the arguments were refused, or it ran.
    if (outcome.unknown) {
      res.status(404).json({ error: `no capability named "${req.params.id}"` });
      return;
    }
    if (outcome.refused) {
      res.status(422).json({ status: 'failed', failure: outcome.refused });
      return;
    }
    res.status(outcome.code === EXIT.ok ? 200 : 500).json(outcome.result);
  });
  return app;
}

export async function run(argv: string[], io: Io, openSessionFn: SessionFactory = openSession): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args.positional[0] ?? 'list';
  const dir = str(args, 'dir', 'capabilities')!;
  const entries = loadCatalog(dir);

  switch (cmd) {
    case 'list':
      io.out(renderListing(entries));
      return EXIT.ok;

    case 'tools':
      io.out(`${JSON.stringify([...latestById(entries).values()].map((e) => toolForCapability(e.capability)), null, 2)}\n`);
      return EXIT.ok;

    case 'show': {
      const id = args.positional[1];
      const found = id ? latestById(entries).get(id) : undefined;
      if (!found) {
        io.err('usage: handspan catalog show <capability-id>\n');
        return EXIT.usage;
      }
      io.out(YAML.stringify(toolForCapability(found.capability)));
      return EXIT.ok;
    }

    case 'lint': {
      let errors = 0;
      for (const { path, capability } of entries) {
        const findings = lintCapability(capability);
        io.out(`${path}\n`);
        if (findings.length === 0) io.out('  clean\n');
        for (const f of findings) {
          io.out(`  ${f.severity.padEnd(5)} ${f.code}${f.stepId ? ` [${f.stepId}]` : ''}: ${f.message}\n`);
          if (f.severity === 'error') errors++;
        }
        io.out('\n');
      }
      return errors > 0 ? EXIT.failed : EXIT.ok;
    }

    case 'approve': {
      const file = args.positional[1];
      const by = str(args, 'by');
      if (!file || !by) {
        io.err('usage: handspan catalog approve <file.capability.yaml> --by "<name>" [--note "<text>"]\n');
        return EXIT.usage;
      }
      const capability = loadCapabilityFile(file);
      const findings = lintCapability(capability);
      const errs = findings.filter((f) => f.severity === 'error');
      if (errs.length > 0) {
        io.err('refusing to approve an artifact with lint errors:\n');
        for (const f of errs) io.err(`  ${f.code}: ${f.message}\n`);
        return EXIT.failed;
      }
      // Pinning the hash is what makes approval mean "this exact behaviour".
      capability.provenance.approval = {
        state: 'approved',
        by,
        at: new Date().toISOString(),
        note: str(args, 'note'),
        contentHash: computeContentHash(capability),
      };
      writeFileSync(file, serializeCapability(capability), 'utf8');
      io.out(
        `approved ${capability.id}@${capability.version} (${capability.provenance.approval.contentHash}) by ${by}\n`,
      );
      for (const f of findings) io.out(`  note: ${f.code} - ${f.message}\n`);
      return EXIT.ok;
    }

    case 'invoke': {
      const id = args.positional[1];
      if (!id) {
        io.err('usage: handspan catalog invoke <capability-id> --input k=v\n');
        return EXIT.usage;
      }
      const { code, result } = await invoke(args, entries, id, repeatedPairs(args, 'input'), io, openSessionFn);
      if (result) {
        io.err(`\n  ${describeResult(result)}\n\n`);
        io.out(`${JSON.stringify(result, null, 2)}\n`);
      }
      return code;
    }

    case 'serve': {
      const port = num(args, 'port', 8101)!;
      const app = buildCatalogApp(args, entries, io, openSessionFn);
      await new Promise<void>((resolve) => {
        const server: Server = app.listen(port, () => {
          io.err(`capability catalog on http://localhost:${port}\n`);
          io.err('  GET  /capabilities\n');
          io.err('  POST /capabilities/<id>/invoke   body: {"memberId":"12345"}\n');
          server.unref();
          resolve();
        });
      });
      return EXIT.ok;
    }

    default:
      io.err(`unknown command "${cmd}".\n${USAGE}`);
      return EXIT.usage;
  }
}
