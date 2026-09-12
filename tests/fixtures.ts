/**
 * Shared fixtures: an app profile, a goal spec, and a small screen graph that
 * mirrors the shape of the real mock app - sign on, search, detail - without a
 * browser.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { zAppProfile, type AppProfile } from '../src/artifact/app-profile.js';
import { zGoalSpec, type GoalSpec } from '../src/discover/goal.js';
import { DEFAULT_POLICY, PolicyEngine, type PolicyConfig } from '../src/policy/policy.js';
import { RunRecorder } from '../src/obs/recorder.js';
import type { FakeScreen, Transitions } from './fake-driver.js';

export const BASE = 'http://app.test';

export const appProfile = (over: Record<string, unknown> = {}): AppProfile =>
  zAppProfile.parse({
    id: 'meridian-core-servicing',
    title: 'Meridian Core Servicing',
    vendor: 'Meridian',
    vendorVersion: '8.4',
    surface: 'web-legacy',
    secrets: ['meridian.username', 'meridian.password'],
    policy: { allowedPathPrefixes: ['/'], sensitivePatterns: ['\\b\\d{3}-\\d{2}-\\d{4}\\b'] },
    outcomes: [
      {
        id: 'MEMBER_NOT_FOUND',
        description: 'The member number does not exist on this core.',
        detect: { kind: 'textPresent', text: 'No member found for' },
        disposition: 'return',
      },
    ],
    recoveries: [
      {
        id: 'dismiss-maintenance-notice',
        description: 'dismiss the nightly batch notice',
        when: { kind: 'controlPresent', ref: { role: 'dialog', name: 'Scheduled Maintenance', nameMatch: 'contains' } },
        do: [{ kind: 'click', ref: { role: 'button', name: 'Continue', scope: { section: 'Scheduled Maintenance' } } }],
      },
    ],
    tenants: {
      'meridian-demo': { baseUrl: BASE, appVersion: '8.4', nameAliases: {} },
      'cu-northstar': { baseUrl: 'http://other.test', appVersion: '9.1', nameAliases: { Retrieve: 'Search' } },
    },
    ...over,
  }) as AppProfile;

export const goalSpec = (over: Record<string, unknown> = {}): GoalSpec =>
  zGoalSpec.parse({
    id: 'meridian.member.savings_balance',
    title: "Read a member's savings balance",
    summary: 'Look up a member and return their regular share savings balance.',
    goal: 'Sign on, look up the member by number, and read their regular share savings balance.',
    app: 'meridian-core-servicing',
    tenant: 'meridian-demo',
    entryPath: '/',
    params: {
      memberId: {
        type: 'string',
        description: 'The 5-digit member number.',
        pattern: '^\\d{5}$',
        sensitivity: 'pii-id',
        value: '12345',
      },
    },
    returns: {
      savingsBalance: { type: 'money', description: 'Ledger balance.', sensitivity: 'account' },
    },
    ...over,
  }) as GoalSpec;

export const policyConfig = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({
  ...DEFAULT_POLICY,
  allowedOrigins: [BASE, 'http://other.test'],
  ...over,
});

export const recorder = (kind: 'discovery' | 'replay' = 'discovery'): RunRecorder =>
  new RunRecorder({ kind, root: mkdtempSync(`${tmpdir()}/handspan-`) });

export const engine = (over: Partial<PolicyConfig> = {}): PolicyEngine => new PolicyEngine(policyConfig(over));

// -- the screen graph -------------------------------------------------------

export const SIGNON: FakeScreen = {
  url: `${BASE}/`,
  title: 'Sign On',
  text: 'MERIDIAN CORE SERVICING 8.4',
  controls: [
    { role: 'textbox', name: 'Operator ID', value: '', section: 'MERIDIAN CORE SERVICING 8.4' },
    { role: 'password', name: 'Password', value: '', section: 'MERIDIAN CORE SERVICING 8.4' },
    { role: 'button', name: 'Sign On', section: 'MERIDIAN CORE SERVICING 8.4' },
  ],
};

export const HOME_WITH_NOTICE: FakeScreen = {
  url: `${BASE}/main`,
  text: 'MENU Select a function from the menu.',
  controls: [
    { role: 'dialog', name: 'Scheduled Maintenance', section: 'Scheduled Maintenance', frame: 'main' },
    { role: 'button', name: 'Continue', section: 'Scheduled Maintenance', frame: 'main' },
    { role: 'link', name: 'Member Inquiry', section: 'MENU', frame: 'nav' },
  ],
};

export const HOME: FakeScreen = {
  url: `${BASE}/main`,
  text: 'MENU Select a function from the menu.',
  controls: [{ role: 'link', name: 'Member Inquiry', section: 'MENU', frame: 'nav' }],
};

export const SEARCH: FakeScreen = {
  url: `${BASE}/member/search`,
  text: 'MEMBER INQUIRY',
  controls: [
    { role: 'textbox', name: 'Member Number', value: '', section: 'MEMBER INQUIRY', frame: 'main' },
    { role: 'button', name: 'Retrieve', section: 'MEMBER INQUIRY', frame: 'main' },
  ],
};

export const DETAIL: FakeScreen = {
  url: `${BASE}/member/12345`,
  text: 'MEMBER DETAIL - 12345',
  controls: [
    { role: 'cell', name: 'Name', value: 'DELACROIX, R M', section: 'MEMBER DETAIL - 12345', rowText: 'Name DELACROIX, R M', frame: 'main' },
    {
      role: 'cell',
      name: 'Balance',
      nameSource: 'column-header',
      value: '4182.55',
      section: 'MEMBER DETAIL - 12345',
      rowText: '0001 REGULAR SHARE SAVINGS 4182.55',
      frame: 'main',
    },
    {
      role: 'cell',
      name: 'Product',
      nameSource: 'column-header',
      value: 'REGULAR SHARE SAVINGS',
      section: 'MEMBER DETAIL - 12345',
      rowText: '0001 REGULAR SHARE SAVINGS 4182.55',
      frame: 'main',
    },
    // A second share, so "Balance" is ambiguous and the recorder has to scope
    // the extraction by row - which is the case that matters on a real grid.
    {
      role: 'cell',
      name: 'Product',
      nameSource: 'column-header',
      value: 'PRIMARY CHECKING',
      section: 'MEMBER DETAIL - 12345',
      rowText: '0075 PRIMARY CHECKING 913.20',
      frame: 'main',
    },
    {
      role: 'cell',
      name: 'Balance',
      nameSource: 'column-header',
      value: '913.20',
      section: 'MEMBER DETAIL - 12345',
      rowText: '0075 PRIMARY CHECKING 913.20',
      frame: 'main',
    },
    { role: 'link', name: 'Open Sub-Account', section: 'MEMBER DETAIL - 12345', frame: 'main' },
  ],
};

export const NOT_FOUND: FakeScreen = {
  url: `${BASE}/member/search`,
  text: 'MEMBER INQUIRY',
  alerts: ['No member found for 99999.'],
  controls: SEARCH.controls,
};

export const CONFIRM: FakeScreen = {
  url: `${BASE}/confirm`,
  text: 'CONFIRM SUB-ACCOUNT',
  controls: [{ role: 'button', name: 'Confirm and Post', section: 'CONFIRM SUB-ACCOUNT', frame: 'main' }],
};

export const POSTED: FakeScreen = {
  url: `${BASE}/posted`,
  text: 'SUB-ACCOUNT POSTED Share 23456-2001 created. Confirmation 8831-2001.',
  controls: [],
};

/** The happy path through the screens above. */
export const FLOW: { screens: Record<string, FakeScreen>; transitions: Transitions } = {
  screens: { signon: SIGNON, notice: HOME_WITH_NOTICE, home: HOME, search: SEARCH, detail: DETAIL, missing: NOT_FOUND, confirm: CONFIRM, posted: POSTED },
  transitions: {
    'signon::click:button:Sign On': 'notice',
    'notice::click:button:Continue': 'home',
    'home::click:link:Member Inquiry': 'search',
    'search::click:button:Retrieve': 'detail',
    'detail::click:link:Open Sub-Account': 'confirm',
    'confirm::click:button:Confirm and Post': 'posted',
  },
};
