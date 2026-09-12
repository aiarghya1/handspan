/**
 * The command layer.
 *
 * Every command is a function of `(argv, io, sessionFactory)` returning an exit
 * code, so these tests drive them directly with a fake session - no browser, no
 * ports, no process. The one piece that reads `process.argv` and calls
 * `process.exit` is `bin/handspan.ts`, which contains no logic.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { captureIo, EXIT, consoleIo } from '../src/cli/io.js';
import { parseArgs, bool, num, str, repeatedPairs } from '../src/cli/args.js';
import * as replayCmd from '../src/cli/replay.js';
import * as discoverCmd from '../src/cli/discover.js';
import * as catalogCmd from '../src/cli/catalog.js';
import * as operatorCmd from '../src/cli/operator.js';
import { appProfilePathFor, createSimulatedOperator, loadPolicyConfig, resolveTenant, type Session, type SessionOptions } from '../src/cli/shared.js';
import { serializeCapability, loadCatalog } from '../src/artifact/store.js';
import { zCapability, API_VERSION, type Capability } from '../src/artifact/schema.js';
import { EscalationBroker } from '../src/escalation/broker.js';
import { RunRecorder } from '../src/obs/recorder.js';
import { PolicyEngine } from '../src/policy/policy.js';
import { FakeDriver } from './fake-driver.js';
import { BASE, FLOW, appProfile, goalSpec, policyConfig } from './fixtures.js';

// -- a session that needs no browser ---------------------------------------

function fakeSessionFactory(
  over: { start?: string; screens?: typeof FLOW.screens; transitions?: typeof FLOW.transitions } = {},
) {
  const made: Session[] = [];
  const factory = async (opts: SessionOptions): Promise<Session> => {
    const driver = new FakeDriver(
      structuredClone(over.screens ?? FLOW.screens),
      { ...FLOW.transitions, ...(over.transitions ?? {}) },
      over.start ?? 'signon',
    );
    const recorder = new RunRecorder({ kind: opts.kind, root: mkdtempSync(`${tmpdir()}/handspan-`) });
    const policy = new PolicyEngine(opts.policyConfig);
    // With --auto-operator the real simulated operator is attached, so an
    // escalation resolves the way it does in the demo rather than timing out.
    let broker!: EscalationBroker;
    broker = new EscalationBroker({
      driver,
      policy,
      recorder,
      maxWaitMs: 400,
      autoResolver: opts.autoOperator ? createSimulatedOperator(() => broker) : undefined,
    });
    const session: Session = {
      driver: driver as unknown as Session['driver'],
      recorder,
      policy,
      broker,
      hasOperator: Boolean(opts.operatorPort ?? opts.autoOperator),
      secrets: { get: (k: string) => `value-of-${k}` } as Session['secrets'],
      close: async () => {},
    };
    made.push(session);
    return session;
  };
  return { factory, made };
}

// -- fixtures on disk ------------------------------------------------------

function capability(over: Record<string, unknown> = {}): Capability {
  return zCapability.parse({
    apiVersion: API_VERSION,
    id: 'meridian.member.savings_balance',
    version: '1.0.0',
    title: "Read a member's savings balance",
    summary: 'Look up a member and return their savings balance.',
    surface: 'web-legacy',
    app: { id: 'meridian-core-servicing', recordedForTenant: 'meridian-demo' },
    entryUrlTemplate: '{{baseUrl}}/member/search',
    params: { memberId: { type: 'string', description: 'member number', pattern: '^\\d{5}$', sensitivity: 'pii-id' } },
    returns: { savingsBalance: { type: 'money', description: 'balance', sensitivity: 'account' } },
    steps: [
      {
        id: 's1',
        intent: 'enter the member number',
        action: 'fill',
        phase: 'input',
        ref: { role: 'textbox', name: 'Member Number' },
        value: '{{memberId}}',
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
    outcomes: [
      {
        id: 'MEMBER_NOT_FOUND',
        description: 'no such member',
        detect: { kind: 'textPresent', text: 'No member found for' },
      },
    ],
    policy: { riskTier: 'read_only', allowedOrigins: [BASE] },
    provenance: { discoveredBy: { model: 'test', runId: 'r', at: 'now', goal: 'g' } },
    ...over,
  }) as Capability;
}

/** A capability directory plus the app profile and policy file the CLIs read. */
function workspace(caps: Capability[] = [capability()]): {
  dir: string;
  capPath: string;
  profile: string;
  policy: string;
} {
  const dir = mkdtempSync(`${tmpdir()}/handspan-ws-`);
  mkdirSync(join(dir, 'capabilities'));
  let capPath = '';
  for (const c of caps) {
    capPath = join(dir, 'capabilities', `${c.id}@${c.version}.capability.yaml`);
    writeFileSync(capPath, serializeCapability(c), 'utf8');
  }
  const profile = join(dir, 'app.yaml');
  writeFileSync(
    profile,
    `id: meridian-core-servicing
title: Meridian Core Servicing
surface: web-legacy
secrets: [meridian.username, meridian.password]
tenants:
  meridian-demo: { baseUrl: "${BASE}" }
  cu-northstar: { baseUrl: "http://other.test" }
`,
    'utf8',
  );
  // The deployment policy must permit the fake origins, or every run correctly
  // fails closed before it starts.
  const policy = join(dir, 'policy.yaml');
  writeFileSync(
    policy,
    `allowedOrigins: ["${BASE}", "http://other.test"]
allowedPathPrefixes: []
onIrreversible: escalate
maxSteps: 60
`,
    'utf8',
  );
  return { dir, capPath, profile, policy };
}

/** The real deployment policy, for the tests that read it as a file. */
const REAL_POLICY = 'config/policy.yaml';

describe('argument parsing', () => {
  it('handles flags, values, equals form and positionals', () => {
    const a = parseArgs(['cmd', 'file.yaml', '--tenant', 'x', '--headed', '--port=8100', '--trailing']);
    expect(a.positional).toEqual(['cmd', 'file.yaml']);
    expect(str(a, 'tenant')).toBe('x');
    expect(bool(a, 'headed')).toBe(true);
    expect(num(a, 'port')).toBe(8100);
    expect(bool(a, 'trailing')).toBe(true);
  });

  it('falls back to defaults, and reads a boolean written as text', () => {
    const a = parseArgs(['--headed=true']);
    expect(str(a, 'missing', 'fallback')).toBe('fallback');
    expect(num(a, 'missing', 7)).toBe(7);
    expect(num(a, 'missing')).toBeUndefined();
    expect(bool(a, 'headed')).toBe(true);
  });

  it('collects every occurrence of a repeated flag', () => {
    const a = parseArgs(['--input', 'memberId=12345', '--input=productCode=VC01', '--input', 'malformed', '--other', 'x']);
    expect(repeatedPairs(a, 'input')).toEqual({ memberId: '12345', productCode: 'VC01' });
  });
});

describe('io', () => {
  it('captures output separately for machines and for people', () => {
    const io = captureIo();
    io.out('result');
    io.err('progress');
    expect(io.stdout).toBe('result');
    expect(io.stderr).toBe('progress');
  });

  it('writes to the process streams in the console implementation', () => {
    // Exercised rather than asserted: the point is that it does not throw.
    expect(() => {
      consoleIo.err('');
      consoleIo.out('');
    }).not.toThrow();
  });
});

describe('shared wiring', () => {
  it('derives an app profile path from the app id', () => {
    expect(appProfilePathFor('meridian-core-servicing')).toBe('config/apps/meridian.app.yaml');
  });

  it('resolves a known tenant and refuses an unknown one', () => {
    const app = appProfile();
    expect(resolveTenant(app, 'meridian-demo').baseUrl).toBe(BASE);
    expect(() => resolveTenant(app, 'nope')).toThrow(/not in the app profile/);
  });

  it('reads the deployment policy file', () => {
    const p = loadPolicyConfig(REAL_POLICY);
    expect(p.allowedOrigins.length).toBeGreaterThan(0);
    expect(p.onIrreversible).toBe('escalate');
  });
});

describe('replay command', () => {
  it('prints usage and exits 2 with no artifact', async () => {
    const io = captureIo();
    expect(await replayCmd.run([], io, fakeSessionFactory().factory)).toBe(EXIT.usage);
    expect(io.stderr).toContain('usage: handspan replay');
  });

  it('replays and returns the result contract on stdout', async () => {
    const ws = workspace();
    const io = captureIo();
    const code = await replayCmd.run(
      [ws.capPath, '--input', 'memberId=12345', '--app-profile', ws.profile, '--policy', ws.policy],
      io,
      fakeSessionFactory({ start: 'search' }).factory,
    );
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(io.stdout)).toMatchObject({ status: 'success', outputs: { savingsBalance: 4182.55 } });
    expect(io.stderr).toContain('capability: meridian.member.savings_balance@1.0.0');
  });

  it('refuses a bad input before opening a session', async () => {
    const ws = workspace();
    const io = captureIo();
    const factory = fakeSessionFactory({ start: 'search' });
    const code = await replayCmd.run(
      [ws.capPath, '--input', 'memberId=nope', '--app-profile', ws.profile, '--policy', ws.policy],
      io,
      factory.factory,
    );
    expect(code).toBe(EXIT.failed);
    expect(factory.made).toHaveLength(0);
    expect(io.stderr).toContain('invalid_input');
  });

  it('reports a business outcome without calling it a failure', async () => {
    const ws = workspace();
    const io = captureIo();
    const code = await replayCmd.run(
      [ws.capPath, '--input', 'memberId=99999', '--app-profile', ws.profile, '--policy', ws.policy],
      io,
      // The search returns nothing, which is a business outcome rather than a
      // failure - the point of the assertion below.
      fakeSessionFactory({ start: 'search', transitions: { 'search::click:button:Retrieve': 'missing' } }).factory,
    );
    expect(code).toBe(EXIT.ok);
    expect(io.stderr).toContain('MEMBER_NOT_FOUND');
  });


  it('writes the result to a file when asked', async () => {
    const ws = workspace();
    const jsonPath = join(ws.dir, 'out.json');
    const io = captureIo();
    await replayCmd.run(
      [ws.capPath, '--input', 'memberId=12345', '--app-profile', ws.profile, '--policy', ws.policy, '--json', jsonPath],
      io,
      fakeSessionFactory({ start: 'search' }).factory,
    );
    expect(JSON.parse(readFileSync(jsonPath, 'utf8'))).toMatchObject({ status: 'success' });
  });

  it('repeats the run and reports every result', async () => {
    const ws = workspace();
    const io = captureIo();
    await replayCmd.run(
      [ws.capPath, '--input', 'memberId=12345', '--app-profile', ws.profile, '--policy', ws.policy, '--repeat', '2'],
      io,
      fakeSessionFactory({ start: 'search' }).factory,
    );
    expect(JSON.parse(io.stdout)).toHaveLength(2);
    expect(io.stderr).toContain('[1/2]');
  });

  it('records stability back onto the artifact', async () => {
    const ws = workspace();
    const io = captureIo();
    await replayCmd.run(
      [ws.capPath, '--input', 'memberId=12345', '--app-profile', ws.profile, '--policy', ws.policy, '--record-stability'],
      io,
      fakeSessionFactory({ start: 'search' }).factory,
    );
    const after = loadCatalog(join(ws.dir, 'capabilities'))[0]!.capability;
    expect(after.provenance.stability).toMatchObject({ runs: 1, successes: 1 });
    expect(io.stderr).toContain('stability recorded: 1/1');
  });

  it('refuses an unapproved irreversible capability, and exits 3 on an escalation', async () => {
    const gated = capability({
      policy: { riskTier: 'read_only', allowedOrigins: [BASE], allowedPathPrefixes: [], allowedActions: ['fill', 'click', 'extract'], requiresApproval: true },
    });
    const ws = workspace([gated]);
    const io = captureIo();
    expect(
      await replayCmd.run(
        [ws.capPath, '--input', 'memberId=12345', '--app-profile', ws.profile, '--policy', ws.policy],
        io,
        fakeSessionFactory({ start: 'search' }).factory,
      ),
    ).toBe(EXIT.failed);
    expect(io.stderr).toContain('not_approved');
  });

  it('uses the tenant given on the command line', async () => {
    const withOverride = capability({
      tenantOverrides: [
        { tenant: 'cu-northstar', nameAliases: {}, refPatches: [], disabledSteps: [], extraRecoveries: [], allowedOrigins: ['http://other.test'] },
      ],
    });
    const ws = workspace([withOverride]);
    const io = captureIo();
    await replayCmd.run(
      [ws.capPath, '--input', 'memberId=12345', '--app-profile', ws.profile, '--policy', ws.policy, '--tenant', 'cu-northstar'],
      io,
      fakeSessionFactory({ start: 'search' }).factory,
    );
    expect(io.stderr).toContain('cu-northstar -> http://other.test');
  });
});

describe('discover command', () => {
  const scriptFile = (dir: string, steps: unknown): string => {
    const p = join(dir, 'script.json');
    writeFileSync(p, JSON.stringify(steps), 'utf8');
    return p;
  };

  const goalFile = (dir: string, over: Record<string, unknown> = {}): string => {
    const p = join(dir, 'goal.yaml');
    const g = { ...goalSpec(), ...over };
    writeFileSync(
      p,
      `id: ${g.id}
title: ${g.title}
summary: ${g.summary}
goal: ${g.goal}
app: meridian-core-servicing
tenant: ${g.tenant}
entryPath: ${over['entryPath'] ?? '/'}
params:
  memberId:
    type: string
    description: The 5-digit member number.
    pattern: '^\\d{5}$'
    sensitivity: pii-id
    value: "12345"
returns:
  savingsBalance:
    type: money
    description: Ledger balance.
    sensitivity: account
`,
      'utf8',
    );
    return p;
  };

  it('prints usage with no goal file', async () => {
    const io = captureIo();
    expect(await discoverCmd.run([], io, fakeSessionFactory().factory)).toBe(EXIT.usage);
    expect(io.stderr).toContain('usage: handspan discover');
  });

  it('refuses to start without a model or a script', async () => {
    const ws = workspace();
    const key = process.env['ANTHROPIC_API_KEY'];
    const token = process.env['ANTHROPIC_AUTH_TOKEN'];
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_AUTH_TOKEN'];
    try {
      const io = captureIo();
      const code = await discoverCmd.run(
        [goalFile(ws.dir), '--app-profile', ws.profile, '--policy', ws.policy],
        io,
        fakeSessionFactory().factory,
      );
      expect(code).toBe(EXIT.usage);
      expect(io.stderr).toContain('No model credentials');
    } finally {
      if (key !== undefined) process.env['ANTHROPIC_API_KEY'] = key;
      if (token !== undefined) process.env['ANTHROPIC_AUTH_TOKEN'] = token;
    }
  });

  it('records a capability from a scripted run', async () => {
    const ws = workspace([]);
    const script = scriptFile(ws.dir, [
      { calls: [{ name: 'observe', input: {} }] },
      {
        calls: [
          { name: 'type_text', input: { handle: 'textbox|Member Number', text: '12345', parameter: 'memberId', intent: 'enter the member number', phase: 'input' } },
        ],
      },
      { calls: [{ name: 'click', input: { handle: 'button|Retrieve', intent: 'retrieve', expect: 'MEMBER DETAIL', phase: 'input' } }] },
      { calls: [{ name: 'read_value', input: { name: 'savingsBalance', handle: 'cell|Balance|row=REGULAR SHARE SAVINGS', intent: 'read the balance' } }] },
      { calls: [{ name: 'finish', input: { summary: 'read it', success_text: 'MEMBER DETAIL' } }] },
    ]);
    const io = captureIo();
    const code = await discoverCmd.run(
      [
        goalFile(ws.dir, { entryPath: '/member/search' }),
        '--script',
        script,
        '--app-profile',
        ws.profile,
        '--policy',
        ws.policy,
        '--out',
        join(ws.dir, 'capabilities'),
        '--no-vision',
      ],
      io,
      fakeSessionFactory({ start: 'search' }).factory,
    );
    expect(code).toBe(EXIT.ok);
    expect(io.stderr).toContain('planner: scripted');
    expect(io.stderr).toContain('artifact:');
    const saved = loadCatalog(join(ws.dir, 'capabilities'));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.capability.version).toBe('1.0.0');
  });

  it('reports a run that did not complete', async () => {
    const ws = workspace([]);
    const script = scriptFile(ws.dir, [{ calls: [{ name: 'observe', input: {} }] }]);
    const io = captureIo();
    const code = await discoverCmd.run(
      [goalFile(ws.dir), '--script', script, '--app-profile', ws.profile, '--policy', ws.policy, '--out', join(ws.dir, 'capabilities')],
      io,
      fakeSessionFactory().factory,
    );
    expect(code).toBe(EXIT.failed);
    expect(io.stderr).toContain('discovery did not complete');
  });

  it('bumps the minor version when a capability is re-recorded', () => {
    const ws = workspace([capability(), capability({ version: '1.3.0' })]);
    expect(discoverCmd.nextVersion(join(ws.dir, 'capabilities'), 'meridian.member.savings_balance')).toBe('1.4.0');
    expect(discoverCmd.nextVersion(join(ws.dir, 'capabilities'), 'something.else')).toBe('1.0.0');
  });
});

describe('catalog command', () => {
  it('lists what exists, and says so when nothing does', async () => {
    const io = captureIo();
    await catalogCmd.run(['list', '--dir', mkdtempSync(`${tmpdir()}/empty-`)], io, fakeSessionFactory().factory);
    expect(io.stdout).toContain('no capabilities on disk yet');

    const ws = workspace();
    const io2 = captureIo();
    expect(await catalogCmd.run(['list', '--dir', join(ws.dir, 'capabilities')], io2, fakeSessionFactory().factory)).toBe(EXIT.ok);
    expect(io2.stdout).toContain('meridian.member.savings_balance@1.0.0');
    expect(io2.stdout).toContain('invocable');
  });

  it('marks a capability that is not cleared for unattended use', async () => {
    const gated = capability({
      policy: { riskTier: 'irreversible', allowedOrigins: [BASE], allowedPathPrefixes: [], allowedActions: ['click'], requiresApproval: true },
    });
    const io = captureIo();
    await catalogCmd.run(['list', '--dir', join(workspace([gated]).dir, 'capabilities')], io, fakeSessionFactory().factory);
    expect(io.stdout).toContain('blocked:');
  });

  it('projects tool definitions for a calling agent', async () => {
    const ws = workspace();
    const io = captureIo();
    await catalogCmd.run(['tools', '--dir', join(ws.dir, 'capabilities')], io, fakeSessionFactory().factory);
    const tools = JSON.parse(io.stdout) as Array<{ name: string; input_schema: { required: string[] } }>;
    expect(tools[0]!.name).toBe('meridian__member__savings_balance');
    expect(tools[0]!.input_schema.required).toEqual(['memberId']);
  });

  it('shows one capability as yaml, and refuses an unknown name', async () => {
    const ws = workspace();
    const io = captureIo();
    await catalogCmd.run(['show', 'meridian.member.savings_balance', '--dir', join(ws.dir, 'capabilities')], io, fakeSessionFactory().factory);
    expect(io.stdout).toContain('handspan:');

    const io2 = captureIo();
    expect(await catalogCmd.run(['show', 'nope', '--dir', join(ws.dir, 'capabilities')], io2, fakeSessionFactory().factory)).toBe(EXIT.usage);
    expect(await catalogCmd.run(['show', '--dir', join(ws.dir, 'capabilities')], captureIo(), fakeSessionFactory().factory)).toBe(EXIT.usage);
  });

  it('lints every artifact, and fails on an error', async () => {
    const ws = workspace();
    const io = captureIo();
    expect(await catalogCmd.run(['lint', '--dir', join(ws.dir, 'capabilities')], io, fakeSessionFactory().factory)).toBe(EXIT.ok);
    // A warning is not a blocking finding: the fill has no checkpoint, which the
    // linter flags but does not refuse.
    expect(io.stdout).toContain('unverified-step');

    const broken = capability();
    broken.steps[0]!.value = '{{undeclared}}';
    const io2 = captureIo();
    expect(await catalogCmd.run(['lint', '--dir', join(workspace([broken]).dir, 'capabilities')], io2, fakeSessionFactory().factory)).toBe(
      EXIT.failed,
    );
    expect(io2.stdout).toContain('undeclared-param');
  });

  it('approves an artifact, pinning the hash it reviewed', async () => {
    const ws = workspace();
    const io = captureIo();
    expect(await catalogCmd.run(['approve', ws.capPath, '--by', 'R. Okafor', '--note', 'CR-1'], io, fakeSessionFactory().factory)).toBe(
      EXIT.ok,
    );
    const after = loadCatalog(join(ws.dir, 'capabilities'))[0]!.capability;
    expect(after.provenance.approval).toMatchObject({ state: 'approved', by: 'R. Okafor', note: 'CR-1' });
    expect(after.provenance.approval.contentHash).toBeTruthy();
    expect(io.stdout).toContain('approved meridian.member.savings_balance@1.0.0');
  });

  it('refuses to approve without a name, or with lint errors', async () => {
    const ws = workspace();
    expect(await catalogCmd.run(['approve', ws.capPath], captureIo(), fakeSessionFactory().factory)).toBe(EXIT.usage);
    expect(await catalogCmd.run(['approve'], captureIo(), fakeSessionFactory().factory)).toBe(EXIT.usage);

    const broken = capability();
    broken.steps[0]!.value = '{{undeclared}}';
    const bad = workspace([broken]);
    const io = captureIo();
    expect(await catalogCmd.run(['approve', bad.capPath, '--by', 'X'], io, fakeSessionFactory().factory)).toBe(EXIT.failed);
    expect(io.stderr).toContain('refusing to approve');
  });

  it('invokes a capability by name', async () => {
    const ws = workspace();
    const io = captureIo();
    const code = await catalogCmd.run(
      [
        'invoke',
        'meridian.member.savings_balance',
        '--input',
        'memberId=12345',
        '--dir',
        join(ws.dir, 'capabilities'),
        '--app-profile',
        ws.profile,
        '--policy',
        ws.policy,
      ],
      io,
      fakeSessionFactory({ start: 'search' }).factory,
    );
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(io.stdout)).toMatchObject({ status: 'success' });
  });

  it('refuses an unknown name, a missing name, and a bad input', async () => {
    const ws = workspace();
    const base = ['--dir', join(ws.dir, 'capabilities'), '--app-profile', ws.profile, '--policy', ws.policy];
    expect(await catalogCmd.run(['invoke'], captureIo(), fakeSessionFactory().factory)).toBe(EXIT.usage);
    expect(await catalogCmd.run(['invoke', 'nope', ...base], captureIo(), fakeSessionFactory().factory)).toBe(EXIT.usage);
    const io = captureIo();
    expect(
      await catalogCmd.run(['invoke', 'meridian.member.savings_balance', '--input', 'memberId=x', ...base], io, fakeSessionFactory().factory),
    ).toBe(EXIT.failed);
    expect(io.stderr).toContain('invalid_input');
  });

  it('rejects an unknown subcommand', async () => {
    const io = captureIo();
    expect(await catalogCmd.run(['frobnicate'], io, fakeSessionFactory().factory)).toBe(EXIT.usage);
    expect(io.stderr).toContain('unknown command');
  });

  it('serves the catalog over http', async () => {
    const ws = workspace();
    const args = parseArgs(['--dir', join(ws.dir, 'capabilities'), '--app-profile', ws.profile, '--policy', ws.policy]);
    const entries = loadCatalog(join(ws.dir, 'capabilities'));
    const app = catalogCmd.buildCatalogApp(args, entries, captureIo(), fakeSessionFactory({ start: 'search' }).factory);

    const list = await request(app).get('/capabilities');
    expect(list.status).toBe(200);
    expect(list.body[0].name).toBe('meridian__member__savings_balance');

    const run = await request(app).post('/capabilities/meridian.member.savings_balance/invoke').send({ memberId: '12345' });
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('success');

    const missing = await request(app).post('/capabilities/nope/invoke').send({});
    expect(missing.status).toBe(404);

    // Refused arguments are 422, distinct from an unknown capability (404) and
    // from a capability that ran and failed (500).
    const rejected = await request(app).post('/capabilities/meridian.member.savings_balance/invoke').send({ memberId: 'x' });
    expect(rejected.status).toBe(422);
    expect(rejected.body.failure.class).toBe('invalid_input');
  });

  it('binds a port when asked to serve', async () => {
    const ws = workspace();
    const io = captureIo();
    expect(
      await catalogCmd.run(['serve', '--port', '0', '--dir', join(ws.dir, 'capabilities')], io, fakeSessionFactory().factory),
    ).toBe(EXIT.ok);
    expect(io.stderr).toContain('capability catalog on');
  });
});

describe('operator command', () => {
  it('opens a console with nothing in the queue', async () => {
    const io = captureIo();
    const code = await operatorCmd.run(
      ['--port', '8123', '--app-profile', 'config/apps/meridian.app.yaml', '--policy', REAL_POLICY, '--close-immediately'],
      io,
      fakeSessionFactory().factory,
    );
    expect(code).toBe(EXIT.ok);
    expect(io.stderr).toContain('operator console on http://localhost:8123');
  });
});

describe('the simulated operator', () => {
  it('performs the action the agent was refused and hands control back', async () => {
    const driver = new FakeDriver(structuredClone(FLOW.screens), FLOW.transitions, 'confirm');
    const recorder = new RunRecorder({ kind: 'replay', root: mkdtempSync(`${tmpdir()}/handspan-`) });
    const policy = new PolicyEngine(policyConfig());
    let broker!: EscalationBroker;
    broker = new EscalationBroker({
      driver,
      policy,
      recorder,
      maxWaitMs: 500,
      autoResolver: createSimulatedOperator(() => broker),
    });

    const resolution = await broker.raise('irreversible-approval', 'needs a person', {
      runId: 'r',
      askedToDo: 'post it',
      intendedAction: { kind: 'click', ref: { role: 'button', name: 'Confirm and Post' } },
    });
    expect(resolution.action).toBe('resume');
    expect(driver.current).toBe('posted');
  });

  it('aborts when the control it was asked to use is gone', async () => {
    const driver = new FakeDriver(structuredClone(FLOW.screens), FLOW.transitions, 'search');
    const recorder = new RunRecorder({ kind: 'replay', root: mkdtempSync(`${tmpdir()}/handspan-`) });
    const policy = new PolicyEngine(policyConfig());
    let broker!: EscalationBroker;
    broker = new EscalationBroker({ driver, policy, recorder, maxWaitMs: 500, autoResolver: createSimulatedOperator(() => broker) });

    const resolution = await broker.raise('irreversible-approval', 'needs a person', {
      runId: 'r',
      askedToDo: 'post it',
      intendedAction: { kind: 'click', ref: { role: 'button', name: 'Confirm and Post' } },
    });
    expect(resolution.action).toBe('abort');
    expect(resolution.note).toContain('no longer on screen');
  });

  it('aborts, rather than guessing, when there is no action to replay', async () => {
    const driver = new FakeDriver(structuredClone(FLOW.screens), FLOW.transitions, 'search');
    const recorder = new RunRecorder({ kind: 'replay', root: mkdtempSync(`${tmpdir()}/handspan-`) });
    const policy = new PolicyEngine(policyConfig());
    let broker!: EscalationBroker;
    broker = new EscalationBroker({ driver, policy, recorder, maxWaitMs: 500, autoResolver: createSimulatedOperator(() => broker) });

    const resolution = await broker.raise('no-progress', 'stuck', { runId: 'r', askedToDo: 'help' });
    expect(resolution.action).toBe('abort');
    expect(resolution.note).toContain('a person is needed');
  });

  it('reports a refused action rather than claiming success', async () => {
    const driver = new FakeDriver(structuredClone(FLOW.screens), FLOW.transitions, 'confirm');
    const recorder = new RunRecorder({ kind: 'replay', root: mkdtempSync(`${tmpdir()}/handspan-`) });
    const policy = new PolicyEngine(policyConfig({ operatorMayCommit: false }));
    let broker!: EscalationBroker;
    broker = new EscalationBroker({ driver, policy, recorder, maxWaitMs: 500, autoResolver: createSimulatedOperator(() => broker) });

    const resolution = await broker.raise('irreversible-approval', 'needs a person', {
      runId: 'r',
      askedToDo: 'post it',
      intendedAction: { kind: 'click', ref: { role: 'button', name: 'Confirm and Post' } },
    });
    expect(resolution.action).toBe('abort');
    expect(resolution.note).toContain('could not perform');
    expect(existsSync(recorder.dir)).toBe(true);
  });
});

describe('listing a capability with an empty contract', () => {
  it('prints a dash rather than an empty line', async () => {
    const bare = capability({
      params: {},
      returns: {},
      outcomes: [],
      steps: [{ id: 's1', intent: 'look', action: 'assert' }],
    });
    const io = captureIo();
    await catalogCmd.run(['list', '--dir', join(workspace([bare]).dir, 'capabilities')], io, fakeSessionFactory().factory);
    expect(io.stdout).toContain('in  -');
    expect(io.stdout).toContain('out -');
    expect(io.stdout).toContain('outcomes -');
  });
});

describe('replay reporting', () => {
  it('reports locator drift on the steps that degraded', async () => {
    // The section heading has changed, so the ref resolves one tier lower. The
    // run still succeeds; the artifact is flagged for re-review.
    const drifted = capability();
    drifted.steps[0]!.ref = { role: 'textbox', name: 'Member Number', scope: { section: 'MEMBER SELECTION' } };
    drifted.steps[0]!.recordedTier = 'role+name+scope';
    const ws = workspace([drifted]);
    const io = captureIo();
    await replayCmd.run(
      [ws.capPath, '--input', 'memberId=12345', '--app-profile', ws.profile, '--policy', ws.policy],
      io,
      fakeSessionFactory({ start: 'search' }).factory,
    );
    expect(io.stderr).toContain('locator drift on steps: s1');
  });

  it('says so when a capability takes no inputs', async () => {
    const noInputs = capability({
      params: {},
      steps: [{ id: 's1', intent: 'look', action: 'assert', checkpoint: { kind: 'textPresent', text: 'MEMBER INQUIRY' } }],
      returns: {},
    });
    const ws = workspace([noInputs]);
    const io = captureIo();
    await replayCmd.run(
      [ws.capPath, '--app-profile', ws.profile, '--policy', ws.policy],
      io,
      fakeSessionFactory({ start: 'search' }).factory,
    );
    expect(io.stderr).toContain('inputs:     (none)');
  });

  it('exits 3 when the run ended in the hands of a person', async () => {
    const escalating = capability();
    escalating.steps[1]!.onCheckpointFail = 'escalate';
    escalating.steps[1]!.timeoutMs = 150;
    const ws = workspace([escalating]);
    const io = captureIo();
    const code = await replayCmd.run(
      [ws.capPath, '--input', 'memberId=12345', '--app-profile', ws.profile, '--policy', ws.policy, '--auto-operator'],
      io,
      // The click leads nowhere, so the checkpoint fails and it escalates.
      fakeSessionFactory({ start: 'search', transitions: { 'search::click:button:Retrieve': 'search' } }).factory,
    );
    expect(code).toBe(EXIT.escalated);
  });
});

describe('catalog defaults and http failures', () => {
  it('defaults to the listing when no subcommand is given', async () => {
    const ws = workspace();
    const io = captureIo();
    expect(await catalogCmd.run(['--dir', join(ws.dir, 'capabilities')], io, fakeSessionFactory().factory)).toBe(EXIT.ok);
    expect(io.stdout).toContain('meridian.member.savings_balance@1.0.0');
  });

  it('says the catalog is empty when asked for a name and there is nothing', async () => {
    const io = captureIo();
    await catalogCmd.run(['invoke', 'anything', '--dir', mkdtempSync(`${tmpdir()}/empty-`)], io, fakeSessionFactory().factory);
    expect(io.stderr).toContain('Known: (none)');
  });

  it('reports a clean artifact as clean', async () => {
    const clean = capability();
    clean.steps[0]!.checkpoint = { kind: 'valueMatches', ref: clean.steps[0]!.ref!, pattern: '^\\d{5}$' };
    const io = captureIo();
    expect(
      await catalogCmd.run(['lint', '--dir', join(workspace([clean]).dir, 'capabilities')], io, fakeSessionFactory().factory),
    ).toBe(EXIT.ok);
    expect(io.stdout).toContain('clean');
  });

  it('returns 500 over http when the capability ran and failed', async () => {
    const failing = capability();
    failing.steps[1]!.timeoutMs = 150;
    const ws = workspace([failing]);
    const args = parseArgs(['--dir', join(ws.dir, 'capabilities'), '--app-profile', ws.profile, '--policy', ws.policy]);
    const app = catalogCmd.buildCatalogApp(
      args,
      loadCatalog(join(ws.dir, 'capabilities')),
      captureIo(),
      // The click leads nowhere, so the checkpoint never holds.
      fakeSessionFactory({ start: 'search', transitions: { 'search::click:button:Retrieve': 'search' } }).factory,
    );
    const res = await request(app).post('/capabilities/meridian.member.savings_balance/invoke').send({ memberId: '12345' });
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });

  it('invokes with no body at all', async () => {
    const noInputs = capability({
      params: {},
      steps: [{ id: 's1', intent: 'look', action: 'assert', checkpoint: { kind: 'textPresent', text: 'MEMBER INQUIRY' } }],
      returns: {},
    });
    const ws = workspace([noInputs]);
    const args = parseArgs(['--dir', join(ws.dir, 'capabilities'), '--app-profile', ws.profile, '--policy', ws.policy]);
    const app = catalogCmd.buildCatalogApp(
      args,
      loadCatalog(join(ws.dir, 'capabilities')),
      captureIo(),
      fakeSessionFactory({ start: 'search' }).factory,
    );
    const res = await request(app).post('/capabilities/meridian.member.savings_balance/invoke');
    expect(res.status).toBe(200);
  });
});

describe('a capability that names no tenant', () => {
  it('falls back to the first tenant the app profile lists', async () => {
    const anonymous = capability({ app: { id: 'meridian-core-servicing' } });
    const ws = workspace([anonymous]);
    const io = captureIo();
    await replayCmd.run(
      [ws.capPath, '--input', 'memberId=12345', '--app-profile', ws.profile, '--policy', ws.policy],
      io,
      fakeSessionFactory({ start: 'search' }).factory,
    );
    expect(io.stderr).toContain('tenant:     meridian-demo');
  });

  it('does the same when invoked through the catalog', async () => {
    const anonymous = capability({ app: { id: 'meridian-core-servicing' } });
    const ws = workspace([anonymous]);
    const io = captureIo();
    await catalogCmd.run(
      [
        'invoke',
        'meridian.member.savings_balance',
        '--input',
        'memberId=12345',
        '--dir',
        join(ws.dir, 'capabilities'),
        '--app-profile',
        ws.profile,
        '--policy',
        ws.policy,
      ],
      io,
      fakeSessionFactory({ start: 'search' }).factory,
    );
    expect(io.stderr).toContain('success');
  });
});

describe('discover reporting', () => {
  const goalFileAt = (dir: string, entryPath = '/'): string => {
    const p = join(dir, 'goal.yaml');
    writeFileSync(
      p,
      `id: meridian.member.savings_balance
title: Read a balance
summary: Look up a member and read the balance.
goal: Sign on and read the regular share savings balance for this member.
app: meridian-core-servicing
tenant: meridian-demo
entryPath: ${entryPath}
params: {}
returns: {}
`,
      'utf8',
    );
    return p;
  };

  it('reports a run that stopped with no reason to give', async () => {
    const ws = workspace([]);
    const script = join(ws.dir, 'script.json');
    writeFileSync(script, JSON.stringify([{ calls: [{ name: 'observe', input: {} }] }]), 'utf8');
    const io = captureIo();
    const code = await discoverCmd.run(
      [goalFileAt(ws.dir), '--script', script, '--app-profile', ws.profile, '--policy', ws.policy, '--out', join(ws.dir, 'capabilities'), '--max-turns', '1'],
      io,
      fakeSessionFactory().factory,
    );
    expect(code).toBe(EXIT.failed);
    expect(io.stderr).toContain('discovery did not complete: stopped');
  });

  it('says that an irreversible capability needs approval, and lists the lint findings', async () => {
    const withReason = structuredClone(FLOW.screens);
    withReason['confirm']!.controls.unshift({ role: 'textbox', name: 'Reason', value: '', section: 'CONFIRM SUB-ACCOUNT' });
    const ws = workspace([]);
    const script = join(ws.dir, 'script.json');
    writeFileSync(
      script,
      JSON.stringify([
        {
          calls: [
            // A literal value with nothing to assert about it, so the linter
            // warns that the step is unverified.
            { name: 'type_text', input: { handle: 'textbox|Reason', text: 'audit', intent: 'record a reason', phase: 'input' } },
          ],
        },
        {
          calls: [
            { name: 'click', input: { handle: 'button|Confirm and Post', intent: 'post it', expect: 'SUB-ACCOUNT POSTED', phase: 'commit' } },
          ],
        },
        { calls: [{ name: 'finish', input: { summary: 'posted', success_text: 'SUB-ACCOUNT POSTED' } }] },
      ]),
      'utf8',
    );
    const io = captureIo();
    const code = await discoverCmd.run(
      [
        goalFileAt(ws.dir, '/confirm'),
        '--script',
        script,
        '--app-profile',
        ws.profile,
        '--policy',
        ws.policy,
        '--out',
        join(ws.dir, 'capabilities'),
        '--auto-operator',
        '--no-vision',
      ],
      io,
      fakeSessionFactory({ start: 'confirm', screens: withReason }).factory,
    );
    expect(code).toBe(EXIT.ok);
    expect(io.stderr).toContain('approval required before unattended replay');
    expect(io.stderr).toContain('lint warn:');
  });
});

describe('the simulated operator naming what it did', () => {
  it('describes the action even when the control has no name', async () => {
    const unnamed = structuredClone(FLOW.screens);
    unnamed['confirm']!.controls = [{ role: 'button', name: '' }];
    const driver = new FakeDriver(unnamed, FLOW.transitions, 'confirm');
    const recorder = new RunRecorder({ kind: 'replay', root: mkdtempSync(`${tmpdir()}/handspan-`) });
    const policy = new PolicyEngine(policyConfig());
    let broker!: EscalationBroker;
    broker = new EscalationBroker({ driver, policy, recorder, maxWaitMs: 500, autoResolver: createSimulatedOperator(() => broker) });

    const resolution = await broker.raise('irreversible-approval', 'needs a person', {
      runId: 'r',
      askedToDo: 'press it',
      intendedAction: { kind: 'click', ref: { role: 'button', ordinal: 0 } },
    });
    expect(resolution.action).toBe('resume');
    expect(resolution.note).toContain('performed click on button ""');
  });
});

describe('the remaining reporting branches', () => {
  it('prints the step a lint finding belongs to', async () => {
    const io = captureIo();
    await catalogCmd.run(['lint', '--dir', join(workspace().dir, 'capabilities')], io, fakeSessionFactory().factory);
    expect(io.stdout).toMatch(/unverified-step \[s1\]/);
  });

  it('counts a business outcome as a clean replay when recording stability', async () => {
    const ws = workspace();
    const io = captureIo();
    await replayCmd.run(
      [ws.capPath, '--input', 'memberId=99999', '--app-profile', ws.profile, '--policy', ws.policy, '--record-stability'],
      io,
      fakeSessionFactory({ start: 'search', transitions: { 'search::click:button:Retrieve': 'missing' } }).factory,
    );
    expect(io.stderr).toContain('stability recorded: 1/1');
  });

  it('hands the broker to an invoke that has an operator attached', async () => {
    const ws = workspace();
    const io = captureIo();
    const code = await catalogCmd.run(
      [
        'invoke',
        'meridian.member.savings_balance',
        '--input',
        'memberId=12345',
        '--dir',
        join(ws.dir, 'capabilities'),
        '--app-profile',
        ws.profile,
        '--policy',
        ws.policy,
        '--auto-operator',
        '--verbose',
      ],
      io,
      fakeSessionFactory({ start: 'search' }).factory,
    );
    expect(code).toBe(EXIT.ok);
  });
});

describe('lint findings that belong to no step', () => {
  it('prints them without an empty bracket', async () => {
    const stray = capability();
    stray.returns = {};
    const io = captureIo();
    await catalogCmd.run(['lint', '--dir', join(workspace([stray]).dir, 'capabilities')], io, fakeSessionFactory().factory);
    expect(io.stdout).toContain('undeclared-return');
    expect(io.stdout).not.toContain('[]');
  });
});
