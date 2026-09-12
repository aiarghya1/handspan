/**
 * handspan demo - the whole thread, in one command.
 *
 * Runs discovery, then replays the artifact it produced against four different
 * runtime conditions, then shows the capability catalog. Uses the scripted
 * planner so it is deterministic and needs no API key; `npm run discover` with
 * a goal file and a key is the same pipeline with the model in the loop.
 *
 * The point of the four replays is the error taxonomy. The same artifact,
 * unchanged, has to produce four different and correctly classified results.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { EXIT, type Io } from './io.js';

const BASE = 'http://localhost:8099';
const V9 = 'http://localhost:8199';

/**
 * Counts failed assertions for one run. Owned by `main` rather than the module,
 * so a second invocation in the same process starts from zero.
 */
function checker(): { ok: (label: string, cond: boolean) => void; failures: () => number } {
  let failures = 0;
  return {
    ok(label, cond) {
      console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}`);
      if (!cond) failures += 1;
    },
    failures: () => failures,
  };
}

/** Runs one handspan command as a subprocess and reports how it went. */
function step(args: string[], label: string): { code: number; stdout: string } {
  console.log(`\n$ handspan ${args.join(' ')}`);
  const r = spawnSync('node_modules/.bin/tsx', ['bin/handspan.ts', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  console.log(`  -> exit ${r.status} (${label})`);
  return { code: r.status ?? 1, stdout: r.stdout ?? '' };
}

/**
 * Minutes pass between demo steps, so the pooled keep-alive socket has usually
 * been closed by the server. One retry is cheaper than reasoning about it.
 */
async function post(url: string, body?: unknown): Promise<void> {
  const send = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    await send();
  } catch {
    // One retry, because the failure mode is a socket the server closed while
    // the previous step was running rather than anything wrong with the request.
    await send();
  }
}

const fault = (kind: string, count = 1, onPath?: string) =>
  post(`${BASE}/_admin/fault`, { kind, count, onPath });
const reset = (url = BASE) => post(`${url}/_admin/reset`);

async function main(): Promise<number> {
  const { ok, failures } = checker();

  if (!existsSync('.env')) {
    copyFileSync('.env.example', '.env');
    console.log('created .env from .env.example (demo credentials only)');
  }

  for (const url of [BASE, V9]) {
    const res = await fetch(`${url}/_admin/health`).catch(() => null);
    if (!res?.ok) {
      console.error(`\nThe target app is not running on ${url}.`);
      console.error('Start both instances first:  npm run target-app   and   npm run target-app:v9\n');
      return EXIT.usage;
    }
  }

  // Start from nothing, so the catalog listing at the end is readable and the
  // version numbers mean what they say.
  rmSync('capabilities', { recursive: true, force: true });
  rmSync('evidence/runs', { recursive: true, force: true });

  console.log('\n=== 1. discovery: the model drives the app and the run is recorded =========');
  await reset();
  step(
    ['discover', 'config/goals/member-savings-balance.goal.yaml', '--script', 'config/scripts/member-savings-balance.script.json'],
    'discovery',
  );

  const artifact = readdirSync('capabilities')
    .filter((f) => f.startsWith('meridian.member.savings_balance'))
    .sort()
    .pop();
  if (!artifact) {
    console.error('discovery produced no artifact; stopping');
    return EXIT.failed;
  }
  const path = `capabilities/${artifact}`;

  console.log('\n=== 2. deterministic replay: same artifact, no model ======================');
  await reset();
  const a = step(['replay', path, '--input', 'memberId=12345'], 'expect success');
  ok('a known member returns typed outputs', a.code === 0 && a.stdout.includes('"status": "success"'));
  ok('the balance is returned as a number, not a rendered string', a.stdout.includes('"savingsBalance": 4182.55'));

  console.log('\n=== 3. a business outcome: an answer, not a crash =========================');
  await reset();
  const b = step(['replay', path, '--input', 'memberId=99999'], 'expect business_outcome');
  ok('an unknown member is reported as MEMBER_NOT_FOUND', b.stdout.includes('"MEMBER_NOT_FOUND"'));
  ok('it is not reported as a failure', !b.stdout.includes('"status": "failed"'));

  console.log('\n=== 4. a caller error, caught before the browser opens ====================');
  const c = step(['replay', path, '--input', 'memberId=abc'], 'expect invalid_input');
  ok('a malformed member number is rejected as invalid_input', c.stdout.includes('"invalid_input"'));

  console.log('\n=== 5. a recoverable condition: the session expires mid-flow ==============');
  await reset();
  // Placed on the member search POST, so the session dies *after* sign-on and
  // after the member number has been typed. Recovering therefore means
  // re-authenticating, re-navigating and re-entering the input - which is what
  // `replayFrom: signon` is for.
  await fault('session_expire', 1, '/member/search');
  const d = step(['replay', path, '--input', 'memberId=12345'], 'expect recovered success');
  ok('the run recovers from an expired session', d.stdout.includes('reauthenticate-expired-session'));

  console.log('\n=== 6. a hard failure: the application aborts =============================');
  await reset();
  await fault('app_error', 1);
  const e = step(['replay', path, '--input', 'memberId=12345', '--auto-operator'], 'expect escalated APP_ERROR');
  ok('an app abend is escalated to a human, not retried', e.stdout.includes('APP_ERROR') || e.stdout.includes('escalated'));

  console.log('\n=== 7. cross-tenant reuse: the same artifact on a second institution ======');
  await reset(V9);
  const f = step(['replay', path, '--input', 'memberId=12345', '--tenant', 'cu-northstar'], 'expect success on v9');
  ok('one artifact serves a differently-branded build of the same product', f.code === 0);

  console.log('\n=== 8. discovery of a flow that commits: the agent is refused =============');
  await reset();
  const g = step(
    ['discover', 'config/goals/member-open-subaccount.goal.yaml', '--script', 'config/scripts/member-open-subaccount.script.json', '--auto-operator'],
    'discovery with escalation',
  );
  ok('discovery completed with a human in the loop', g.code === 0);

  const sub = readdirSync('capabilities')
    .filter((f) => f.startsWith('meridian.member.subaccount_open'))
    .sort()
    .pop();
  if (!sub) {
    console.error('the second discovery produced no artifact; stopping');
    return EXIT.failed;
  }
  const subPath = `capabilities/${sub}`;

  console.log('\n=== 9. the approval gate =================================================');
  const h = step(
    ['replay', subPath, '--input', 'memberId=34567', '--input', 'productCode=HD01', '--input', 'initialDeposit=50.00'],
    'expect not_approved',
  );
  ok('an unapproved irreversible capability will not replay unattended', h.stdout.includes('not_approved'));

  step(['catalog', 'approve', subPath, '--by', 'R. Okafor', '--note', 'reviewed against change CR-8841'], 'approve');
  await reset();
  const i = step(
    ['replay', subPath, '--input', 'memberId=34567', '--input', 'productCode=HD01', '--input', 'initialDeposit=50.00'],
    'expect success',
  );
  ok('once approved, the same capability posts and returns its reference', i.stdout.includes('confirmationNumber'));

  console.log('\n=== 10. the agent-facing catalog ==========================================');
  const cat = step(['catalog', 'list'], 'catalog');
  console.log(cat.stdout);
  const tools = step(['catalog', 'tools'], 'tool definitions');
  writeFileSync('evidence/capability-tools.json', tools.stdout, 'utf8');
  console.log(`  wrote evidence/capability-tools.json (${JSON.parse(tools.stdout).length} callable capabilities)`);

  console.log('\nEvidence for every run above is under evidence/runs/.\n');
  return failures() > 0 ? EXIT.failed : EXIT.ok;
}

/**
 * The demo drives the CLIs as subprocesses, which is the point: it is a check
 * that the commands work the way the README says they do, not a unit test.
 */
export const run = (_argv: string[], _io: Io): Promise<number> => main();
