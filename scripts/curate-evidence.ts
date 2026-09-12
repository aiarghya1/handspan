/**
 * Curate the last set of runs under evidence/runs/ into named directories that
 * are worth committing, and write the index.
 *
 * Run directories are timestamped and disposable; the repository should carry a
 * small, labelled set that a reader can follow without running anything.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Summary {
  steps?: Array<{ stepId: string; status: string; note?: string }>;
  status?: string;
  /** Discovery summaries only. */
  artifactPath?: string;
  /** The planner that drove a discovery run; 'scripted' when there was no model. */
  model?: string;
  version?: string;
  actions?: number;
  turns?: number;
  blockedActions?: number;
  failure?: { class?: string; message?: string; stepId?: string; expected?: string; observed?: string };
  outcome?: { id?: string; detail?: string; data?: Record<string, unknown> };
  escalation?: { reason?: string; resolution?: string; note?: string };
  outputs?: Record<string, unknown>;
  recoveries?: Array<{ recoveryId: string; atStepId: string }>;
  degradedSteps?: string[];
  tenant?: string;
  capabilityId?: string;
  humanAssisted?: boolean;
  capabilityVersion?: string;
}

const RUNS = 'evidence/runs';
const OUT = 'evidence';

/** Does this run's log contain an event of the given kind? */
const logHas = (id: string, kind: string): boolean => {
  const p = join(RUNS, id, 'run.jsonl');
  if (!existsSync(p)) return false;
  return readFileSync(p, 'utf8').includes(`"kind":"${kind}"`);
};

/**
 * Named slot -> a predicate over the run. Evaluated in order and each run is
 * claimed once, so the most specific slots come first.
 */
const WANTED: Array<{ dir: string; caption: string; match: (s: Summary, id: string) => boolean }> = [
  {
    dir: '09-operator-takeover-and-resume',
    caption: 'A human takes control of the live session through the operator console, clears the screen by hand, is refused when they try to navigate outside the allowlist, hands control back, and the run resumes and completes. Every manual action is in `run.jsonl` as an `operator.action` event, including the refused one.',
    match: (s, id) => id.startsWith('replay') && s.status === 'success' && logHas(id, 'operator.action'),
  },
  {
    dir: '01-discovery-savings-balance',
    caption: 'Discovery. The agent signs on with a vault reference it never sees, meets the maintenance interstitial, navigates to member inquiry, looks up a member and reads two declared return values. Compiles to the artifact below.',
    match: (s, id) => id.startsWith('discovery') && s.capabilityId === 'meridian.member.savings_balance',
  },
  {
    dir: '02-replay-success',
    caption: 'Deterministic replay, no model. Typed outputs returned; the interstitial handled by a declared recovery rather than by a recorded step.',
    match: (s) => s.status === 'success' && (s.recoveries ?? []).length === 1 && s.tenant === 'meridian-demo',
  },
  {
    dir: '03-replay-business-outcome',
    caption: 'A member that does not exist. Reported as the named outcome MEMBER_NOT_FOUND with the id it searched for, not as a failure.',
    match: (s) => s.status === 'business_outcome',
  },
  {
    dir: '04-replay-session-expired',
    caption: 'The session expires part-way through the flow. The recovery re-authenticates and rebuilds the prefix with replayFrom: signon, and the run still succeeds.',
    match: (s) => (s.recoveries ?? []).some((r) => r.recoveryId === 'reauthenticate-expired-session'),
  },
  {
    dir: '05-replay-app-error-escalated',
    caption: 'The application aborts a transaction. Escalated to a human rather than retried, because nothing the caller can do with an abend reference.',
    match: (s) => s.status === 'escalated',
  },
  {
    dir: '06-replay-cross-tenant',
    caption: 'The same artifact, unchanged, against a second institution on a later and differently branded build of the same vendor product. Two label aliases carry it.',
    match: (s) => s.tenant === 'cu-northstar',
  },
  {
    dir: '07-discovery-subaccount-escalation',
    caption: 'Discovery of a flow that commits. Policy refuses the posting, the intervention is routed with the exact action it wanted, an operator performs it in the same live session and hands control back, and the run continues. The artifact comes out irreversible and requiring approval.',
    match: (s, id) => id.startsWith('discovery') && s.capabilityId === 'meridian.member.subaccount_open',
  },
  {
    dir: '08-replay-subaccount-posted',
    caption: 'The approved capability replays unattended, posts the sub-account, and returns the confirmation reference. Before approval the same call is refused with not_approved.',
    match: (s) => s.status === 'success' && Boolean(s.outputs && 'confirmationNumber' in s.outputs),
  },
];

const summaryOf = (id: string): Summary => {
  const p = join(RUNS, id, 'summary.json');
  if (!existsSync(p)) return {};
  const s = JSON.parse(readFileSync(p, 'utf8')) as Summary;
  // A discovery summary records the capability it produced rather than a
  // replay result, so give the matcher that field either way.
  return s;
};

const ids = readdirSync(RUNS).sort();
const taken = new Set<string>();
const placed: Array<{ dir: string; caption: string; id: string; s: Summary }> = [];

/**
 * Among the runs that fit a slot, prefer one a model actually drove. The demo
 * is scripted by design, so a genuine discovery run sitting alongside it would
 * otherwise lose the slot to whichever ran first - and the genuine one is
 * precisely the run the repository exists to show. Replay summaries carry no
 * model, so for those this is the earliest match, exactly as before.
 */
const pickFor = (want: (typeof WANTED)[number]): string | undefined => {
  const matches = ids.filter((i) => !taken.has(i) && want.match(summaryOf(i), i));
  return matches.find((i) => {
    const model = summaryOf(i).model;
    return model !== undefined && model !== 'scripted';
  }) ?? matches[0];
};

for (const want of WANTED) {
  const id = pickFor(want);
  if (!id) {
    console.error(`  no run matched ${want.dir}`);
    continue;
  }
  taken.add(id);
  const dest = join(OUT, want.dir);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(join(RUNS, id), dest, { recursive: true });
  placed.push({ dir: want.dir, caption: want.caption, id, s: summaryOf(id) });
  const model = summaryOf(id).model;
  console.error(`  ${want.dir} <- ${id}${model && model !== 'scripted' ? `  (model: ${model})` : ''}`);
}

// The artifact discovery produced, kept beside the runs so the repo is readable
// without running anything.
mkdirSync(join(OUT, 'capability'), { recursive: true });
for (const f of readdirSync('capabilities')) {
  cpSync(join('capabilities', f), join(OUT, 'capability', f));
}

const describe = (s: Summary): string => {
  if (s.artifactPath) {
    const human = s.humanAssisted ? ', 1 step performed by an operator' : '';
    return `recorded ${s.capabilityId}@${s.version}, ${s.actions} actions${human}`;
  }
  if (s.status === 'success') return `success, outputs ${JSON.stringify(s.outputs)}`;
  if (s.status === 'business_outcome') return `business outcome ${s.outcome?.id}, data ${JSON.stringify(s.outcome?.data ?? {})}`;
  if (s.status === 'escalated') return `escalated (${s.escalation?.reason}) -> ${s.escalation?.resolution ?? 'unresolved'}`;
  if (s.status === 'failed') return `failed [${s.failure?.class}] at ${s.failure?.stepId ?? 'setup'}`;
  return 'discovery run';
};

const lines: string[] = [
  '# Evidence index',
  '',
  'Produced by `npm run demo`. Each directory is one run; see',
  '[README.md](README.md) for what the files inside are.',
  '',
  '| Run | Result | What it demonstrates |',
  '|---|---|---|',
];
for (const p of [...placed].sort((a, b) => a.dir.localeCompare(b.dir))) {
  lines.push(`| [\`${p.dir}\`](${p.dir}/) | ${describe(p.s)} | ${p.caption} |`);
}
lines.push('');
lines.push('## The artifact');
lines.push('');
lines.push('[`capability/`](capability/) holds the capability artifacts the discovery');
lines.push('runs compiled. They are the review unit: the whole public contract is the');
lines.push('`params`, `returns` and `outcomes` at the top, and every step carries the');
lines.push('condition that proves it worked.');
lines.push('');
lines.push('## A note on how these were produced');
lines.push('');
lines.push('The runs here used the scripted planner rather than a live model, because no');
lines.push('model credential was available in the environment this was built in. The');
lines.push('pipeline is identical either way. See the last section of');
lines.push('[../REPORT.md](../REPORT.md).');

writeFileSync(join(OUT, 'INDEX.md'), `${lines.join('\n')}\n`, 'utf8');
console.error(`\n  wrote ${join(OUT, 'INDEX.md')} with ${placed.length} runs`);
