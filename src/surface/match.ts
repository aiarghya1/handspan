/**
 * The resolution ladder, as a pure function over a perceived control list.
 *
 * Kept free of Playwright so that (a) it is directly testable, (b) condition
 * evaluation and action targeting cannot drift apart - `controlPresent` asks
 * exactly the question `click` asks - and (c) a desktop adapter reuses the
 * ladder verbatim and only has to supply `observe`.
 */

import {
  AmbiguousControlError,
  ControlNotFoundError,
  LOCATOR_TIERS,
  type Control,
  type ControlRef,
  type LocatorTier,
  type Resolution,
} from './types.js';

/** Legacy labels gain and lose colons, casing and padding between releases. */
export function normalizeName(s: string | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .replace(/[:*]+\s*$/, '')
    .trim();
}

export function nameMatches(ref: ControlRef, control: Control): boolean {
  if (!ref.name) return true;
  const mode = ref.nameMatch ?? 'normalized';
  if (mode === 'exact') return control.name === ref.name;
  if (mode === 'regex') {
    try {
      return new RegExp(ref.name, 'i').test(control.name);
    } catch {
      return false;
    }
  }
  const a = normalizeName(control.name);
  const b = normalizeName(ref.name);
  return mode === 'contains' ? a.includes(b) : a === b;
}

export function frameMatches(ref: ControlRef, control: Control): boolean {
  const want = ref.scope?.frame;
  if (!want) return true;
  if (want.name !== undefined) return control.framePath.some((f) => f.name === want.name);
  if (want.index !== undefined) return control.framePath.some((f) => f.index === want.index);
  return true;
}

/** Section titles carry runtime suffixes ("MEMBER DETAIL - 12345"): match loosely. */
export function sectionMatches(ref: ControlRef, control: Control): boolean {
  const want = normalizeName(ref.scope?.section);
  if (!want) return true;
  const have = normalizeName(control.section);
  if (!have) return false;
  return have.includes(want) || want.includes(have);
}

export function rowMatches(ref: ControlRef, control: Control): boolean {
  const want = normalizeName(ref.scope?.rowContaining);
  if (!want) return true;
  const hay = `${normalizeName(control.rowKey)} ${normalizeName(control.rowText)}`;
  return hay.includes(want);
}

export function nearTextMatches(ref: ControlRef, control: Control): boolean {
  if (!ref.name) return false;
  const want = normalizeName(ref.name);
  const near = normalizeName(control.hints.nearText);
  return near.length > 0 && (near.includes(want) || want.includes(near));
}

export function candidatesAtTier(ref: ControlRef, controls: Control[], tier: LocatorTier): Control[] {
  const byRole = controls.filter((c) => c.role === ref.role);
  switch (tier) {
    case 'role+name+scope':
      return byRole.filter(
        (c) => nameMatches(ref, c) && frameMatches(ref, c) && sectionMatches(ref, c) && rowMatches(ref, c),
      );
    case 'role+name+frame':
      return byRole.filter((c) => nameMatches(ref, c) && frameMatches(ref, c));
    case 'role+name':
      return byRole.filter((c) => nameMatches(ref, c));
    case 'role+nearText':
      return byRole.filter((c) => nearTextMatches(ref, c) && frameMatches(ref, c));
    case 'hint-selector':
      return ref.hints?.selector
        ? byRole.filter((c) => c.hints.selector === ref.hints!.selector && frameMatches(ref, c))
        : [];
    case 'role+ordinal':
      return ref.ordinal === undefined
        ? []
        : byRole.filter((c) => frameMatches(ref, c) && sectionMatches(ref, c));
  }
}

/**
 * Walk the ladder and return the first tier that identifies exactly one
 * control, or one the ref's ordinal can pick out. Two matches and no ordinal is
 * an error rather than a guess: silently taking the first of two "Confirm"
 * buttons is how automation posts the wrong transaction.
 */
export function resolveFromControls(ref: ControlRef, controls: Control[]): Resolution {
  const tried: LocatorTier[] = [];
  for (const tier of LOCATOR_TIERS) {
    tried.push(tier);
    const candidates = candidatesAtTier(ref, controls, tier);
    if (candidates.length === 0) continue;
    if (candidates.length === 1) return { ref, control: candidates[0]!, tier, candidateCount: 1 };
    if (ref.ordinal !== undefined) {
      const exact = candidates.find((c) => c.ordinal === ref.ordinal);
      const chosen = exact ?? candidates[ref.ordinal];
      if (chosen) return { ref, control: chosen, tier, candidateCount: candidates.length };
    }
    throw new AmbiguousControlError(ref, tier, candidates.length);
  }
  throw new ControlNotFoundError(ref, tried);
}

/** Non-throwing form, for conditions that are asking "is this here?". */
export function tryResolveFromControls(ref: ControlRef, controls: Control[]): Resolution | null {
  try {
    return resolveFromControls(ref, controls);
  } catch {
    return null;
  }
}

/**
 * The most durable row descriptor for a cell in a data grid.
 *
 * Scoping a grid cell by ordinal is wrong: which row the savings account is in
 * depends on what products the member happens to hold. Scoping it by the whole
 * row text is also wrong, because the row text contains the balance we are
 * trying to read. What is durable is the row's own label - the product name -
 * so pick the longest word-shaped value among the row's other cells.
 */
export function deriveRowLabel(control: Control, controls: Control[]): string | undefined {
  if (!control.rowText) return undefined;
  const siblings = controls.filter(
    (c) => c.role === 'cell' && c.rowText === control.rowText && c !== control,
  );
  const wordy = siblings
    .map((c) => (c.value ?? '').trim())
    .filter((v) => v.length >= 4 && v.length <= 40 && /^[A-Za-z][A-Za-z \-\/&.']*$/.test(v))
    .sort((a, b) => b.length - a.length);
  return wordy[0];
}

/**
 * Build the most specific durable ref that still identifies this control
 * uniquely, given everything else that was on screen.
 *
 * The order of attempts is the whole decision, and it deliberately prefers the
 * *least* specific ref that is unambiguous. Over-scoping is what makes a
 * recording brittle: pinning a button to a section heading that happens to
 * contain a member number breaks on the next member.
 *
 * Row scoping is only tried for cells that came from a data grid, and only with
 * a derived row label rather than the raw row text. Layout tables fall through
 * to an ordinal instead, which is sound here precisely because these screens
 * change slowly - and if one ever does change, the artifact records the tier it
 * was captured at, so replay reports the degradation rather than acting on a
 * silently different control.
 */
export function deriveRef(control: Control, controls: Control[]): ControlRef {
  const frame = control.framePath[control.framePath.length - 1];
  const base: ControlRef = {
    role: control.role,
    name: control.name || undefined,
    nameMatch: 'normalized',
  };
  const rowLabel = control.nameSource === 'column-header' ? deriveRowLabel(control, controls) : undefined;

  const attempts: ControlRef[] = [
    base,
    { ...base, scope: { frame } },
    { ...base, scope: { frame, section: control.section } },
    ...(rowLabel
      ? [
          { ...base, scope: { frame, rowContaining: rowLabel } },
          { ...base, scope: { frame, section: control.section, rowContaining: rowLabel } },
        ]
      : []),
  ];

  const hints = { selector: control.hints.selector, nearText: control.hints.nearText };

  for (const ref of attempts) {
    if (!ref.name) break;
    const hits = candidatesAtTier(ref, controls, 'role+name+scope');
    if (hits.length === 1 && hits[0] === control) return { ...ref, hints };
  }

  // Still ambiguous, or the control has no name at all: fall back to a position
  // within the tightest scope, keeping the selector hint as an escape route.
  return {
    ...base,
    scope: { frame, section: control.section, rowContaining: rowLabel },
    ordinal: control.ordinal,
    hints,
  };
}
