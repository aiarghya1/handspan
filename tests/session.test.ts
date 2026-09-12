/**
 * Session assembly.
 *
 * `openSession` is the one place the dependency graph is wired together, and it
 * launches a real browser, so this is the test that proves the pieces fit: the
 * driver carries the policy's sensitive patterns, the console is served only
 * when a port is given, and `hasOperator` is false when there is nowhere for an
 * intervention to go.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { openSession, type Session } from '../src/cli/shared.js';
import { appProfile, policyConfig } from './fixtures.js';

const open: Session[] = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function session(opts: Parameters<typeof openSession>[0]): Promise<Session> {
  const s = await openSession(opts);
  open.push(s);
  return s;
}

describe('openSession', () => {
  it('assembles a driver, a recorder, a policy and a broker', async () => {
    const s = await session({ kind: 'replay', app: appProfile(), policyConfig: policyConfig() });
    expect(s.driver.surface).toBe('web-legacy');
    expect(s.recorder.runId).toMatch(/^replay-/);
    expect(s.policy.config.allowedOrigins).toContain('http://app.test');
    expect(s.broker.control.current).toBe('automation');
    expect(s.secrets.get('nothing.here')).toBeUndefined();
  }, 90_000);

  it('reports no operator when there is nowhere for an intervention to go', async () => {
    const s = await session({ kind: 'replay', app: appProfile(), policyConfig: policyConfig() });
    expect(s.hasOperator).toBe(false);
    expect(s.console).toBeUndefined();
  }, 90_000);

  it('serves the console, and reports an operator, when given a port', async () => {
    const s = await session({ kind: 'replay', app: appProfile(), policyConfig: policyConfig(), operatorPort: 0 });
    expect(s.hasOperator).toBe(true);
    expect(s.console?.url).toMatch(/^http:\/\/localhost:\d+$/);
    const res = await fetch(`${s.console!.url}/api/state`);
    expect((await res.json()).controller).toBe('automation');
  }, 90_000);

  it('reports an operator when a simulated one is attached', async () => {
    const s = await session({ kind: 'replay', app: appProfile(), policyConfig: policyConfig(), autoOperator: true });
    expect(s.hasOperator).toBe(true);
  }, 90_000);

  it('takes the sensitive patterns from the app profile as well as the policy', async () => {
    const s = await session({
      kind: 'discovery',
      app: appProfile({ policy: { allowedPathPrefixes: [], sensitivePatterns: ['\\bAPP-ONLY-\\d+\\b'] } }),
      policyConfig: policyConfig({ sensitivePatterns: ['\\bPOLICY-ONLY-\\d+\\b'] }),
    });
    expect(s.policy.config.sensitivePatterns).toEqual(['\\bPOLICY-ONLY-\\d+\\b', '\\bAPP-ONLY-\\d+\\b']);
  }, 90_000);

  it('falls back to the app profile path prefixes when the policy sets none', async () => {
    const s = await session({
      kind: 'replay',
      app: appProfile({ policy: { allowedPathPrefixes: ['/member'], sensitivePatterns: [] } }),
      policyConfig: policyConfig({ allowedPathPrefixes: [] }),
    });
    expect(s.policy.config.allowedPathPrefixes).toEqual(['/member']);
  }, 90_000);

  it('keeps the policy path prefixes when it has them', async () => {
    const s = await session({
      kind: 'replay',
      app: appProfile({ policy: { allowedPathPrefixes: ['/member'], sensitivePatterns: [] } }),
      policyConfig: policyConfig({ allowedPathPrefixes: ['/only'] }),
    });
    expect(s.policy.config.allowedPathPrefixes).toEqual(['/only']);
  }, 90_000);

  it('exposes a devtools url when the session was launched with a debug port', async () => {
    const s = await session({
      kind: 'replay',
      app: appProfile(),
      policyConfig: policyConfig(),
      debugPort: 0,
      operatorPort: 0,
    });
    // Offered to the operator so they can attach a full browser to the same page.
    expect(s.broker.liveSessionUrl).toBe('http://localhost:0');
  }, 90_000);

  it('honours a run id, so a caller can name the evidence directory', async () => {
    const runId = `unit-${Date.now()}`;
    const s = await session({ kind: 'replay', app: appProfile(), policyConfig: policyConfig(), runId });
    expect(s.recorder.runId).toBe(runId);
  }, 90_000);
});
