/**
 * In-page perception. This function is serialized and evaluated inside each
 * frame, so it must be self-contained: no imports, no outer-scope references.
 *
 * Why not just use the browser's accessibility tree? Because on the surfaces
 * this system exists for, it is mostly empty. A 2003-era servicing screen puts
 * `<input name="mbr_no">` in a `<td>` with the words "Member Number" in the
 * `<td>` next door - no `id`, no `<label for>`, no `aria-label`. Chromium
 * computes no accessible name for that input, which means the model sees an
 * anonymous box and the recorded artifact has nothing durable to key on.
 *
 * So the naming cascade below starts with the same signals the AX naming
 * algorithm uses (aria-label, aria-labelledby, label/for, wrapping label) and
 * then keeps going into the layout-derived signals that legacy markup actually
 * carries: the adjacent table cell, then preceding inline text. The result is a
 * superset of the AX name, and it is what makes `role + name` a usable primary
 * locator on these screens at all.
 *
 * On a modern surface you would back tiers 1-4 with CDP's real AX tree instead;
 * the output shape here is deliberately the same either way.
 */

export interface RawControl {
  /** Written back onto the element as data-hs-h so actions can re-find it. */
  handle: string;
  role: string;
  name: string;
  nameSource: string;
  value?: string;
  enabled: boolean;
  section?: string;
  rowKey?: string;
  /** Whole-row text, capped. Lets a ref say "the row containing X". */
  rowText?: string;
  bbox?: { x: number; y: number; width: number; height: number };
  selector?: string;
  tag: string;
  attrs: Record<string, string>;
  nearText?: string;
  sensitive?: boolean;
}

export interface RawFrameView {
  text: string;
  alerts: string[];
  controls: RawControl[];
}

/** Evaluated in-page. Returns everything the adapter needs from one frame. */
export function extractFrame(framePrefix: string): RawFrameView {
  // Handles are stamped onto elements so that acting on a control does not
  // depend on re-running this walk and getting the same ordering. They are
  // cleared on every observation and never survive a navigation.
  // Declared inside the function: everything this walk needs must live in its
  // own scope, because only the function body crosses into the page.
  const MAX_TEXT = 6000;

  for (const stale of Array.from(document.querySelectorAll('[data-hs-h]'))) {
    stale.removeAttribute('data-hs-h');
  }

  // A frame caught mid-navigation has no body yet. That is a normal transient
  // state rather than an error, and the caller's next observation picks it up.
  const body = document.body;
  if (!body) return { text: '', alerts: [], controls: [] };
  const norm = (s: string | null | undefined): string =>
    (s ?? '').replace(/[\s ]+/g, ' ').trim();

  const visible = (el: Element): boolean => {
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return true;
  };

  const ownText = (el: Element): string => {
    // Direct text children only, so a container does not absorb its descendants.
    let out = '';
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) out += (n as Text).data;
    }
    return norm(out);
  };

  // ---- section detection -------------------------------------------------
  // A "section" is the screen title the control sits under. Real headings when
  // they exist; otherwise the styled-div-as-title-bar that legacy apps use.
  const isHeadingish = (el: Element): boolean => {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag) || tag === 'legend' || tag === 'caption') return true;
    if ((el.getAttribute('role') ?? '') === 'heading') return true;
    const st = window.getComputedStyle(el);
    if (st.display === 'table-cell' || st.display === 'inline') return false;
    const weight = Number(st.fontWeight === 'bold' ? 700 : st.fontWeight) || 400;
    const t = ownText(el);
    return weight >= 600 && t.length > 0 && t.length <= 80;
  };

  const headings: Array<{ el: Element; text: string }> = [];
  const walkerAll = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
  const allElements: Element[] = [];
  for (let n = walkerAll.nextNode(); n; n = walkerAll.nextNode()) {
    const el = n as Element;
    allElements.push(el);
    if (isHeadingish(el) && visible(el)) headings.push({ el, text: ownText(el) });
  }
  const indexOfEl = new Map<Element, number>();
  allElements.forEach((el, i) => indexOfEl.set(el, i));

  // Both arguments always came out of `allElements`, so the index is present.
  const sectionFor = (el: Element): string | undefined => {
    const myIdx = indexOfEl.get(el)!;
    let best: string | undefined;
    for (const h of headings) {
      const hi = indexOfEl.get(h.el)!;
      if (hi > myIdx) continue;
      if (!h.el.contains(el)) best = h.text;
      // A title bar that *wraps* the control is weaker evidence than one that
      // precedes it, so it only fills a gap.
      else if (h.el !== el) best = best ?? h.text;
    }
    return best;
  };

  // ---- name cascade ------------------------------------------------------
  const labelFromAria = (el: Element): { name: string; src: string } | null => {
    const al = norm(el.getAttribute('aria-label'));
    if (al) return { name: al, src: 'aria-label' };
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const parts = by
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => norm((n as Element).textContent));
      const joined = norm(parts.join(' '));
      if (joined) return { name: joined, src: 'aria-labelledby' };
    }
    return null;
  };

  const labelFromLabelEl = (el: Element): { name: string; src: string } | null => {
    const id = el.getAttribute('id');
    if (id) {
      const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const t = norm(lab?.textContent);
      if (t) return { name: t, src: 'label-for' };
    }
    const wrap = el.closest('label');
    if (wrap) {
      const t = norm(wrap.textContent);
      if (t) return { name: t, src: 'label-wrap' };
    }
    return null;
  };

  /**
   * The legacy rule: the label lives in the previous non-empty table cell.
   *
   * Capped in length because a cell holding a paragraph is prose, not a label,
   * and a 200-character "name" is worse than no name at all - it makes the
   * control unmatchable and it bloats every observation the model reads.
   */
  const MAX_LABEL = 60;
  const labelFromAdjacentCell = (el: Element): string | null => {
    const cell = el.closest('td, th');
    if (!cell) return null;
    let prev = cell.previousElementSibling;
    while (prev) {
      const t = norm(prev.textContent);
      if (t && t.length <= MAX_LABEL && !prev.querySelector('input, select, textarea, button, a')) return t;
      prev = prev.previousElementSibling;
    }
    // Column-oriented grids: fall back to the header cell in the same position.
    // Only reached when the row has no label cell to the left, which is what
    // distinguishes a grid row from a "label | value" layout row.
    const row = cell.closest('tr');
    const table = cell.closest('table');
    if (row && table) {
      const colIdx = Array.from(row.children).indexOf(cell);
      const headRow = table.querySelector('tr');
      const head = headRow && headRow !== row ? headRow.children[colIdx] : undefined;
      if (head) {
        const t = norm(head.textContent);
        if (t && t.length <= MAX_LABEL && !/input|select/i.test(head.innerHTML)) return t;
      }
    }
    return null;
  };

  /** Last resort: inline text immediately before the control. */
  const labelFromPrecedingText = (el: Element): string | null => {
    let node: Node | null = el.previousSibling;
    let acc = '';
    let hops = 0;
    while (node && hops < 6) {
      if (node.nodeType === 3) acc = (node as Text).data + acc;
      else if (node.nodeType === 1) {
        const e = node as Element;
        if (/input|select|textarea|button/i.test(e.tagName)) break;
        acc = norm(e.textContent) + ' ' + acc;
      }
      if (norm(acc).length > 0) break;
      node = node.previousSibling;
      hops++;
    }
    const t = norm(acc);
    return t ? t.slice(-80) : null;
  };

  const roleOf = (el: Element): string | null => {
    const explicit = norm(el.getAttribute('role')).toLowerCase();
    if (explicit === 'dialog' || explicit === 'alertdialog') return 'dialog';
    if (explicit === 'alert' || explicit === 'status') return 'alert';
    if (explicit === 'button') return 'button';
    if (explicit === 'heading') return 'heading';

    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'password') return 'password';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'hidden') return null;
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return null;
  };

  /** Best-effort CSS path. A hint only - never the primary locator. */
  const selectorFor = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    if (name) {
      const form = el.closest('form');
      const action = form?.getAttribute('action');
      const base = `${tag}[name="${name}"]`;
      return action ? `form[action="${action}"] ${base}` : base;
    }
    const id = el.getAttribute('id');
    if (id) return `#${CSS.escape(id)}`;
    const parts: string[] = [];
    // Walked from the element up to the body. Everything on that path is a
    // descendant of the body, so each step has a parent.
    let cur: Element = el;
    let depth = 0;
    while (cur !== body && depth < 6) {
      const p: Element = cur.parentElement!;
      const same = Array.from(p.children).filter((c) => c.tagName === cur.tagName);
      const idx = same.indexOf(cur) + 1;
      parts.unshift(same.length > 1 ? `${cur.tagName.toLowerCase()}:nth-of-type(${idx})` : cur.tagName.toLowerCase());
      cur = p;
      depth++;
    }
    return parts.join(' > ');
  };

  const rowKeyFor = (el: Element): string | undefined => {
    const row = el.closest('tr');
    if (!row) return undefined;
    const first = row.children[0];
    const t = norm(first?.textContent);
    return t && t.length <= 60 ? t : undefined;
  };

  const rowTextFor = (el: Element): string | undefined => {
    const row = el.closest('tr');
    if (!row) return undefined;
    const t = norm(row.textContent);
    return t ? t.slice(0, 200) : undefined;
  };

  const KEEP_ATTRS = ['name', 'type', 'value', 'href', 'target', 'maxlength', 'action'];

  const controls: RawControl[] = [];

  for (const el of allElements) {
    const role = roleOf(el);
    if (!role) continue;
    if (!visible(el)) continue;
    if (role === 'heading') continue; // headings surface as `section`, not targets

    const tag = el.tagName.toLowerCase();
    const inputType = (el.getAttribute('type') ?? '').toLowerCase();

    let name = '';
    let nameSource = 'none';

    if (role === 'button') {
      const v = norm(el.getAttribute('value'));
      const txt = ownText(el) || norm(el.textContent);
      const aria = labelFromAria(el);
      if (v) {
        name = v;
        nameSource = 'value';
      } else if (txt) {
        name = txt;
        nameSource = 'text';
      } else if (aria) {
        name = aria.name;
        nameSource = aria.src;
      } else {
        const alt = norm(el.getAttribute('alt'));
        const title = norm(el.getAttribute('title'));
        if (alt) {
          name = alt;
          nameSource = 'alt';
        } else if (title) {
          name = title;
          nameSource = 'title';
        }
      }
    } else if (role === 'link') {
      const txt = norm(el.textContent);
      const aria = labelFromAria(el);
      if (txt) {
        name = txt;
        nameSource = 'text';
      } else if (aria) {
        name = aria.name;
        nameSource = aria.src;
      } else {
        const img = el.querySelector('img');
        const alt = norm(img?.getAttribute('alt'));
        if (alt) {
          name = alt;
          nameSource = 'alt';
        }
      }
    } else if (role === 'dialog' || role === 'alert') {
      const heads = el.querySelectorAll('h1,h2,h3,h4,h5,h6');
      const lead = norm(heads[0]?.textContent) || norm(el.getAttribute('aria-label'));
      name = lead || norm(el.textContent).slice(0, 60);
      nameSource = lead ? 'text' : 'text';
    } else {
      const aria = labelFromAria(el);
      const lab = labelFromLabelEl(el);
      const cell = labelFromAdjacentCell(el);
      const pre = labelFromPrecedingText(el);
      if (aria) {
        name = aria.name;
        nameSource = aria.src;
      } else if (lab) {
        name = lab.name;
        nameSource = lab.src;
      } else if (cell) {
        name = cell;
        nameSource = 'adjacent-cell';
      } else if (pre) {
        name = pre;
        nameSource = 'preceding-text';
      } else {
        const ph = norm(el.getAttribute('placeholder'));
        const ti = norm(el.getAttribute('title'));
        if (ph) {
          name = ph;
          nameSource = 'placeholder';
        } else if (ti) {
          name = ti;
          nameSource = 'title';
        }
      }
    }

    const attrs: Record<string, string> = {};
    for (const a of KEEP_ATTRS) {
      const v = el.getAttribute(a);
      if (v !== null && v !== '') attrs[a] = v.slice(0, 120);
    }

    let value: string | undefined;
    const sensitive = role === 'password' || inputType === 'password';
    if (!sensitive) {
      if (tag === 'select') {
        const sel = el as HTMLSelectElement;
        value = sel.value;
        const opts = Array.from(sel.options).map((o) => `${o.value}|${norm(o.textContent)}`);
        attrs['options'] = opts.slice(0, 24).join(' ;; ');
      } else if (tag === 'input' || tag === 'textarea') {
        value = (el as HTMLInputElement).value;
      }
    }

    const r = el.getBoundingClientRect();
    const handle = `${framePrefix}c${controls.length}`;
    el.setAttribute('data-hs-h', handle);
    controls.push({
      handle,
      role,
      name,
      nameSource,
      value,
      enabled: !(el as HTMLInputElement).disabled,
      section: sectionFor(el),
      rowKey: rowKeyFor(el),
      rowText: rowTextFor(el),
      bbox: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      selector: selectorFor(el),
      tag,
      attrs,
      nearText: labelFromAdjacentCell(el) ?? labelFromPrecedingText(el) ?? undefined,
      sensitive,
    });
  }

  // ---- table cells -------------------------------------------------------
  // Reading a value out of a grid is the canonical back-office operation, so
  // cells are first-class targets. A cell's name is its column header when the
  // table has one, otherwise the label cell to its left - which is exactly how
  // legacy "label | value" layout tables read to a human.
  let cellCount = 0;
  for (const el of allElements) {
    if (cellCount >= 150) break;
    const tag = el.tagName.toLowerCase();
    if (tag !== 'td' && tag !== 'th') continue;
    if (!visible(el)) continue;
    if (el.querySelector('input, select, textarea, button, a')) continue;
    // Layout wrappers hold whole sub-screens, not values. Skip anything that
    // contains another table or cell.
    if (el.querySelector('table, td, th')) continue;
    const text = norm(el.textContent);
    if (!text || text.length > 80) continue;

    const row = el.closest('tr');
    const table = el.closest('table');
    let name = '';
    let nameSource = 'none';
    if (row && table) {
      const colIdx = Array.from(row.children).indexOf(el);
      const headRow = table.querySelector('tr');
      const head = headRow && headRow !== row ? headRow.children[colIdx] : undefined;
      const headText = norm(head?.textContent);
      if (headText && headText.length <= 40) {
        name = headText;
        // Recorded distinctly from the layout-table case: a cell named by a
        // column header is a row in a data grid, and rows in a grid move
        // between runs. That is what tells the recorder to scope by row label
        // rather than by position.
        nameSource = 'column-header';
      }
    }
    if (!name) {
      const adj = labelFromAdjacentCell(el);
      if (adj) {
        name = adj;
        nameSource = 'adjacent-cell';
      }
    }

    const r = el.getBoundingClientRect();
    const handle = `${framePrefix}c${controls.length}`;
    el.setAttribute('data-hs-h', handle);
    controls.push({
      handle,
      role: 'cell',
      name,
      nameSource,
      value: text,
      enabled: true,
      section: sectionFor(el),
      rowKey: rowKeyFor(el),
      rowText: rowTextFor(el),
      bbox: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      selector: selectorFor(el),
      tag,
      attrs: {},
      nearText: name || undefined,
    });
    cellCount++;
  }

  // ---- text + alerts -----------------------------------------------------
  const alerts: string[] = [];
  const seen = new Set<string>();
  const pushAlert = (t: string | null) => {
    const v = norm(t).slice(0, 400);
    if (v && !seen.has(v)) {
      seen.add(v);
      alerts.push(v);
    }
  };

  for (const el of allElements) {
    if (!visible(el)) continue;
    const role = norm(el.getAttribute('role')).toLowerCase();
    if (role === 'alert' || role === 'status' || role === 'alertdialog' || role === 'dialog') {
      pushAlert(el.textContent);
      continue;
    }
    // Legacy error banners carry no role: they are simply styled red. Flag any
    // short block whose text or background is strongly red relative to body.
    const st = window.getComputedStyle(el);
    const t = norm(el.textContent);
    if (!t || t.length > 300) continue;
    const reddish = (c: string): boolean => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
      if (!m) return false;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return r > 100 && r > g * 1.3 && r > b * 1.3;
    };
    if (reddish(st.color) || reddish(st.backgroundColor)) pushAlert(t);
  }

  // innerText is what a human sees; textContent is the fallback where the
  // platform does not implement it.
  const rendered = (body as HTMLElement & { innerText?: string }).innerText;
  const text = norm(rendered ?? body.textContent).slice(0, MAX_TEXT);
  return { text, alerts, controls };
}
