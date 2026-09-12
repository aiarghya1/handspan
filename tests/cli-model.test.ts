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

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    beta = {
      messages: {
        stream: (params: Record<string, unknown>) => {
          constructed.push(params);
          return {
            finalMessage: async () => ({
              content: [
                { type: 'text', text: 'I will stop here.' },
                { type: 'tool_use', id: 't1', name: 'finish', input: { summary: 'nothing to do', success_text: 'MERIDIAN' } },
              ],
              stop_reason: 'tool_use',
              usage: { input_tokens: 5, output_tokens: 3 },
            }),
          };
        },
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
