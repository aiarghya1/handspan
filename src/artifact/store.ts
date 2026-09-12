/**
 * Artifact persistence, integrity and versioning.
 *
 * Stored as YAML rather than JSON for one reason: a reviewer has to approve
 * these before they run unattended against a core banking system, and nested
 * conditions are legible in YAML and are not in JSON. The file is the review
 * unit, so it is optimized for reading.
 *
 * `contentHash` covers everything except provenance, so recording a replay
 * result or approving the artifact does not change it, while editing a single
 * step does. `provenance.approval.contentHash` pins an approval to the exact
 * behaviour that was reviewed.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { zCapability, type Capability, type CapabilityInput, type Risk } from './schema.js';

const RISK_ORDER: Risk[] = ['read_only', 'reversible_write', 'irreversible'];
export const riskRank = (r: Risk): number => RISK_ORDER.indexOf(r);
export const maxRisk = (a: Risk, b: Risk): Risk => (riskRank(a) >= riskRank(b) ? a : b);

// -- integrity --------------------------------------------------------------

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function computeContentHash(cap: Capability): string {
  const { provenance: _p, contentHash: _h, ...behaviour } = cap;
  return createHash('sha256').update(JSON.stringify(canonical(behaviour))).digest('hex').slice(0, 32);
}

export function isApprovedForUnattended(cap: Capability): { ok: boolean; reason?: string } {
  if (!cap.policy.requiresApproval) return { ok: true };
  const a = cap.provenance.approval;
  if (a.state !== 'approved') return { ok: false, reason: `approval state is "${a.state}"` };
  const hash = computeContentHash(cap);
  if (a.contentHash && a.contentHash !== hash) {
    return { ok: false, reason: `artifact changed since approval (approved ${a.contentHash}, now ${hash})` };
  }
  return { ok: true };
}

// -- read / write -----------------------------------------------------------

export function parseCapability(text: string): Capability {
  const raw = YAML.parse(text) as CapabilityInput;
  const cap = zCapability.parse(raw);
  return cap;
}

export function serializeCapability(cap: Capability): string {
  const withHash: Capability = { ...cap, contentHash: computeContentHash(cap) };
  const header = [
    `# ${withHash.title}`,
    `# ${withHash.summary}`,
    `#`,
    `# Reviewer checklist: inputs and returns below are the whole public contract.`,
    `# Every step carries the condition that proves it worked. Values are templates,`,
    `# never data: nothing in this file is a member, a balance or a credential.`,
    '',
  ].join('\n');
  return header + YAML.stringify(withHash, { lineWidth: 100 });
}

export function capabilityFileName(cap: Capability): string {
  return `${cap.id}@${cap.version}.capability.yaml`;
}

export function saveCapability(dir: string, cap: Capability): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, capabilityFileName(cap));
  writeFileSync(path, serializeCapability(cap), 'utf8');
  return path;
}

export function loadCapabilityFile(path: string): Capability {
  return parseCapability(readFileSync(path, 'utf8'));
}

export interface CatalogEntry {
  path: string;
  capability: Capability;
}

export function loadCatalog(dir: string): CatalogEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: CatalogEntry[] = [];
  for (const n of names.filter((n) => n.endsWith('.capability.yaml')).sort()) {
    const path = join(dir, n);
    out.push({ path, capability: loadCapabilityFile(path) });
  }
  return out;
}

/** Highest version per id, which is what a caller invoking by name should get. */
export function latestById(entries: CatalogEntry[]): Map<string, CatalogEntry> {
  const best = new Map<string, CatalogEntry>();
  for (const e of entries) {
    const cur = best.get(e.capability.id);
    if (!cur || compareVersions(e.capability.version, cur.capability.version) > 0) {
      best.set(e.capability.id, e);
    }
  }
  return best;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
