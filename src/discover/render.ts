/**
 * Rendering an observation for the model.
 *
 * The model gets two views of the same screen: this text, and a screenshot.
 * The text is the action space - every handle it can address - and the
 * screenshot is what lets it read a dense legacy layout the way an operator
 * does. Neither alone is enough: text without the picture loses the spatial
 * grouping that tells you which field belongs to which panel, and the picture
 * without text gives it nothing addressable to act on.
 *
 * Cells are rendered last and separately, because on a member detail screen
 * they outnumber the interactive controls ten to one and would otherwise bury
 * the buttons the model actually needs to find.
 */

import type { Observation } from '../surface/types.js';

const frameLabel = (path: Observation['controls'][number]['framePath']): string =>
  path.map((f) => f.name ?? `#${f.index}`).join('/') || 'top';

export function renderObservation(obs: Observation, opts: { maxCells?: number } = {}): string {
  const maxCells = opts.maxCells ?? 50;
  const lines: string[] = [];

  lines.push(`SCREEN at ${obs.at}`);
  lines.push(`Top document: ${obs.url}`);
  lines.push('Frames:');
  for (const f of obs.frames) {
    lines.push(`  ${frameLabel(f.framePath).padEnd(8)} ${f.url}`);
  }

  const alerts = obs.frames.flatMap((f) => f.alerts);
  if (alerts.length > 0) {
    lines.push('Alerts and dialogs currently on screen:');
    for (const a of alerts) lines.push(`  ! ${a}`);
  }

  const interactive = obs.controls.filter((c) => c.role !== 'cell');
  const cells = obs.controls.filter((c) => c.role === 'cell' && c.value);

  lines.push('');
  lines.push('Controls you can act on (use the handle in brackets):');
  if (interactive.length === 0) lines.push('  (none)');
  for (const c of interactive) {
    const bits = [
      `  [${c.handle}]`,
      c.role.padEnd(8),
      `"${c.name}"`,
    ];
    if (c.value !== undefined && c.value !== '') bits.push(`value="${c.value}"`);
    bits.push(`frame=${frameLabel(c.framePath)}`);
    if (c.section) bits.push(`screen="${c.section}"`);
    if (!c.enabled) bits.push('DISABLED');
    if (c.hints.attrs?.['options']) bits.push(`options=[${c.hints.attrs['options']}]`);
    lines.push(bits.join(' '));
  }

  if (cells.length > 0) {
    lines.push('');
    lines.push('Values on screen (table cells; "name" is the column header or the label beside it):');
    for (const c of cells.slice(0, maxCells)) {
      const row = c.rowText && c.rowText.length > 0 ? ` row="${c.rowText.slice(0, 70)}"` : '';
      lines.push(`  [${c.handle}] ${c.name ? `"${c.name}"` : '(unlabelled)'} = "${c.value}"${row}`);
    }
    if (cells.length > maxCells) lines.push(`  ... ${cells.length - maxCells} more cells not listed`);
  }

  return lines.join('\n');
}

/** A fingerprint of what is on screen, used to notice that nothing changed. */
export function observationSignature(obs: Observation): string {
  return [
    obs.frames.map((f) => f.url).join('|'),
    obs.controls.map((c) => `${c.role}:${c.name}`).join(','),
    obs.frames.flatMap((f) => f.alerts).join('|'),
  ].join('||');
}
