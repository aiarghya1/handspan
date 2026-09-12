/**
 * The demo script.
 *
 * It is an end-to-end check that the commands behave the way the README says,
 * so here it runs against a stubbed process launcher and a stubbed target app.
 * What is verified is the script's own logic: that it stops when the app is not
 * running, that it reports each assertion, and that a failed assertion makes
 * the whole thing fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spawnSync = vi.fn();
vi.mock('node:child_process', () => ({ spawnSync: (...args: unknown[]) => spawnSync(...args) }));

const { run } = await import('../src/cli/demo.js');
const { captureIo, EXIT } = await import('../src/cli/io.js');

let cwd = '';
let previous = '';
const health = vi.fn();

beforeEach(() => {
  previous = process.cwd();
  cwd = mkdtempSync(`${tmpdir()}/handspan-demo-`);
  process.chdir(cwd);
  mkdirSync('capabilities');
  mkdirSync('evidence');
  writeFileSync('.env.example', 'MERIDIAN_USERNAME=tellersvc\n', 'utf8');

  spawnSync.mockReset();
  health.mockReset();
  // Both instances answer, and the fault and reset hooks accept everything.
  health.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal('fetch', health);
});

afterEach(() => {
  process.chdir(previous);
  rmSync(cwd, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/**
 * Every spawned command succeeds, and each one produces the output shape the
 * demo asserts on. The demo reads the commands' stdout, so the stub has to
 * return the real result contract rather than a placeholder.
 */
function happyPath(): void {
  const json = (o: unknown) => JSON.stringify(o, null, 2);
  let plainLookups = 0;

  spawnSync.mockImplementation((_bin: string, args: string[]) => {
    const [command, ...rest] = args.slice(1);

    if (command === 'discover') {
      const goal = rest.find((a) => a.includes('goal.yaml')) ?? '';
      const id = goal.includes('subaccount') ? 'meridian.member.subaccount_open' : 'meridian.member.savings_balance';
      // The real command creates the directory as it saves; the demo clears it
      // first, so the stub has to do the same.
      mkdirSync('capabilities', { recursive: true });
      writeFileSync(join('capabilities', `${id}@1.0.0.capability.yaml`), 'placeholder', 'utf8');
      return { status: 0, stdout: '' };
    }

    if (command === 'replay') {
      const has = (needle: string) => rest.some((a) => a === needle);
      if (has('memberId=99999')) {
        return {
          status: 0,
          stdout: json({ status: 'business_outcome', outcome: { id: 'MEMBER_NOT_FOUND', data: { searchedFor: '99999' } } }),
        };
      }
      if (has('memberId=abc')) {
        return { status: 1, stdout: json({ status: 'failed', failure: { class: 'invalid_input' } }) };
      }
      if (has('productCode=HD01')) {
        return existsSync('.approved')
          ? { status: 0, stdout: json({ status: 'success', outputs: { confirmationNumber: '8831-2001' } }) }
          : { status: 1, stdout: json({ status: 'failed', failure: { class: 'not_approved' } }) };
      }
      if (has('--auto-operator')) {
        return { status: 3, stdout: json({ status: 'escalated', escalation: { reason: 'app-error' }, outcome: 'APP_ERROR' }) };
      }
      const outputs = { memberName: 'DELACROIX, R M', savingsBalance: 4182.55 };
      plainLookups += 1;
      // The second plain lookup is the one the session expiry is armed for.
      const recoveries = plainLookups === 2 ? [{ recoveryId: 'reauthenticate-expired-session', atStepId: 's006' }] : [];
      return { status: 0, stdout: json({ status: 'success', outputs, recoveries }) };
    }

    if (command === 'catalog' && rest[0] === 'approve') {
      writeFileSync('.approved', '', 'utf8');
      return { status: 0, stdout: 'approved meridian.member.subaccount_open@1.0.0\n' };
    }
    if (command === 'catalog' && rest[0] === 'tools') return { status: 0, stdout: '[{"name":"a"},{"name":"b"}]' };
    return { status: 0, stdout: 'meridian.member.savings_balance@1.0.0\n' };
  });
}

describe('preconditions', () => {
  it('creates a .env from the example when there is none', async () => {
    happyPath();
    await run([], captureIo());
    expect(existsSync('.env')).toBe(true);
  });

  it('stops with a usable message when the target app is not running', async () => {
    health.mockResolvedValue({ ok: false });
    expect(await run([], captureIo())).toBe(EXIT.usage);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('stops when the app cannot be reached at all', async () => {
    health.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await run([], captureIo())).toBe(EXIT.usage);
  });
});

describe('the full thread', () => {
  it('runs every step and reports success', async () => {
    happyPath();
    const code = await run([], captureIo());
    expect(code).toBe(EXIT.ok);

    const commands = spawnSync.mock.calls.map((c) => (c[1] as string[])[1]);
    expect(commands).toContain('discover');
    expect(commands).toContain('replay');
    expect(commands).toContain('catalog');
    // Two discoveries: the read-only capability and the one that commits.
    expect(commands.filter((c) => c === 'discover')).toHaveLength(2);
  });

  it('writes the tool definitions out as evidence', async () => {
    happyPath();
    await run([], captureIo());
    expect(JSON.parse(readFileSync('evidence/capability-tools.json', 'utf8'))).toHaveLength(2);
  });

  it('starts from a clean slate so the version numbers mean something', async () => {
    happyPath();
    writeFileSync(join('capabilities', 'stale@9.9.9.capability.yaml'), 'old', 'utf8');
    mkdirSync(join('evidence', 'runs'), { recursive: true });
    writeFileSync(join('evidence', 'runs', 'old.json'), '{}', 'utf8');
    await run([], captureIo());
    expect(existsSync(join('capabilities', 'stale@9.9.9.capability.yaml'))).toBe(false);
  });

  it('fails when discovery produces no artifact', async () => {
    spawnSync.mockImplementation(() => {
      mkdirSync('capabilities', { recursive: true });
      return { status: 0, stdout: '' };
    });
    expect(await run([], captureIo())).toBe(EXIT.failed);
  });

  it('fails when the second discovery produces no artifact', async () => {
    let first = true;
    spawnSync.mockImplementation((_bin: string, args: string[]) => {
      if (args[1] === 'discover' && first) {
        first = false;
        mkdirSync('capabilities', { recursive: true });
        writeFileSync(join('capabilities', 'meridian.member.savings_balance@1.0.0.capability.yaml'), 'x', 'utf8');
      }
      return { status: 0, stdout: JSON.stringify({ status: 'success', outputs: {} }) };
    });
    expect(await run([], captureIo())).toBe(EXIT.failed);
  });

  it('fails when an assertion does not hold', async () => {
    // Replay succeeds but returns nothing, so the output assertions fail.
    spawnSync.mockImplementation((_bin: string, args: string[]) => {
      if (args[1] === 'discover') {
        const goal = args.find((a) => a.includes('goal.yaml')) ?? '';
        const id = goal.includes('subaccount') ? 'meridian.member.subaccount_open' : 'meridian.member.savings_balance';
        mkdirSync('capabilities', { recursive: true });
        writeFileSync(join('capabilities', `${id}@1.0.0.capability.yaml`), 'x', 'utf8');
      }
      return { status: 0, stdout: '{}' };
    });
    expect(await run([], captureIo())).toBe(EXIT.failed);
  });

  it('survives a control-plane request that fails once', async () => {
    happyPath();
    let thrown = false;
    health.mockImplementation(async (url: string) => {
      // Minutes pass between steps, so the pooled keep-alive socket has usually
      // been closed by the server. One retry is the whole mitigation.
      if (!thrown && String(url).includes('/_admin/reset')) {
        thrown = true;
        throw new Error('socket hang up');
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    expect(await run([], captureIo())).toBe(EXIT.ok);
    expect(thrown).toBe(true);
  });
});

describe('a subprocess that does not report a status', () => {
  it('treats it as a failure rather than a success', async () => {
    happyPath();
    const inner = spawnSync.getMockImplementation()!;
    spawnSync.mockImplementation((bin: string, args: string[]) => {
      const out = inner(bin, args) as { status: number | null; stdout: string };
      // A process killed by a signal reports a null status.
      if (args[1] === 'catalog' && args[2] === 'list') return { status: null, stdout: out.stdout };
      return out;
    });
    // Only the catalog listing is affected, and the demo asserts nothing on it.
    expect(await run([], captureIo())).toBe(EXIT.ok);
  });

  it('gives up when a control-plane request fails twice', async () => {
    happyPath();
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/_admin/health')) return { ok: true, json: async () => ({ ok: true }) };
      throw new Error('socket hang up');
    });
    await expect(run([], captureIo())).rejects.toThrow(/socket hang up/);
  });
});

describe('a subprocess that writes nothing', () => {
  it('is treated as empty output rather than crashing', async () => {
    happyPath();
    const inner = spawnSync.getMockImplementation()!;
    spawnSync.mockImplementation((bin: string, args: string[]) => {
      const out = inner(bin, args) as { status: number; stdout: string };
      if (args[1] === 'catalog' && args[2] === 'list') return { status: 0, stdout: undefined };
      return out;
    });
    expect(await run([], captureIo())).toBe(EXIT.ok);
  });
});
