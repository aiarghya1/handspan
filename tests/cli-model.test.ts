/**
 * The discover command's model path.
 *
 * The SDK is stubbed, so what is checked is the wiring the real run depends on:
 * the model and effort come from the flags or the environment, the system
 * prompt and the goal reach the planner, and the model's narration is written
 * into the run log.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const constructed: Array<Record<string, unknown>> = [];

/** Set to make the stubbed SDK reject the beta request. */
let betaThrows: unknown = null;
/** Set to make the plain request the planner falls back to reject too. */
let plainThrows: unknown = null;

const finished = {
  finalMessage: async () => ({
    content: [
      { type: 'text', text: 'I will stop here.' },
      { type: 'tool_use', id: 't1', name: 'finish', input: { summary: 'nothing to do', success_text: 'MERIDIAN' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 5, output_tokens: 3 },
  }),
};

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    beta = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          constructed.push(params);
          if (betaThrows) throw betaThrows;
          return finished;
        },
      },
    };
    // The path the planner falls through to when the fallback beta is refused.
    messages = {
      stream: (params: Record<string, unknown>) => {
        constructed.push(params);
        if (plainThrows) throw plainThrows;
        return finished;
      },
    };
  },
}));

const { run } = await import('../src/cli/discover.js');
const { captureIo, EXIT } = await import('../src/cli/io.js');
const { openSession } = await import('../src/cli/shared.js');
const { RunRecorder } = await import('../src/obs/recorder.js');
const { PolicyEngine } = await import('../src/policy/policy.js');
const { FakeDriver } = await import('./fake-driver.js');
const { BASE, FLOW, policyConfig } = await import('./fixtures.js');

type SessionFactory = Parameters<typeof run>[2];

const sessions: Array<{ recorder: InstanceType<typeof RunRecorder> }> = [];

const factory: SessionFactory = async (opts) => {
  const driver = new FakeDriver(structuredClone(FLOW.screens), FLOW.transitions, 'signon');
  const recorder = new RunRecorder({ kind: opts.kind, root: mkdtempSync(`${tmpdir()}/handspan-`) });
  sessions.push({ recorder });
  return {
    driver: driver as never,
    recorder,
    policy: new PolicyEngine(opts.policyConfig),
    broker: undefined as never,
    hasOperator: false,
    secrets: { get: (k: string) => `value-of-${k}` } as never,
    close: async () => {},
  };
};

function workspace(): { goal: string; profile: string; policy: string; out: string } {
  const dir = mkdtempSync(`${tmpdir()}/handspan-model-`);
  const goal = join(dir, 'goal.yaml');
  writeFileSync(
    goal,
    `id: meridian.member.savings_balance
title: Read a balance
summary: Look up a member and read the balance.
goal: Sign on and read the regular share savings balance for the member.
app: meridian-core-servicing
tenant: meridian-demo
entryPath: /
params: {}
returns: {}
`,
    'utf8',
  );
  const profile = join(dir, 'app.yaml');
  writeFileSync(
    profile,
    `id: meridian-core-servicing
title: Meridian Core Servicing
surface: web-legacy
secrets: [meridian.password]
tenants:
  meridian-demo: { baseUrl: "${BASE}" }
`,
    'utf8',
  );
  const policy = join(dir, 'policy.yaml');
  writeFileSync(policy, `allowedOrigins: ["${BASE}"]\nonIrreversible: escalate\n`, 'utf8');
  const out = join(dir, 'capabilities');
  mkdirSync(out);
  return { goal, profile, policy, out };
}

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  constructed.length = 0;
  sessions.length = 0;
  betaThrows = null;
  plainThrows = null;
  saved = {
    key: process.env['ANTHROPIC_API_KEY'],
    model: process.env['HANDSPAN_MODEL'],
    effort: process.env['HANDSPAN_EFFORT'],
  };
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-not-a-real-key';
  delete process.env['HANDSPAN_MODEL'];
  delete process.env['HANDSPAN_EFFORT'];
});

afterEach(() => {
  for (const [k, v] of [['ANTHROPIC_API_KEY', saved['key']], ['HANDSPAN_MODEL', saved['model']], ['HANDSPAN_EFFORT', saved['effort']]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('the model path', () => {
  it('constructs the planner with the default model and effort', async () => {
    const ws = workspace();
    const io = captureIo();
    const code = await run([ws.goal, '--app-profile', ws.profile, '--policy', ws.policy, '--out', ws.out, '--no-vision'], io, factory);

    expect(code).toBe(EXIT.ok);
    expect(io.stderr).toContain('planner: claude-opus-5');
    expect(constructed[0]).toMatchObject({ model: 'claude-opus-5', output_config: { effort: 'high' } });
  });

  it('sends the system prompt and the goal to the model', async () => {
    const ws = workspace();
    await run([ws.goal, '--app-profile', ws.profile, '--policy', ws.policy, '--out', ws.out, '--no-vision'], captureIo(), factory);
    const params = constructed[0]!;
    expect(JSON.stringify(params['system'])).toContain('recorded and turned into a script');
    expect(JSON.stringify(params['messages'])).toContain('Sign on and read the regular share savings balance');
  });

  it('takes the model and effort from the environment', async () => {
    process.env['HANDSPAN_MODEL'] = 'claude-sonnet-5';
    process.env['HANDSPAN_EFFORT'] = 'low';
    const ws = workspace();
    await run([ws.goal, '--app-profile', ws.profile, '--policy', ws.policy, '--out', ws.out, '--no-vision'], captureIo(), factory);
    expect(constructed[0]).toMatchObject({ model: 'claude-sonnet-5', output_config: { effort: 'low' } });
  });

  it('lets the flags override the environment', async () => {
    process.env['HANDSPAN_MODEL'] = 'claude-sonnet-5';
    const ws = workspace();
    await run(
      [ws.goal, '--app-profile', ws.profile, '--policy', ws.policy, '--out', ws.out, '--no-vision', '--model', 'claude-opus-4-8', '--effort', 'max'],
      captureIo(),
      factory,
    );
    expect(constructed[0]).toMatchObject({ model: 'claude-opus-4-8', output_config: { effort: 'max' } });
  });

  it('writes the narration the model produced into the run log', async () => {
    const ws = workspace();
    await run([ws.goal, '--app-profile', ws.profile, '--policy', ws.policy, '--out', ws.out, '--no-vision'], captureIo(), factory);
    const log = await import('node:fs').then((fs) => fs.readFileSync(join(sessions[0]!.recorder.dir, 'run.jsonl'), 'utf8'));
    expect(log).toContain('"source":"model"');
    expect(log).toContain('I will stop here.');
  });

  it('falls back to a plain request when the beta is refused', async () => {
    betaThrows = Object.assign(new Error('unknown beta'), { status: 400 });
    const ws = workspace();
    expect(
      await run([ws.goal, '--app-profile', ws.profile, '--policy', ws.policy, '--out', ws.out, '--no-vision'], captureIo(), factory),
    ).toBe(EXIT.ok);
    const log = await import('node:fs').then((fs) => fs.readFileSync(join(sessions[0]!.recorder.dir, 'run.jsonl'), 'utf8'));
    expect(log).toContain('server-side fallbacks unavailable');
  });

  it('starts even when only an auth token is set', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'token';
    try {
      const ws = workspace();
      const io = captureIo();
      expect(
        await run([ws.goal, '--app-profile', ws.profile, '--policy', ws.policy, '--out', ws.out, '--no-vision'], io, factory),
      ).toBe(EXIT.ok);
    } finally {
      delete process.env['ANTHROPIC_AUTH_TOKEN'];
    }
  });
});

/**
 * Credential handling.
 *
 * A pre-check can only see that a variable is set, so an invalid key used to
 * reach the SDK and surface as an unhandled 401 stack trace - which is what a
 * reviewer got by following the README's `cp .env.example .env` literally.
 * Both halves are covered here: absent, and present but rejected.
 */
describe('model credentials', () => {
  it('treats a blank key as no key at all', async () => {
    process.env['ANTHROPIC_API_KEY'] = '   ';
    const ws = workspace();
    const io = captureIo();
    const code = await run([ws.goal, '--app-profile', ws.profile, '--policy', ws.policy, '--out', ws.out], io, factory);

    expect(code).toBe(EXIT.usage);
    expect(io.stderr).toContain('No model credentials found');
    expect(sessions).toHaveLength(0);
  });

  it('reports a rejected credential instead of throwing the SDK error', async () => {
    betaThrows = Object.assign(new Error('401 authentication_error'), { status: 401 });
    const ws = workspace();
    const io = captureIo();
    const code = await run([ws.goal, '--app-profile', ws.profile, '--policy', ws.policy, '--out', ws.out, '--no-vision'], io, factory);

    expect(code).toBe(EXIT.usage);
    expect(io.stderr).toContain('The model rejected the credential');
    expect(io.stderr).not.toContain('AuthenticationError');
  });

  it('records the rejection in the run log', async () => {
    betaThrows = Object.assign(new Error('403 permission_error'), { status: 403 });
    const ws = workspace();
    await run([ws.goal, '--app-profile', ws.profile, '--policy', ws.policy, '--out', ws.out, '--no-vision'], captureIo(), factory);
    const log = await import('node:fs').then((fs) => fs.readFileSync(join(sessions[0]!.recorder.dir, 'run.jsonl'), 'utf8'));
    expect(log).toContain('model rejected the credential');
    expect(log).not.toContain('server-side fallbacks unavailable');
  });

  it('still lets a genuine fault surface as itself', async () => {
    const overloaded = Object.assign(new Error('overloaded'), { status: 529 });
    betaThrows = overloaded;
    plainThrows = overloaded;
    const ws = workspace();
    await expect(
      run([ws.goal, '--app-profile', ws.profile, '--policy', ws.policy, '--out', ws.out, '--no-vision'], captureIo(), factory),
    ).rejects.toThrow('overloaded');
  });
});
