// Compiler B — Divi 4.x adapter (verified against 4.27.7; see docs/DIVI4-NOTES.md).
// Box tree -> et_pb_section / et_pb_row / et_pb_column / native modules + scoped page CSS.
//
// Mapping (Divi 4 has exactly section > row > column > module):
//   page root child (section)      -> et_pb_section (+ a decor row for out-of-flow decoration)
//   section's flow children        -> et_pb_row each (a horizontal child's children become columns)
//   column content                 -> modules; nested containers become an HTML fragment inside
//                                     et_pb_text (tracked as fallback) unless a native pattern fits
// Every Divi element carries module_class="f2d-<hash> f2d-el" so QA maps DOM <-> IR, and the
// scoped CSS reproduces the box tree's decisions on those classes.
import { boxCss, rgba, runtimeCss, BASE_TEXT_CSS, FOCUS_CSS } from '../../layout/engine.mjs';
import { round } from '../../util/core.mjs';

export const ADAPTER = { id: 'divi-v4', supports: /^4\.(2[0-9])\./, verifiedWith: '4.27.7' };

// Divi's prefix + one extra class beats generated module rules (`.et-db #et-boc .et-l .et_pb_text_0`)
// without !important.
const PREFIX = '.et-db #et-boc .et-l';
// The Visual Builder renders the page inside #et-fb-app; rules under it apply in the editor only.
const EDITOR = `${PREFIX} #et-fb-app`;

// ---------- attribute encoding ----------
const encAttr = (v) => String(v).replace(/\\/g, '%92').replace(/"/g, '%22').replace(/\[/g, '%91').replace(/\]/g, '%93');
const attrs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}="${encAttr(v)}"`)
    .join(' ');
// Module bodies: one line (WordPress wpautop runs over the content), literal brackets escaped.
const encBody = (html) => html.replace(/\r?\n/g, ' ').replace(/\[/g, '&#091;').replace(/\]/g, '&#093;');

// Promoted colour tokens -> Divi global colours. Divi only swaps a gcid when the module also
// carries global_colors_info (Bunctions.php:13462), so both are emitted together.
let GCMAP = null;
const sc = (tag, a, body = null) => {
  if (GCMAP) {
    const info = {};
    for (const k of Object.keys(a)) {
      if (!/color/.test(k) || typeof a[k] !== 'string') continue;
      const g = GCMAP.get(a[k].toLowerCase());
      if (g) (a[k] = g), (info[g] ??= []).push(k);
    }
    if (Object.keys(info).length) a.global_colors_info = JSON.stringify(info);
  }
  return body === null ? `[${tag} ${attrs(a)}][/${tag}]` : `[${tag} ${attrs(a)}]${body}[/${tag}]`;
};

// ---------- native-value helpers ----------
// Native font attributes name the font that actually renders (a recorded substitute when the design
// font is unavailable) so Divi's own (sometimes !important) rules never contradict the design CSS.
let SUBS = {};
const fontAttr = (css) => {
  let fam = (css['font-family'] || '').split(',')[0].replace(/['"]/g, '').trim();
  if (SUBS[fam]?.substitute) fam = SUBS[fam].substitute;
  const w = css['font-weight'] || '';
  const italic = css['font-style'] === 'italic' ? 'on' : '';
  const upper = css['text-transform'] === 'uppercase' ? 'on' : '';
  return `${fam}|${w}|${italic}|${upper}|||||`;
};
const pxv = (v) => (v && /px$/.test(v) ? v : null);
const solidColor = (css) => css['background-color'] || null;

function padAttr(p) {
  if (!p) return null;
  const parts = p.split(' ');
  if (parts.some((x) => !/^-?[\d.]+px$/.test(x))) return null; // calc()/max() stay in scoped CSS only
  const [t, r = t, b = t, l = r] = parts;
  return `${t}|${r}|${b}|${l}|false|false`;
}

function radiusAttr(r) {
  if (!r) return null;
  const parts = r.split(' ');
  const [a, b = a, c = a, d = b] = parts;
  return `on|${a}|${b}|${c}|${d}`;
}

// Column structure: nearest Divi preset (for editability); exact widths come from scoped CSS.
const STRUCTS = {
  1: [['4_4']],
  2: [['1_2', '1_2'], ['1_3', '2_3'], ['2_3', '1_3'], ['1_4', '3_4'], ['3_4', '1_4'], ['2_5', '3_5'], ['3_5', '2_5']],
  3: [['1_3', '1_3', '1_3'], ['1_4', '1_2', '1_4'], ['1_4', '1_4', '1_2'], ['1_2', '1_4', '1_4'], ['1_5', '3_5', '1_5']],
  4: [['1_4', '1_4', '1_4', '1_4']],
  5: [['1_5', '1_5', '1_5', '1_5', '1_5']],
  6: [['1_6', '1_6', '1_6', '1_6', '1_6', '1_6']],
};
const frac = (t) => t.split('_').map(Number).reduce((a, b) => a / b);
export function columnStructure(widths) {
  const n = widths.length;
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  const want = widths.map((w) => w / total);
  let best = null;
  for (const s of STRUCTS[n] || []) {
    const err = s.reduce((e, t, i) => e + Math.abs(frac(t) - want[i]), 0);
    if (!best || err < best.err) best = { s, err };
  }
  return best ? best.s : null;
}

// ---------- compile ----------
export function compileDivi(tree, ir, ctx = {}) {
  const N = ir.nodes;
  SUBS = ctx.fonts?.substitutions || {};
  const globalColors = {};
  GCMAP = new Map();
  for (const c of ctx.tokens?.colors || []) {
    if (!c.id || !/^#[0-9a-f]{6}$/.test(c.value)) continue;
    const gid = `gcid-f2d-${c.value.slice(1)}`;
    GCMAP.set(c.value, gid);
    globalColors[gid] = c.value;
  }
  const manifest = { modules: [], fallbacks: [], unsupported: [], rows: 0, sections: 0, counts: {} };
  const extraCss = []; // Divi-wrapper adjustments, scoped to our classes
  const columnCls = new Set(); // boxes rendered as an et_pb_column (their CSS must outrank Divi's column grid)
  const moduleCls = new Set(); // boxes rendered as a native module element (text, image, divider, button)
  const decorCols = []; // decoration-layer columns (static on the front end)
  const count = (k) => (manifest.counts[k] = (manifest.counts[k] || 0) + 1);
  // Runtime hooks (f2d-menu-panel, f2d-acc-item …) ride on the element that carries the box's class.
  const hk = (b) => (b.hooks?.length ? ' ' + b.hooks.join(' ') : '');
  const cls = (b, extra = '') => `${b.cls} f2d-el${extra ? ' ' + extra : ''}${hk(b)}`;
  const label = (b) => `${b.name}`.slice(0, 60);
  const sel = (c) => `${PREFIX} .${c}.${c}`; // doubled class: specificity bump, no !important

  // ----- modules -----
  function textModule(b) {
    const base = b.css.base;
    const tag = b.tag;
    const fontKey = /^h[1-6]$/.test(tag) ? (tag === 'h1' ? 'header' : `header_${tag[1]}`) : 'text';
    const a = {
      module_class: cls(b),
      admin_label: label(b),
      [`${fontKey}_font`]: fontAttr(base),
      [`${fontKey}_font_size`]: pxv(base['font-size']),
      [`${fontKey}_line_height`]: pxv(base['line-height']),
      [`${fontKey}_letter_spacing`]: pxv(base['letter-spacing']),
      [`${fontKey}_text_color`]: base.color && base.color !== 'transparent' ? base.color : null,
      text_orientation: base['text-align'] && base['text-align'] !== 'left' ? base['text-align'] : null,
    };
    for (const [bp, suf] of [['tablet', '_tablet'], ['phone', '_phone']]) {
      const v = b.css[bp]['font-size'];
      if (v) {
        a[`${fontKey}_font_size${suf}`] = v;
        a[`${fontKey}_font_size_last_edited`] = 'on|phone';
        a[`${fontKey}_font_size`] = a[`${fontKey}_font_size`];
      }
    }
    count('et_pb_text');
    moduleCls.add(b.cls);
    manifest.modules.push({ id: b.id, module: 'et_pb_text', tag });
    return sc('et_pb_text', a, encBody(`<${tag} class="f2d-t">${b.html}</${tag}>`));
  }

  function imageModule(b) {
    if (b.css.base['object-fit']) extraCss.push(`${sel(b.cls)} img { object-fit: ${b.css.base['object-fit']}; }`);
    count('et_pb_image');
    moduleCls.add(b.cls);
    manifest.modules.push({ id: b.id, module: 'et_pb_image', asset: b.asset });
    return sc('et_pb_image', {
      src: b.src,
      alt: b.alt || '',
      title_text: b.alt || '',
      show_bottom_space: 'off',
      force_fullwidth: 'off',
      module_class: cls(b),
      admin_label: label(b),
      disabled_on: b.decor ? null : null,
    });
  }

  function dividerModule(b) {
    count('et_pb_divider');
    moduleCls.add(b.cls);
    manifest.modules.push({ id: b.id, module: 'et_pb_divider' });
    const n = N[b.id];
    return sc('et_pb_divider', { module_class: cls(b), admin_label: label(b), color: rgba(n.stroke?.color || '#000000'), divider_weight: `${n.stroke?.weight || 1}px`, show_divider: 'on' });
  }

  // A button: native et_pb_button with the label; icons and layout come from scoped CSS that
  // reproduces the design's flex box. Hover state from IR `states` becomes native __hover attrs.
  function buttonModule(b) {
    const n = N[b.id];
    {
      // Native only when the label is the sole text and icons fit ::before/::after (<= 1 per side).
      const imgs = [], texts = [];
      const walk = (c, i) => (c.tag === 'img' ? imgs.push(i) : c.kind === 'text' ? texts.push(i) : c.children.forEach((g) => walk(g, i)));
      b.children.forEach((c, i) => walk(c, i));
      const ti = texts[0];
      // Divi 4's custom button emits !important padding and display:none on both pseudo-elements,
      // and only supports its icon font: SVG-icon buttons cannot be native without losing the design.
      if (texts.length !== 1) return fragmentModule(b, 'button with several text labels');
      if (imgs.length) return fragmentModule(b, 'button with SVG icon(s): Divi 4 buttons support only ETmodules font icons and force !important padding/pseudo rules');
    }
    const textBox = findFirst(b, (c) => c.kind === 'text');
    const tcss = textBox?.css.base || {};
    const bg = solidColor(b.css.base);
    const hover = n.states?.hover;
    const hoverBg = hover?.fills?.find((f) => f.type === 'solid');
    const a = {
      button_text: textBox?.text || n.name,
      button_url: b.href && b.href !== '#' ? b.href : '#',
      custom_button: 'on',
      button_text_size: pxv(tcss['font-size']),
      button_text_color: tcss.color,
      button_font: fontAttr(tcss),
      button_letter_spacing: pxv(tcss['letter-spacing']),
      button_bg_color: bg,
      button_border_width: n.stroke ? `${n.stroke.weight}px` : '0px',
      button_border_color: n.stroke ? rgba(n.stroke.color) : null,
      button_border_radius: n.radius ? `${n.radius[0]}px` : '0px',
      button_use_icon: 'off',
      custom_padding: padAttr(b.css.base.padding),
      module_class: cls(b, 'f2d-btn'),
      admin_label: label(b),
    };
    if (hoverBg) {
      a.button_bg_color__hover = rgba(hoverBg.color, hoverBg.opacity);
      a.button_bg_color__hover_enabled = 'on|hover';
    }
    if (hover?.stroke) {
      a.button_border_color__hover = rgba(hover.stroke.color);
      a.button_border_color__hover_enabled = 'on|hover';
      a.button_border_width__hover = `${hover.stroke.weight}px`;
      a.button_border_width__hover_enabled = 'on|hover';
    }
    // Icons/extra children: rendered inside the <a> through a CSS-only layer is not possible for
    // multiple images, so they are emitted as ::before/::after backgrounds when there are <= 2.
    const icons = [];
    const collect = (c) => (c.tag === 'img' ? icons.push(c) : c.children.forEach(collect));
    b.children.forEach(collect);
    const textIdx = b.children.indexOf(textBox);
    icons.slice(0, 2).forEach((ic, i) => {
      const before = b.children.indexOf(ic) !== -1 ? b.children.indexOf(ic) < textIdx : i === 0 && textIdx > 0;
      const pseudo = before ? '::before' : '::after';
      extraCss.push(`${sel(b.cls)}${pseudo} { content: ""; display: block; flex: 0 0 auto; position: static; margin: 0; opacity: 1; width: ${ic.css.base.width || ic.w + 'px'}; height: ${ic.css.base.height || ic.h + 'px'}; background: url("${ic.src}") center / contain no-repeat; font-size: 0; line-height: 0; }`);
    });
    if (icons.length > 2) manifest.fallbacks.push({ id: b.id, kind: 'button-icons', reason: `${icons.length} icons in button; only 2 rendered via ::before/::after` });
    count('et_pb_button');
    moduleCls.add(b.cls);
    manifest.modules.push({ id: b.id, module: 'et_pb_button', icons: Math.min(2, icons.length) });
    return sc('et_pb_button', a);
  }

  // HTML fragment fallback: nested structure Divi 4 cannot express natively, kept editable as HTML.
  function fragmentModule(b, reason) {
    const html = fragmentHtml(b);
    count('et_pb_text(fragment)');
    manifest.fallbacks.push({ id: b.id, name: b.name, kind: 'fragment', module: 'et_pb_text', reason });
    manifest.modules.push({ id: b.id, module: 'et_pb_text', fragment: true });
    return sc('et_pb_text', { module_class: `f2d-frag-host f2d-host-${b.cls}`, admin_label: `${label(b)} (fragment)` }, encBody(html));
  }

  function fragmentHtml(b) {
    const aria = b.ariaHidden ? ' aria-hidden="true"' : '';
    if (b.kind === 'control') return `<button type="button" class="${b.cls}${hk(b)}"${aria}>${b.html}</button>`;
    if (b.tag === 'img') return `<img class="${b.cls}${hk(b)}" src="${b.src}" alt="${(b.alt || '').replace(/"/g, '&quot;')}" width="${Math.round(b.w)}" height="${Math.round(b.h)}" loading="${b.eager ? 'eager' : 'lazy'}"${aria}>`;
    if (b.kind === 'text') return `<${b.tag} class="${b.cls}${hk(b)}"${aria}>${b.html}</${b.tag}>`;
    const tag = b.kind === 'button' ? 'a' : 'div';
    const href = b.kind === 'button' ? ` href="${b.href || '#'}"` : '';
    return `<${tag} class="${b.cls}${hk(b)}"${href}${aria}>${b.children.map(fragmentHtml).join('')}</${tag}>`;
  }

  function findFirst(b, pred) {
    if (pred(b)) return b;
    for (const c of b.children) {
      const f = findFirst(c, pred);
      if (f) return f;
    }
    return null;
  }

  function moduleFor(b) {
    if (b.kind === 'text') return textModule(b);
    if (b.tag === 'img') return imageModule(b);
    if (b.kind === 'shape' && N[b.id].type === 'line') return dividerModule(b);
    if (b.kind === 'button') return buttonModule(b);
    if (b.kind === 'shape') return fragmentModule(b, 'vector shape without exported asset');
    // containers inside a column
    return fragmentModule(b, 'nested container inside a column (Divi 4 has no nesting below columns)');
  }

  // Flatten a column container into modules where that keeps the design: a stylistically empty
  // vertical stack contributes its children directly. Otherwise the container is one module.
  function columnContent(col) {
    return col.children.map(moduleFor);
  }

  // ----- structure -----
  function column(b, type, extraClass = '') {
    if (!isContainer(b) || !b.children.length) {
      // A leaf in column position: the column is transparent and the module is the flex item.
      extraCss.push(`${sel(b.cls + '-col')} { display: contents; }`);
      return sc('et_pb_column', { type, module_class: `${b.cls}-col f2d-el f2d-col`, admin_label: `${label(b)} column` }, moduleFor(b));
    }
    columnCls.add(b.cls);
    const a = { type, module_class: cls(b, `f2d-col ${extraClass}`.trim()), admin_label: label(b) };
    const bg = solidColor(b.css.base);
    if (bg) a.background_color = bg;
    const pad = padAttr(b.css.base.padding);
    if (pad) a.custom_padding = pad;
    return sc('et_pb_column', a, columnContent(b).join(''));
  }

  // A row whose single column *is* the given box (its children become modules).
  function rowSingle(b) {
    manifest.rows++;
    const a = { column_structure: '4_4', module_class: cls(b, 'f2d-row f2d-row-single'), admin_label: label(b), use_custom_gutter: 'on', gutter_width: '1', make_equal: 'off' };
    const col = { ...b, hooks: null, cls: `${b.cls}-c`, css: { base: {}, narrow: {}, tablet: {}, phone: {} }, name: `${b.name} column` };
    // The row carries the box's own CSS; the column is a transparent pass-through.
    extraCss.push(`${sel(b.cls + '-c')} { display: contents; }`);
    return sc('et_pb_row', a, column(col, '4_4'));
  }

  // A row whose children are columns.
  function rowColumns(b) {
    manifest.rows++;
    const kids = b.children;
    const widths = kids.map((c) => N[c.id]?.box.w || 1);
    const struct = columnStructure(widths);
    if (!struct) {
      manifest.unsupported.push({ id: b.id, reason: `${kids.length} columns exceed Divi 4's 6-column rows; rendered as fragment` });
      return rowSingle({ ...b, children: [{ ...b, hooks: null, cls: `${b.cls}-inner` }] });
    }
    const a = { column_structure: struct.join(','), module_class: cls(b, 'f2d-row f2d-row-cols'), admin_label: label(b), use_custom_gutter: 'on', gutter_width: '1' };
    return sc('et_pb_row', a, kids.map((c, i) => column(c, struct[i])).join(''));
  }

  const isRowish = (b) => b.css.base.display === 'flex' && /^row/.test(b.css.base['flex-direction'] || '') && b.children.length >= 2 && b.children.length <= 6 && b.children.every((c) => c.css.base.position !== 'absolute');
  const isContainer = (b) => !b.kind || b.kind === 'container' || b.kind === 'section';

  function rowsFor(b) {
    if (!isContainer(b)) {
      // A leaf directly in a section: neutral row + column so the module itself is the flex item.
      manifest.rows++;
      extraCss.push(`${sel(b.cls + '-row')} { display: contents; }`, `${sel(b.cls + '-row-c')} { display: contents; }`);
      return [sc('et_pb_row', { column_structure: '4_4', module_class: `${b.cls}-row f2d-el f2d-row`, admin_label: `${label(b)} row`, use_custom_gutter: 'on', gutter_width: '1' }, sc('et_pb_column', { type: '4_4', module_class: `${b.cls}-row-c f2d-el f2d-col`, admin_label: `${label(b)} column` }, moduleFor(b)))];
    }
    // A horizontal container with 2–6 in-flow children maps to a row with columns, as long as its
    // children are containers (cards); leaves side by side (e.g. logo + nav) stay one row/column.
    if (isRowish(b) && b.children.filter(isContainer).length >= Math.ceil(b.children.length / 2)) return [rowColumns(b)];
    return [rowSingle(b)];
  }

  function section(b) {
    manifest.sections++;
    const n = N[b.id];
    const flow = b.children.filter((c) => c.css.base.position !== 'absolute');
    const decor = b.children.filter((c) => c.css.base.position === 'absolute');
    const rows = [];
    if (decor.length) {
      // Out-of-flow decoration lives in its own absolutely positioned row behind the content.
      const decorBox = { ...b, hooks: null, cls: `${b.cls}-decor`, name: `${b.name} decoration`, css: { base: {}, narrow: {}, tablet: {}, phone: {} }, children: decor };
      // Layer row: covers the section, creates NO stacking context (z-index auto) so each layer keeps
      // its Figma paint order against the flow rows; clicks pass through except on real content.
      extraCss.push(`${sel(b.cls + '-decor')} { position: absolute; inset: 0; width: 100%; max-width: none; height: 100%; margin: 0; padding: 0; pointer-events: none; z-index: auto; }`);
      for (const c of decor) if (!c.decor) extraCss.push(`${sel(c.cls)} { pointer-events: auto; }`);
      // Base rule first: the responsive override below must come after it (same specificity).
      extraCss.push(`${sel(b.cls + '-decor-c')} { position: static; display: block; width: 100%; height: 100%; }`);
      decorCols.push(b.cls + '-decor-c');
      // Where the layout engine turns this section's absolute content into a vertical flow (tablet and/or
      // phone), the layer row must join the flow too, or the section collapses (an absolute row has no height).
      // The same applies from the widest ladder tier at which one of its layers moves into flow
      // (a header overlay becomes the top bar at the menu breakpoint).
      const tierAt = { narrow: tree.root.narrowAt, tabletExtra: 1200, tablet: 980, mobileExtra: 880, phone: 767 };
      const joins = Object.keys(tierAt).find((t) => tierAt[t] && decor.some((c) => !c.decor && c.css[t]?.position && c.css[t].position !== 'absolute'));
      const flowAt = Math.max(b.css.tablet.display === 'flex' ? 980 : b.css.phone.display === 'flex' ? 767 : 0, joins ? tierAt[joins] : 0);
      if (flowAt && decor.some((c) => !c.decor)) {
        extraCss.push(`@media (max-width: ${flowAt}px) { ${sel(b.cls + '-decor')} { position: relative; inset: auto; height: auto; display: flex; flex-direction: column; align-items: flex-start; gap: 16px; pointer-events: auto; } ${sel(b.cls + '-decor-c')} { display: contents; } }`);
      }
      manifest.rows++;
      rows.push(sc('et_pb_row', { column_structure: '4_4', module_class: `${b.cls}-decor f2d-el f2d-row f2d-decor`, admin_label: `${b.name} decoration`, use_custom_gutter: 'on', gutter_width: '1' }, column({ ...decorBox, hooks: null, cls: `${b.cls}-decor-c`, children: decor }, '4_4')));
    }
    // The section's flex layout is reproduced by scoped CSS on the section element; each flow child
    // becomes one or more rows. The box tree keeps the child order and paint order.
    for (const c of flow) rows.push(...rowsFor(c));
    const a = { module_class: cls(b, 'f2d-section'), admin_label: label(b), custom_padding: '0px|0px|0px|0px|false|false' };
    const bg = solidColor(b.css.base);
    if (bg) a.background_color = bg;
    else a.background_color = 'rgba(0,0,0,0)';
    if (n.fills.some((f) => f.type === 'image' || f.type === 'video' || f.type === 'gradient')) manifest.modules.push({ id: b.id, module: 'et_pb_section', note: 'layered background in scoped CSS' });
    return sc('et_pb_section', a, rows.join(''));
  }

  const root = tree.root;
  const sections = root.children.filter((c) => c.css.base.position !== 'absolute');
  const pageDecor = root.children.filter((c) => c.css.base.position === 'absolute');
  if (pageDecor.length) manifest.unsupported.push({ ids: pageDecor.map((d) => d.id), reason: 'page-level absolute decoration placed in first section decoration row' });
  const shortcodes = sections.map(section).join('\n');

  const css = [pageCss(tree, extraCss, ctx, columnCls), editorCss(tree, { moduleCls, columnCls, decorCols })].join('\n');
  GCMAP = null;
  return { shortcodes, css, manifest, globalColors };
}

// Scoped CSS: neutralise Divi defaults on our elements, then apply the box tree's CSS.
function pageCss(tree, extraCss, ctx, columnCls = new Set()) {
  // Divi sizes columns per structure (e.g. .et_pb_gutters1.et_pb_row_4col > .et_pb_column_1_4 → 50% on
  // tablets, 1 id + 6 classes). The reset outranks that (7 classes) and a column's own box CSS outranks
  // the reset (8), so the layout engine's flex sizing applies at every breakpoint.
  const COL = '.et_pb_row.f2d-row > .et_pb_column.f2d-col.f2d-col';
  const reset = [
    `/* f2d scoped page CSS — generated, build ${ctx.buildId || ''}. Edit via repairs, not here. */`,
    ctx.fontCss || '',
    // Build marker: QA reads it back from the rendered page to detect stale Divi CSS caches.
    `body.f2d-page.et-db { --f2d-build: "${ctx.buildId || ''}"; }`,
    `${PREFIX} .et_pb_section.f2d-section { padding: 0; margin: 0; background-color: transparent; }`,
    `${PREFIX} .et_pb_row.f2d-row { width: auto; max-width: none; margin: 0; padding: 0; float: none; }`,
    `${PREFIX} .et_pb_row.f2d-row::after { display: none; }`,
    `${PREFIX} ${COL} { float: none; margin: 0; width: auto; min-height: 0; }`,
    `${PREFIX} .et_pb_row.f2d-row-cols { display: flex; }`,
    // Only Divi's own default (.et_pb_column .et_pb_module { margin-bottom: 30px }): a box's own margins
    // (negative auto-layout spacing, non-uniform gaps, centring) must survive the reset.
    `${PREFIX} .et_pb_column .et_pb_module.f2d-el, ${PREFIX} .et_pb_column .f2d-frag-host { margin-bottom: 0; }`,
    `${PREFIX} .et_pb_text.f2d-el .f2d-t, ${PREFIX} .f2d-frag-host h1, ${PREFIX} .f2d-frag-host h2, ${PREFIX} .f2d-frag-host h3, ${PREFIX} .f2d-frag-host h4, ${PREFIX} .f2d-frag-host h5, ${PREFIX} .f2d-frag-host h6, ${PREFIX} .f2d-frag-host p { margin: 0; padding: 0; font: inherit; color: inherit; letter-spacing: inherit; text-transform: inherit; line-height: inherit; white-space: inherit; text-wrap: inherit; }`,
    `${PREFIX} .et_pb_text.f2d-el .et_pb_text_inner, ${PREFIX} .f2d-frag-host .et_pb_text_inner { display: contents; }`,
    `${PREFIX} .f2d-frag-host, ${PREFIX} .f2d-frag-host .et_pb_text_inner { display: contents; }`,
    // wpautop markup (the Visual Builder runs it over module HTML, and a builder save keeps it): a
    // class-less <p> around inline elements (a link, a button) would become an extra flex item, and
    // line breaks between elements extra lines. Every tag we emit has a class, and our own breaks only
    // sit inside a text tag, so these are always wpautop's.
    `${PREFIX} :is(.f2d-frag-host, .et_pb_text.f2d-el) p:not([class]) { display: contents; }`,
    `${PREFIX} :is(.f2d-frag-host, .et_pb_text.f2d-el) :is(div, a, p:not([class])) > br { display: none; }`,
    // Divi centres image modules below 980 (.et_pb_image_N { margin-left: auto }, 1 id + 3 classes):
    // undone one class stronger; a box's own margins (printed later, same weight) still apply.
    `${PREFIX} .et_pb_image.f2d-el { margin-left: 0; margin-right: 0; }`,
    // (Divi's own `.et_pb_image_N .et_pb_image_wrap img { width: auto }` at ≤980px has the same weight and
    // prints later: matched through the wrap, one class stronger)
    `${PREFIX} .et_pb_image.f2d-el img, ${PREFIX} .et_pb_image.f2d-el .et_pb_image_wrap img { display: block; max-width: none; height: 100%; width: 100%; border-radius: inherit; }`,
    `${PREFIX} .et_pb_image.f2d-el .et_pb_image_wrap { display: block; width: 100%; height: 100%; border-radius: inherit; overflow: hidden; }`,
    `${PREFIX} .et_pb_button_module_wrapper:has(> .f2d-btn) { display: contents; }`,
    `${PREFIX} a.et_pb_button.f2d-btn, ${PREFIX} a.et_pb_button.f2d-btn:hover { text-decoration: none; line-height: inherit; }`,
    `${PREFIX} a.et_pb_button.f2d-btn::after, ${PREFIX} a.et_pb_button.f2d-btn::before { transition: none; }`,
    `${PREFIX} .f2d-frag-host a { text-decoration: none; color: inherit; }`,
    // Divi styles every link in a module (.et_pb_module a:not(.wc-forward) { padding-bottom: 10px;
    // line-height: 1em; font-weight: 500 }, 1 id + 4 classes + 1 element): undone at the same
    // specificity (printed later); a link box's own rules (a.cls.cls) then apply on top.
    `${PREFIX} .f2d-frag-host a:not(.wc-forward), ${PREFIX} .et_pb_module a.f2d-el:not(.wc-forward) { padding-bottom: 0; line-height: inherit; font-weight: inherit; }`,
    `${PREFIX} ${BASE_TEXT_CSS}`,
    `${PREFIX} ${FOCUS_CSS}`,
    runtimeCss(PREFIX, tree.root.menuAt),
    `@media (max-width: 980px) { ${PREFIX} ${COL} { width: auto; margin-bottom: 0; } ${PREFIX} .et_pb_column .et_pb_module.f2d-el { margin-bottom: 0; } }`,
    `@media (max-width: 479px) { ${PREFIX} ${COL} { width: auto !important; } }`,
  ];
  // Box tree CSS on our classes, specificity-bumped, with Divi wrappers mapped:
  //  - a text module's design CSS sits on the module element; inner tag inherits typography.
  //  - an image module's CSS sits on the module element; the <img> fills it.
  const boxRules = boxCss(tree.root, { scope: `${PREFIX} `, selector: (b) => (columnCls.has(b.cls) ? `.et_pb_column${`.${b.cls}`.repeat(5)}` : b.kind === 'button' ? `a.${b.cls}.${b.cls}` : `.${b.cls}.${b.cls}`) });
  // The page frame has no Divi element of its own: its CSS goes on Divi's inner content wrapper.
  const rootDecl = Object.entries(tree.root.css.base).filter(([k, v]) => v != null && !['width', 'height', 'min-height'].includes(k)).map(([k, v]) => `${k}: ${v};`).join(' ');
  // Divi puts .et-db on <body> itself, so the page selector is body.f2d-page.et-db (not a descendant).
  reset.push(`body.f2d-page.et-db #et-boc .et-l .et_builder_inner_content { ${rootDecl} }`);
  return [...reset, boxRules, ...extraCss].filter(Boolean).join('\n');
}

// Visual Builder parity. The builder renders the same shortcodes with its own CSS on top (verified
// on 4.27.7, frontend-builder bundle.css and the per-module <style> it generates):
//   - every module `position: relative !important; top: 0; left: 0` (1 id + 3 classes);
//   - `#et-fb-app .et_pb_module, #et-fb-app .et_pb_column { position: relative }` and columns
//     `z-index: 9` (2 ids — stronger than the page CSS above);
//   - `#et-fb-app .et_pb_column--collapsed .et_pb_module { min-height: 30px }`, and on the column
//     itself `::after { content: "." }` — a pass-through column (display: contents) has no height, so
//     the builder marks it collapsed and that pseudo-element becomes an extra flex item of the row;
//   - a `<div data-shortcode-id>` wrapper inside every text module's .et_pb_text_inner;
//   - #et-fb-app > #et_pb_root > .et-fb-post-content between Divi's content wrapper (which carries the
//     page frame's flex layout) and the sections: #et-fb-app would be a content-sized flex item, so the
//     wrappers stretch to the page width and the innermost one lays the sections out like the frame;
//   - in the tablet / phone previews the admin bar sits outside the preview frame (no html margin), but
//     WordPress still sets --wp-admin--admin-bar--height, which the sticky header's `top` reads.
// These rules exist only under #et-fb-app and restore what the front end computes: the box's own
// values per tier, else Divi's front-end defaults (style-static.min.css: columns relative, z-index 2;
// modules relative). The position is the one value that needs !important, against the builder's own.
function editorCss(tree, { moduleCls, columnCls, decorCols }) {
  const pick = (css, keys) => Object.fromEntries(keys.filter((k) => css?.[k] != null && css[k] !== '').map((k) => [k, css[k]]));
  const TIERS = ['base', 'wide', 'narrow', 'tabletExtra', 'tablet', 'mobileExtra', 'phone'];
  const tiers = (b) => [...TIERS.map((t) => b.css[t]), ...Object.values(b.css.at || {})];
  const editorBox = (b) => {
    const keep = (css, isBase) => {
      if (moduleCls.has(b.cls)) {
        const own = pick(css, ['position', 'top', 'left', 'min-height']);
        if (own.position) own.position += ' !important';
        if (!isBase) return own;
        const positioned = tiers(b).some((c) => c?.position);
        return { ...(positioned ? { position: 'relative !important' } : {}), top: 'auto', left: 'auto', 'min-height': 'auto', ...own };
      }
      if (columnCls.has(b.cls)) return { ...(isBase ? { 'z-index': '2' } : {}), ...pick(css, ['position', 'z-index']) };
      return {};
    };
    const css = Object.fromEntries(TIERS.map((t) => [t, keep(b.css[t] || {}, t === 'base')]));
    css.at = Object.fromEntries(Object.entries(b.css.at || {}).map(([w, c]) => [w, keep(c, false)]));
    return { ...b, rules: [], hover: [], css, children: b.children.map(editorBox) };
  };
  const root = editorBox(tree.root);
  // One class more than the builder's strongest rules (2 ids + 4 classes).
  const boxes = boxCss(root, { scope: `${EDITOR} `, selector: (b) => (columnCls.has(b.cls) ? `.et_pb_column${`.${b.cls}`.repeat(3)}` : `.${b.cls}`.repeat(3)) });
  const frame = `body.f2d-page.et-db #et-boc .et-l .et_builder_inner_content`;
  const frameLayout = Object.entries(pick(tree.root.css.base, ['display', 'flex-direction', 'flex-wrap', 'align-items', 'align-content', 'justify-content', 'gap', 'row-gap', 'column-gap'])).map(([k, v]) => `${k}: ${v};`).join(' ');
  return [
    `/* Visual Builder parity (editor only) */`,
    `${frame} > #et-fb-app, ${frame} > #et-fb-app > #et_pb_root { align-self: stretch; width: 100%; max-width: none; }`,
    frameLayout ? `${frame} > #et-fb-app > #et_pb_root > .et-fb-post-content { ${frameLayout} width: 100%; }` : '',
    `html.et-fb-app-frame:is(.et-fb-preview--tablet, .et-fb-preview--phone) { --wp-admin--admin-bar--height: 0px; }`,
    `${EDITOR} .et_pb_text.f2d-el .et_pb_text_inner > [data-shortcode-id], ${EDITOR} .f2d-frag-host .et_pb_text_inner > [data-shortcode-id] { display: contents; }`,
    `${EDITOR} .et_pb_column.f2d-col::after { display: none; }`,
    ...decorCols.map((c) => `${EDITOR} .et_pb_column.${c}.${c} { position: static; }`),
    boxes,
  ].join('\n');
}
