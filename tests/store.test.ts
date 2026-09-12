/**
 * Artifact integrity, approval, versioning and the catalog on disk.
 *
 * The property worth guarding hardest: approval is pinned to the exact
 * behaviour that was reviewed, so editing a step revokes it.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  capabilityFileName,
  compareVersions,
  computeContentHash,
  isApprovedForUnattended,
  latestById,
  loadCapabilityFile,
  loadCatalog,
  maxRisk,
  parseCapability,
  riskRank,
  saveCapability,
  serializeCapability,
} from '../src/artifact/store.js';
import { API_VERSION, zCapability } from '../src/artifact/schema.js';
import { capability } from './capability-fixture.js';

describe('content hash', () => {
  it('is stable across key ordering and a YAML round trip', () => {
    const cap = capability();
    const round = parseCapability(serializeCapability(cap));
    expect(computeContentHash(round)).toBe(computeContentHash(cap));
  });

  it('ignores provenance, so recording a replay result does not invalidate approval', () => {
    const cap = capability();
    const before = computeContentHash(cap);
    cap.provenance.stability = { runs: 9, successes: 9, degradedSteps: [] };
    expect(computeContentHash(cap)).toBe(before);
  });

  it('changes when a single step changes', () => {
    const cap = capability();
    const before = computeContentHash(cap);
    cap.steps[1]!.ref = { role: 'button', name: 'Search' };
    expect(computeContentHash(cap)).not.toBe(before);
  });
});
describe('approval', () => {
  it('does not gate a capability that declares no approval requirement', () => {
    expect(isApprovedForUnattended(capability()).ok).toBe(true);
  });

  it('refuses an unapproved capability that requires approval', () => {
    const cap = capability({ policy: { riskTier: 'irreversible', allowedOrigins: ['http://a.test'], allowedPathPrefixes: [], allowedActions: ['click'], requiresApproval: true } });
    expect(isApprovedForUnattended(cap).ok).toBe(false);
  });

  it('refuses an approval whose pinned hash no longer matches the artifact', () => {
    // Approval means "this exact behaviour was reviewed". Editing a step after
    // sign-off must revoke it, or approval is decorative.
    const cap = capability({ policy: { riskTier: 'irreversible', allowedOrigins: ['http://a.test'], allowedPathPrefixes: [], allowedActions: ['click'], requiresApproval: true } });
    cap.provenance.approval = { state: 'approved', by: 'reviewer', at: 'now', contentHash: computeContentHash(cap) };
    expect(isApprovedForUnattended(cap).ok).toBe(true);

    cap.steps[1]!.ref = { role: 'button', name: 'Post' };
    const after = isApprovedForUnattended(cap);
    expect(after.ok).toBe(false);
    expect(after.reason).toContain('changed since approval');
  });
});
describe('the catalog on disk', () => {
  it('reads every artifact in a directory, and nothing else', () => {
    const dir = mkdtempSync(`${tmpdir()}/handspan-cat-`);
    const cap = capability();
    writeFileSync(join(dir, capabilityFileName(cap)), serializeCapability(cap), 'utf8');
    writeFileSync(join(dir, 'notes.txt'), 'ignore me', 'utf8');

    const entries = loadCatalog(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.capability.id).toBe('meridian.member.balance');
    expect(entries[0]!.path).toContain('meridian.member.balance@1.0.0.capability.yaml');
  });

  it('returns nothing for a directory that does not exist', () => {
    expect(loadCatalog(join(tmpdir(), 'handspan-definitely-absent'))).toEqual([]);
  });

  it('names a file after the capability and its version', () => {
    expect(capabilityFileName(capability({ version: '2.3.4' }))).toBe('meridian.member.balance@2.3.4.capability.yaml');
  });

  it('round-trips through save and load', () => {
    const dir = mkdtempSync(`${tmpdir()}/handspan-cat-`);
    const path = saveCapability(dir, capability());
    expect(loadCapabilityFile(path).id).toBe('meridian.member.balance');
  });

  it('picks the highest version per id', () => {
    const dir = mkdtempSync(`${tmpdir()}/handspan-cat-`);
    for (const v of ['1.0.0', '1.10.0', '1.9.0']) saveCapability(dir, capability({ version: v }));
    saveCapability(dir, capability({ id: 'meridian.member.other', version: '3.0.0' }));

    const best = latestById(loadCatalog(dir));
    expect(best.get('meridian.member.balance')!.capability.version).toBe('1.10.0');
    expect(best.get('meridian.member.other')!.capability.version).toBe('3.0.0');
  });

  it('compares versions numerically, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.1')).toBeLessThan(0);
  });

  it('writes a reviewer-facing header above the artifact', () => {
    const text = serializeCapability(capability());
    expect(text.startsWith('# Read a balance')).toBe(true);
    expect(text).toContain('Reviewer checklist');
    expect(text).toContain('contentHash:');
  });
});
describe('risk ordering', () => {
  it('ranks the tiers, and takes the worse of two', () => {
    expect(riskRank('read_only')).toBeLessThan(riskRank('reversible_write'));
    expect(riskRank('reversible_write')).toBeLessThan(riskRank('irreversible'));
    expect(maxRisk('read_only', 'irreversible')).toBe('irreversible');
    expect(maxRisk('irreversible', 'reversible_write')).toBe('irreversible');
  });
});
describe('comparing versions of different lengths', () => {
  it('treats a missing component as zero, in both directions', () => {
    expect(compareVersions('1.0.1', '1.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});
