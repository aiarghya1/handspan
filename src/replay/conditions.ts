/**
 * Condition evaluation.
 *
 * One evaluator serves step checkpoints, business-outcome detection and
 * recovery triggers. That is worth a note: it means "did the step work",
 * "is this a known business outcome" and "is this a known interstitial" are
 * all asked in the same language, against the same observation, so they can
 * never disagree about what is on screen.
 *
 * Conditions are evaluated against an `Observation`, never against the live
 * page directly. Everything in one decision therefore sees a consistent
 * snapshot, rather than three checks racing a navigation.
 *
 * `urlMatches` deliberately matches the top document *or any frame*. In a
 * frameset the address bar never changes, so a condition that only looked at
 * the top URL would be useless on exactly the surfaces this system targets.
 */

import type { Condition, FrameSelector, Observation, SurfaceDriver } from '../surface/types.js';
import { tryResolveFromControls } from '../surface/match.js';

export interface ConditionResult {
  ok: boolean;
  /** Human-readable reason, used verbatim in failures and intervention context. */
  detail: string;
}

function framesFor(obs: Observation, sel: FrameSelector | undefined) {
  if (!sel) return obs.frames;
  return obs.frames.filter((f) =>
    sel.name !== undefined
      ? f.framePath.some((p) => p.name === sel.name)
      : sel.index !== undefined
        ? f.framePath.some((p) => p.index === sel.index)
        : true,
  );
}

function haystack(obs: Observation, sel: FrameSelector | undefined): string {
  return framesFor(obs, sel)
    .map((f) => `${f.text} ${f.alerts.join(' ')}`)
    .join('\n');
}

function textHit(obs: Observation, text: string, regex: boolean | undefined, sel: FrameSelector | undefined): boolean {
  const hay = haystack(obs, sel);
  if (regex) {
    try {
      return new RegExp(text, 'i').test(hay);
    } catch {
      return false;
    }
  }
  return hay.toLowerCase().includes(text.toLowerCase());
}

export function evaluateCondition(cond: Condition, obs: Observation): ConditionResult {
  switch (cond.kind) {
    case 'urlMatches': {
      const urls = [obs.url, ...obs.frames.map((f) => f.url)];
      let re: RegExp;
      try {
        re = new RegExp(cond.pattern);
      } catch {
        return { ok: false, detail: `urlMatches has an invalid pattern: ${cond.pattern}` };
      }
      const hit = urls.find((u) => re.test(u));
      return hit
        ? { ok: true, detail: `url ${hit} matches /${cond.pattern}/` }
        : { ok: false, detail: `no frame url matches /${cond.pattern}/ (saw ${urls.join(', ')})` };
    }
    case 'textPresent': {
      const ok = textHit(obs, cond.text, cond.regex, cond.frame);
      return { ok, detail: ok ? `found "${cond.text}"` : `did not find "${cond.text}" on screen` };
    }
    case 'textAbsent': {
      const hit = textHit(obs, cond.text, cond.regex, cond.frame);
      return { ok: !hit, detail: hit ? `"${cond.text}" is present but should not be` : `"${cond.text}" is absent` };
    }
    case 'controlPresent': {
      const r = tryResolveFromControls(cond.ref, obs.controls);
      return r
        ? { ok: true, detail: `found ${cond.ref.role} "${cond.ref.name ?? ''}" at tier ${r.tier}` }
        : { ok: false, detail: `no ${cond.ref.role} named "${cond.ref.name ?? ''}" on screen` };
    }
    case 'controlAbsent': {
      const r = tryResolveFromControls(cond.ref, obs.controls);
      return r
        ? { ok: false, detail: `${cond.ref.role} "${cond.ref.name ?? ''}" is present but should not be` }
        : { ok: true, detail: `${cond.ref.role} "${cond.ref.name ?? ''}" is absent` };
    }
    case 'valueMatches': {
      const r = tryResolveFromControls(cond.ref, obs.controls);
      if (!r) return { ok: false, detail: `cannot read ${cond.ref.role} "${cond.ref.name ?? ''}": not on screen` };
      const value = r.control.value ?? '';
      let re: RegExp;
      try {
        re = new RegExp(cond.pattern);
      } catch {
        return { ok: false, detail: `valueMatches has an invalid pattern: ${cond.pattern}` };
      }
      const ok = re.test(value);
      return { ok, detail: ok ? `value matches /${cond.pattern}/` : `value did not match /${cond.pattern}/` };
    }
    case 'allOf': {
      const results = cond.of.map((c) => evaluateCondition(c, obs));
      const bad = results.find((r) => !r.ok);
      return bad ? { ok: false, detail: bad.detail } : { ok: true, detail: results.map((r) => r.detail).join('; ') };
    }
    case 'anyOf': {
      const results = cond.of.map((c) => evaluateCondition(c, obs));
      const good = results.find((r) => r.ok);
      return good
        ? { ok: true, detail: good.detail }
        : { ok: false, detail: `none of: ${results.map((r) => r.detail).join(' | ')}` };
    }
    case 'not': {
      const r = evaluateCondition(cond.of, obs);
      return { ok: !r.ok, detail: r.ok ? `expected NOT: ${r.detail}` : `negation holds: ${r.detail}` };
    }
  }
}

export function describeCondition(cond: Condition): string {
  switch (cond.kind) {
    case 'urlMatches':
      return `url matches /${cond.pattern}/`;
    case 'textPresent':
      return `the screen shows "${cond.text}"`;
    case 'textAbsent':
      return `the screen does not show "${cond.text}"`;
    case 'controlPresent':
      return `a ${cond.ref.role} named "${cond.ref.name ?? ''}" is on screen`;
    case 'controlAbsent':
      return `no ${cond.ref.role} named "${cond.ref.name ?? ''}" is on screen`;
    case 'valueMatches':
      return `${cond.ref.role} "${cond.ref.name ?? ''}" matches /${cond.pattern}/`;
    case 'allOf':
      return cond.of.map(describeCondition).join(' and ');
    case 'anyOf':
      return cond.of.map(describeCondition).join(' or ');
    case 'not':
      return `not (${describeCondition(cond.of)})`;
  }
}

export interface WaitResult extends ConditionResult {
  observation: Observation;
  waitedMs: number;
  polls: number;
}

/**
 * Poll until the condition holds or the budget runs out.
 *
 * This, not the driver's post-action settle, is where replay's timing
 * determinism actually comes from. The driver makes a best effort to wait for
 * a navigation; the engine keeps asking the question until the answer is yes.
 * A slow screen therefore costs latency, not a failure - which is the correct
 * behaviour for the "transient slowness" condition the brief calls out.
 */
export async function waitForCondition(
  driver: SurfaceDriver,
  cond: Condition,
  timeoutMs: number,
  pollMs = 300,
): Promise<WaitResult> {
  const started = Date.now();
  let polls = 0;
  let last: ConditionResult = { ok: false, detail: 'never evaluated' };
  let obs: Observation = await driver.observe();

  for (;;) {
    polls += 1;
    last = evaluateCondition(cond, obs);
    if (last.ok) break;
    if (Date.now() - started >= timeoutMs) break;
    await new Promise((r) => setTimeout(r, pollMs));
    obs = await driver.observe();
  }

  return { ...last, observation: obs, waitedMs: Date.now() - started, polls };
}
