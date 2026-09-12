/**
 * The prompt.
 *
 * Not an assertion about wording, but about the facts the model must be given
 * or it cannot do the job: the allowed origin, the parameter values, the return
 * names it has to use verbatim, and the vault keys - never the credentials.
 */

import { describe, expect, it } from 'vitest';
import { firstMessage, systemPrompt } from '../src/discover/prompts.js';
import { appProfile, goalSpec, BASE } from './fixtures.js';

describe('the system prompt', () => {
  it('tells the model this run is a recording, not a one-off', () => {
    const p = systemPrompt(appProfile());
    expect(p).toContain('recorded and turned into a script');
    expect(p).toContain('without you in the loop');
  });

  it('names the application and its release', () => {
    expect(systemPrompt(appProfile())).toContain('Meridian Core Servicing (Meridian 8.4)');
  });

  it('omits the vendor clause when the profile has none', () => {
    const p = systemPrompt(appProfile({ vendor: undefined, vendorVersion: undefined }));
    expect(p).toContain('Meridian Core Servicing.');
    expect(p).not.toContain('(undefined');
  });

  it('names the vendor without a version when only one is known', () => {
    expect(systemPrompt(appProfile({ vendorVersion: undefined }))).toContain('(Meridian)');
  });

  it('explains why it may only act by handle', () => {
    const p = systemPrompt(appProfile());
    expect(p).toContain('act by handle');
    expect(p).toContain('a coordinate cannot be replayed');
  });

  it('tells it that a checkpoint must hold for any input, with the example that matters', () => {
    const p = systemPrompt(appProfile());
    expect(p).toContain('"MEMBER DETAIL" is good');
    expect(p).toContain('"MEMBER DETAIL - 12345" is not');
  });

  it('tells it a refusal is the expected path, not a failure', () => {
    expect(systemPrompt(appProfile())).toContain('That is the expected path, not an error');
  });

  it('tells it never to expect a credential', () => {
    const p = systemPrompt(appProfile());
    expect(p).toContain('never be shown a password');
    expect(p).toContain('do not guess them');
  });
});

describe('the first message', () => {
  const entry = `${BASE}/`;

  it('states the goal, the boundary and the starting point', () => {
    const m = firstMessage(goalSpec(), appProfile(), BASE, entry);
    expect(m).toContain('Sign on, look up the member by number');
    expect(m).toContain(`Allowed origin: ${BASE}`);
    expect(m).toContain(`Start here: ${entry}`);
    expect(m.trimEnd().endsWith('Begin by calling observe.')).toBe(true);
  });

  it('gives each parameter its type, meaning and value for this run', () => {
    const m = firstMessage(goalSpec(), appProfile(), BASE, entry);
    expect(m).toContain('memberId: string - The 5-digit member number.');
    expect(m).toContain('value for this run: 12345');
  });

  it('names the return values the model must read back', () => {
    expect(firstMessage(goalSpec(), appProfile(), BASE, entry)).toContain('savingsBalance: money - Ledger balance.');
  });

  it('lists the vault keys and nothing else', () => {
    const m = firstMessage(goalSpec({ secrets: ['extra.token'] }), appProfile(), BASE, entry);
    expect(m).toContain('meridian.username');
    expect(m).toContain('meridian.password');
    expect(m).toContain('extra.token');
    expect(m).not.toContain('demo-pass');
  });

  it('leaves out sections that have nothing in them', () => {
    const bare = goalSpec({ params: {}, returns: {} });
    const m = firstMessage(bare, appProfile({ secrets: [] }), BASE, entry);
    expect(m).not.toContain('INPUT PARAMETERS');
    expect(m).not.toContain('VALUES YOU MUST READ BACK');
    expect(m).not.toContain('AVAILABLE CREDENTIALS');
  });

  it('does not repeat a secret the app profile and the goal both declare', () => {
    const m = firstMessage(goalSpec({ secrets: ['meridian.password'] }), appProfile(), BASE, entry);
    expect(m.match(/meridian\.password/g)).toHaveLength(1);
  });
});
