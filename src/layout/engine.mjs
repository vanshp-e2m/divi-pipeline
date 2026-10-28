// Shared layout engine: IR (+ repairs) -> box tree with CSS decisions for base / tablet / phone.
// Both compilers consume this. Nothing here knows about Divi or HTML wrappers.
import { round, px } from '../util/core.mjs';
import { layoutOf, hasText, visualBox } from '../ir/analyze.mjs';

export const BREAKPOINTS = { tablet: 980, phone: 767 };
// The responsive ladder (the DEV Connect figma→Elementor rules, with Divi's own edges for tablet 980
// and phone 767). Every rule lives on one of these tiers; a break found at any other width is fixed on
// the tier that covers it, never squeezed into a narrower one. Laptop's edge is 1366 unless the design's
// content column needs more (content + gutters), so desktop base always works down to the laptop edge.
export const LADDER = { widescreen: 2400, laptop: 1366, tabletExtra: 1200, tablet: BREAKPOINTS.tablet, mobileExtra: 880, phone: BREAKPOINTS.phone };
// Tier for a width (max-width tiers, desktop-first): the bucket name in box.css.
export const tierOf = (w, laptopEdge = LADDER.laptop) => (w > laptopEdge ? 'base' : w > LADDER.tabletExtra ? 'narrow' : w > LADDER.tablet ? 'tabletExtra' : w > LADDER.mobileExtra ? 'tablet' : w > LADDER.phone ? 'mobileExtra' : 'phone');

// ---------- value helpers ----------
export function rgba(color, alpha = 1) {
  if (!color) return null;
  if (color.startsWith('rgba') || color.startsWith('rgb')) {
    const m = color.match(/rgba?\(([^)]+)\)/);
    const [r, g, b, a = 1] = m[1].split(',').map((s) => parseFloat(s));
    const A = round(a * alpha, 3);
    return A >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${A})`;
  }
  if (alpha >= 1) return color.toLowerCase();
  const h = color.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${round(alpha, 3)})`;
}

function gradientCss(f) {
  let angle = f.angle ?? 180;
  if (f.start && f.end) {
    // IR handles are normalised (0..1) in the node box, y down. CSS 0deg = to top, clockwise.
    const dx = f.end[0] - f.start[0], dy = f.end[1] - f.start[1];
    angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
    angle = round((angle + 360) % 360, 1);
  }
  const stops = (f.stops || []).map((s) => `${rgba(s.color, f.opacity ?? 1)} ${round(s.position * 100, 1)}%`).join(', ');
  if (f.kind === 'radial') return `radial-gradient(circle, ${stops})`;
  return `linear-gradient(${angle}deg, ${stops})`;
}

const objectFit = (mode) => ({ fill: 'cover', fit: 'contain', stretch: 'fill', crop: 'cover', tile: 'none' })[mode] || 'cover';
const bgSize = (mode) => ({ fill: 'cover', fit: 'contain', stretch: '100% 100%', crop: 'cover', tile: 'auto' })[mode] || 'cover';
const justifyMap = { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between' };
const alignMap = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' };

export function fontStack(family, cfgFonts = {}) {
  const sub = cfgFonts.substitutions?.[family];
  const generic = /helvetica|arial/i.test(family) ? 'Helvetica, Arial, sans-serif' : 'sans-serif';
  const parts = [`'${family}'`];
  if (sub?.substitute && sub.substitute !== family) parts.push(`'${sub.substitute}'`);
  return [...parts, generic].join(', ');
}

// ---------- per-node CSS ----------
function backgroundCss(n, ctx) {
  const css = {};
  const layers = [];
  let solidOnly = null;
  const fills = n.fills.filter((f) => f.type !== 'image' || n.a.role !== 'image');
  for (const f of [...fills].reverse()) {
    // IR fills are bottom -> top; CSS layers are top -> bottom.
    if (f.type === 'solid') {
      const c = rgba(f.color, f.opacity);
      if (fills.length === 1) solidOnly = c;
      else layers.push(`linear-gradient(${c}, ${c})`);
    } else if (f.type === 'gradient') layers.push(gradientCss(f));
    else if (f.type === 'image') {
      const url = ctx.assetUrl(n.fillAsset || n.asset, n);
      if (url) layers.push(`url("${url}") center / ${bgSize(f.scaleMode)} ${f.scaleMode === 'tile' ? 'repeat' : 'no-repeat'}`);
      else ctx.issue('IMAGE_FILL_UNRESOLVED', 'major', n.id, `Image fill on "${n.name}" has no asset`);
    } else if (f.type === 'video') {
      const still = ctx.videoStill(n); // { url, size, position } from the Figma poster frame
      if (still) layers.push(`url("${still.url}") ${still.position || 'center'} / ${still.size || 'cover'} no-repeat`);
      else ctx.issue('VIDEO_FILL_NO_STILL', 'major', n.id, `Video fill on "${n.name}" rendered as solid fallback (no still frame)`);
    }
  }
  if (solidOnly) css['background-color'] = solidOnly;
  if (layers.length) css.background = layers.join(', ');
  return css;
}

function borderCss(n) {
  const s = n.stroke;
  if (!s || !s.color || !(s.weight > 0 || s.weights?.some((w) => w > 0))) return {};
  const c = rgba(s.color);
  const style = s.dash?.length ? 'dashed' : 'solid';
  const css = {};
  if (s.align === 'outside' && !s.weights) {
    css['box-shadow'] = `0 0 0 ${px(s.weight)} ${c}`;
    return css;
  }
  if (s.weights) {
    const [t, r, b, l] = s.weights;
    if (t) css['border-top'] = `${px(t)} ${style} ${c}`;
    if (r) css['border-right'] = `${px(r)} ${style} ${c}`;
    if (b) css['border-bottom'] = `${px(b)} ${style} ${c}`;
    if (l) css['border-left'] = `${px(l)} ${style} ${c}`;
  } else css.border = `${px(s.weight)} ${style} ${c}`;
  return css;
}

function effectCss(n) {
  const css = {};
  const shadows = [];
  const filters = [];
  for (const e of n.effects) {
    if (e.type === 'drop-shadow' || e.type === 'inner-shadow' || e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      const inset = /inner/i.test(e.type) ? 'inset ' : '';
      shadows.push(`${inset}${px(e.offset?.x || 0)} ${px(e.offset?.y || 0)} ${px(e.radius || 0)} ${px(e.spread || 0)} ${rgba(e.color)}`);
    } else if (/layer.?blur/i.test(e.type)) filters.push(`blur(${px((e.radius || 0) / 2)})`);
    else if (/background.?blur/i.test(e.type)) css['backdrop-filter'] = `blur(${px((e.radius || 0) / 2)})`;
  }
  if (shadows.length) css['box-shadow'] = shadows.join(', ');
  if (filters.length) css.filter = filters.join(' ');
  return css;
}

function radiusCss(n) {
  if (!n.radius || !n.radius.some((r) => r > 0)) return {};
  const [a, b, c, d] = n.radius;
  return { 'border-radius': a === b && b === c && c === d ? px(a) : [a, b, c, d].map(px).join(' ') };
}

function textCss(n, ctx) {
  const runs = n.text.runs;
  // Dominant run = most characters; others become spans.
  const dom = [...runs].sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  const css = runCss(dom, ctx);
  // Figma "auto" line height is the design font's natural leading; a substitute font's
  // `normal` differs, so derive the exact pixel value from the text box and its line count.
  // With leading trim the box is cap-height-trimmed, so it says nothing about leading.
  if (!dom.lineHeight && n.text.lines > 0 && runs.every((r) => !r.lineHeight) && !n.text.leadingTrim) css['line-height'] = px(n.box.h / n.text.lines);
  if (n.text.leadingTrim === 'cap-height') css['text-box'] = 'trim-both cap alphabetic';
  if (css.color && css.color !== 'transparent') css['--f2d-c'] = css.color;
  // Outlined text (a stroke on the text layer): drawn outside the glyphs like Figma's outside stroke.
  if (n.stroke?.color && n.stroke.weight) Object.assign(css, { '-webkit-text-stroke': `${px(n.stroke.weight * (n.stroke.align === 'center' ? 1 : 2))} ${rgba(n.stroke.color, n.stroke.opacity ?? 1)}`, 'paint-order': 'stroke fill' });
  css['text-align'] = { left: 'left', center: 'center', right: 'right', justified: 'justify' }[n.text.align] || 'left';
  css.margin = '0';
  css.padding = '0';
  // Figma laid this text out on one line: keep it on one line at the design width (a substitute or
  // fallback font must not introduce a wrap). Responsive rules may re-enable wrapping.
  if (n.text.autoResize === 'width-height' || (n.text.lines === 1 && !n.text.content.includes('\n'))) css['white-space'] = 'nowrap';
  // Gradient / image text fills come from node fills when the run colour is not solid.
  const g = n.fills.find((f) => f.type === 'gradient');
  if (g) {
    css.background = gradientCss(g);
    css['-webkit-background-clip'] = 'text';
    css['background-clip'] = 'text';
    css['-webkit-text-fill-color'] = 'transparent';
    css.color = 'transparent';
  }
  return { css, dom };
}

export function runCss(r, ctx) {
  const css = {
    'font-family': fontStack(r.family, ctx.fonts),
    'font-size': px(r.size),
    'font-weight': String(r.weight || 400),
    'font-style': r.italic ? 'italic' : 'normal',
    'line-height': r.lineHeight ? px(r.lineHeight) : 'normal',
    'letter-spacing': r.letterSpacing ? px(r.letterSpacing) : 'normal',
    color: rgba(r.color),
  };
  // A substitute may need the design face's intrinsic style (e.g. "Designer Regular" is drawn
  // oblique). Only while substituting: real font files make the override unnecessary.
  const sub = ctx.fonts?.substitutions?.[r.family];
  if (sub?.substitute && !sub.files?.length) {
    if (sub.style) css['font-style'] = sub.style;
    if (sub.weight) css['font-weight'] = String(sub.weight);
  }
  if (r.textCase === 'upper') css['text-transform'] = 'uppercase';
  else if (r.textCase === 'lower') css['text-transform'] = 'lowercase';
  else if (r.textCase === 'title') css['text-transform'] = 'capitalize';
  if (r.decoration === 'underline') css['text-decoration'] = 'underline';
  if (r.decoration === 'strikethrough') css['text-decoration'] = 'line-through';
  return css;
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function textHtml(n, dom, ctx) {
  const domCss = runCss(dom, ctx);
  const ps = n.text.paragraphSpacing || 0;
  // With paragraph spacing, a newline ends a paragraph (rendered as a block with bottom margin). A
  // heading's line breaks were placed for the design width: they carry a space, so below it they can
  // be dropped (f2d-lb) and the heading rewraps without orphans.
  const NL = ps ? '\u0000' : /^h[1-6]$/.test(n.a?.tag || '') ? ' <br class="f2d-lb">' : '<br>';
  const html = n.text.runs
    .map((r) => {
      const c = runCss(r, ctx);
      const diff = Object.entries(c).filter(([k, v]) => domCss[k] !== v);
      let body = escapeHtml(r.text).replace(/\n/g, NL);
      const wrap = (s) => {
        let t = s;
        if (diff.length && t) t = `<span style="${diff.map(([k, v]) => `${k}:${v}`).join(';')}">${t}</span>`;
        if (r.href && t) t = `<a href="${escapeHtml(r.href)}">${t}</a>`;
        return t;
      };
      return body.split(NL).map(wrap).join(NL);
    })
    .join('');
  // Text colour is carried by --f2d-c on the element and applied to an inner span: builder CSS
  // such as Divi's `#et-boc .et-l p { color: inherit !important }` cannot override a custom property.
  if (!ps) return `<span class="f2d-tc">${html}</span>`;
  const paras = html.split(NL);
  return paras.map((p, i) => `<span class="f2d-para f2d-tc" style="display:block${i < paras.length - 1 ? `;margin-bottom:${px(ps)}` : ''}">${p || '&nbsp;'}</span>`).join('');
}

export const BASE_TEXT_CSS = '.f2d-tc { color: var(--f2d-c, inherit); }';
// Keyboard users must see where focus is; the design has no focus state, so a neutral ring is used.
export const FOCUS_CSS = 'a[class*="f2d-"]:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }';

// ---------- placement inside parent ----------
function placeCss(n, p, ctx) {
  const css = {};
  if (!p) return css;
  const L = layoutOf(p);
  const inFlow = L && n.positioning !== 'absolute' && !n.a.background && !(p.a.inferredLayout && L.decor?.includes(n.id));
  if (inFlow) {
    const row = L.dir === 'row';
    const main = row ? 'w' : 'h', cross = row ? 'h' : 'w';
    const mainSize = row ? n.box.w : n.box.h, crossSize = row ? n.box.h : n.box.w;
    const ms = n.sizing[main], cs = n.sizing[cross];
    if (n.grow > 0 || ms === 'fill') {
      css.flex = '1 1 0';
      css[row ? 'min-width' : 'min-height'] = '0';
    } else if (ms === 'fixed' || (ms === 'hug' && n.a.role !== 'text' && n.a.role !== 'container' && n.a.role !== 'button')) {
      // Figma never shrinks fixed-size children (it overflows/clips). Large blocks may shrink so
      // layouts stay fluid; icon-scale items (< 100px: arrows, dots, avatars) keep their size.
      const rigid = mainSize < 100;
      css.flex = row ? `0 ${rigid ? 0 : 1} ${px(mainSize)}` : '0 0 auto';
      if (row) {
        if (!rigid) css['min-width'] = '0';
      } else css.height = px(mainSize); // main axis of a column is the height
    } else if (row && n.a.role === 'container' && mainSize >= 200) {
      // A wide content-sized block may give up width when its row runs out of space (at the design
      // width nothing shrinks); otherwise it pushes its siblings off the edge.
      css.flex = '0 1 auto';
      css['min-width'] = '0';
    } else css.flex = '0 0 auto';
    if (cs === 'fill' || n.alignSelf === 'stretch') css['align-self'] = 'stretch';
    else if (cs === 'fixed') {
      // (a full-bleed frame in a column is the page width, whatever the screen — its fluid gutters
      // are computed from the page)
      css[row ? 'height' : 'width'] = !row && ctx.frameW && n.box.w >= ctx.frameW * 0.95 ? '100%' : px(crossSize);
      if (!row) css['max-width'] = '100%';
    }
    // A hug item wider than its parent's content box overflows in Figma (centred overflow);
    // CSS would shrink it, so pin its width at the design size. Responsive rules relax it.
    const [, pr, , pl] = L.padding || [0, 0, 0, 0];
    if (!row && cs === 'hug' && n.box.w > p.box.w - pl - pr + 1) (css.width = px(n.box.w)), (css['flex-shrink'] = '0');
    // Leaves with fixed main size inside rows keep their width as basis; text in columns keeps its wrap width.
    if (!row && n.a.role === 'text' && n.sizing.w === 'fixed') (css.width = px(n.box.w)), (css['max-width'] = '100%');
    if (L.gaps && L.order) {
      // Inferred non-uniform gaps: margin before each item.
      const i = L.order.indexOf(n.id);
      if (i > 0) css[row ? 'margin-left' : 'margin-top'] = px(L.gaps[i - 1]);
    } else if (L.gap < 0 && L.justify !== 'space-between') {
      // Negative auto-layout spacing (items overlap on purpose, e.g. a photo over a colour panel): CSS
      // gap cannot be negative, so every item after the first pulls back by that much.
      const flow = p.children.filter((c) => ctx.nodes?.[c]?.positioning !== 'absolute');
      if (flow.indexOf(n.id) > 0) css[row ? 'margin-left' : 'margin-top'] = px(L.gap);
    }
    return css;
  }
  // Absolute placement relative to the parent's box, anchored by constraints.
  const b = visualBox(n, ctx.assetMeta?.(n.asset));
  const dx = b.x - p.box.x, dy = b.y - p.box.y;
  css.position = 'absolute';
  let h = n.constraints?.h || 'min';
  // Designers rarely set constraints; Figma's default is "left". Inside a parent that resizes with the
  // page (full-width or fill-sized), an element that is exactly centred (±2px) or full-width keeps that
  // relationship, and one placed in the right part of the parent stays anchored to the right edge.
  const fluidParent = ctx.frameW && (p.box.w >= ctx.frameW * 0.9 || p.sizing?.w === 'fill');
  // An element spanning its whole fluid parent stays full width whether it was left- or
  // centre-constrained (a centred 1920px band must not stay 1920px wide on a phone).
  if ((h === 'min' || h === 'center') && fluidParent && !n.a.background && Math.abs(dx) <= 1 && Math.abs(b.w - p.box.w) <= 1) h = 'stretch';
  else if (h === 'min' && fluidParent && !n.a.background) {
    if (Math.abs(dx + b.w / 2 - p.box.w / 2) <= 2 && b.w < p.box.w * 0.9) h = 'center';
    else if (dx >= p.box.w * 0.6) h = 'max';
  }
  if (h === 'max') css.right = px(p.box.w - dx - b.w);
  else if (h === 'center') css.left = `calc(50% + ${px(round(dx + b.w / 2 - p.box.w / 2 - b.w / 2))})`;
  else if (h === 'stretch') (css.left = px(dx)), (css.right = px(p.box.w - dx - b.w));
  else if (h === 'scale') (css.left = `${round((dx / p.box.w) * 100, 3)}%`), (css.width = `${round((b.w / p.box.w) * 100, 3)}%`);
  else css.left = px(dx);
  let v = n.constraints?.v || 'min';
  // Vertically: an element whose bottom edge coincides with its parent's bottom edge (e.g. a curve
  // mask closing a section) stays pinned to the bottom when the parent's height changes.
  if (v === 'min' && !n.a.background && dy > 2 && Math.abs(dy + b.h - p.box.h) <= 2) v = 'max';
  if (v === 'max') css.bottom = px(p.box.h - dy - b.h);
  else css.top = px(dy);
  if (!css.width && h !== 'stretch') css.width = px(b.w);
  if (n.a.role !== 'text' || n.text?.autoResize !== 'width-height') css.height = px(b.h);
  if (n.a.background) Object.assign(css, { left: '0', top: '0', width: '100%', height: '100%', right: null, bottom: null });
  return css;
}

// ---------- box tree ----------
export function buildBoxTree(ir, frameId, ctx) {
  const frame = ir.frames.find((f) => f.id === frameId) || ir.frames[0];
  const N = ir.nodes;
  const issues = [];
  ctx = {
    fonts: {},
    assetUrl: () => null,
    videoStill: () => null,
    ...ctx,
    frameW: frame.width,
    nodes: N,
    issue: (code, severity, nodeId, message) => issues.push({ code, severity, nodeId, message }),
  };

  const inWidget = (n) => {
    for (let p = n.parent; p; p = N[p]?.parent) if (N[p]?.a?.widget && N[p].a.widget !== 'counter-digit') return true;
    return false;
  };
  function box(id, parentId, zIndex) {
    const n = N[id];
    const p = parentId ? N[parentId] : null;
    const role = n.a.role;
    const b = { id, cls: n.cls, name: n.name, role, kind: role, tag: 'div', children: [], css: { base: {}, wide: {}, narrow: {}, tabletExtra: {}, tablet: {}, mobileExtra: {}, phone: {} }, decor: !!n.a.decor, section: role === 'section' };
    const base = b.css.base;
    Object.assign(base, placeCss(n, p, ctx));
    if (n.opacity < 1) base.opacity = String(round(n.opacity, 3));
    if (n.blend) base['mix-blend-mode'] = n.blend.replace(/_/g, '-').toLowerCase();
    if (zIndex != null) {
      if (!base.position) base.position = 'relative';
      base['z-index'] = String(zIndex);
    }
    if (n.a.decor) {
      base['pointer-events'] = 'none';
      b.ariaHidden = true;
    }

    if (role === 'text') {
      const { css, dom } = textCss(n, ctx);
      Object.assign(base, css);
      b.tag = n.a.tag || 'p';
      b.kind = 'text';
      b.html = textHtml(n, dom, ctx);
      b.text = n.text.content;
      b.typo = { size: dom.size, lineHeight: dom.lineHeight, letterSpacing: dom.letterSpacing };
      if (n.a.counter) base['white-space'] = 'pre';
      if (n.text.valign !== 'top' && n.text.autoResize === 'none') {
        Object.assign(base, { display: 'flex', 'flex-direction': 'column', 'justify-content': n.text.valign === 'center' ? 'center' : 'flex-end' });
      }
      return b;
    }
    if (role === 'svg' || role === 'image' || role === 'divider' || role === 'shape') {
      const assetKey = n.asset || n.fillAsset;
      const url = assetKey ? ctx.assetUrl(assetKey, n) : null;
      Object.assign(base, radiusCss(n), effectCss(n));
      if (url) {
        b.kind = role === 'divider' || role === 'shape' ? 'svg' : role;
        b.tag = 'img';
        b.src = url;
        b.asset = assetKey;
        const ib = visualBox(n, ctx.assetMeta?.(n.asset));
        b.w = ib.w;
        b.h = ib.h;
        b.alt = role === 'image' ? n.name.replace(/[-_,]+/g, ' ').replace(/\s+\d+$/, '').trim() : '';
        // Lazy loading never fetches images that cannot intersect the viewport (inside horizontally
        // clipped strips, outside the frame) — and above-the-fold images should not wait.
        b.eager = n.box.y < 1200 || n.box.x < 0 || n.box.x + n.box.w > frame.width || inWidget(n);
        base.display = 'block';
        const fill = n.fills.find((f) => f.type === 'image');
        base['object-fit'] = role === 'image' ? objectFit(fill?.scaleMode) : 'fill';
        // Anchored left + right (stretch) means the width follows the parent.
        if (!base.width && !base.flex?.startsWith('1') && !(base.left && base.right)) base.width = px(ib.w);
        if (!base.height && base['align-self'] !== 'stretch') base.height = px(ib.h);
        // Figma lines have a zero-height layout box; draw them at their rendered (stroke) size.
        const asset = ctx.assetMeta?.(assetKey);
        if (n.box.h < 1) base.height = px(Math.max(n.renderBox?.h || 0, asset?.height || 0, 1));
        if (n.box.w < 1) base.width = px(Math.max(n.renderBox?.w || 0, asset?.width || 0, 1));
        // Only in-flow images are clamped; absolute ones may bleed past the parent like in Figma.
        if (base.position !== 'absolute') base['max-width'] = base['max-width'] || '100%';
        else base['max-width'] = 'none';
      } else {
        // No asset: draw it from style (rect/ellipse/line).
        b.kind = 'shape';
        Object.assign(base, backgroundCss(n, ctx), borderCss(n));
        if (n.type === 'ellipse') base['border-radius'] = '50%';
        if (n.type === 'line') {
          const s = n.stroke;
          base['border-top'] = `${px(s?.weight || 1)} solid ${rgba(s?.color || '#000')}`;
          base.height = '0';
        }
        if (!base.width) base.width = px(n.box.w);
        if (!base.height) base.height = px(n.box.h);
        if (assetKey) ctx.issue('ASSET_UNRESOLVED', 'major', n.id, `Asset ${assetKey} for "${n.name}" did not resolve`);
      }
      return b;
    }

    // containers, sections, buttons, page
    if (role === 'button') (b.kind = 'button'), (b.tag = 'a'), (b.href = n.interactions.find((i) => i.url)?.url || '#');
    Object.assign(base, backgroundCss(n, ctx), borderCss(n), radiusCss(n), effectCss(n));
    if (n.clips) base.overflow = 'hidden';
    const L = layoutOf(n);
    let kids = n.children.filter((c) => !['asset-part'].includes(N[c].a.role));
    if (L?.inferred && L.order) {
      // Inferred flex rows/columns flow in geometric order, not Figma layer order.
      const pos = new Map(L.order.map((id, i) => [id, i]));
      const out = kids.filter((c) => !pos.has(c));
      kids = [...out, ...kids.filter((c) => pos.has(c)).sort((a, b) => pos.get(a) - pos.get(b))];
    }
    const anyAbsolute = !L || kids.some((c) => N[c].positioning === 'absolute' || N[c].a.background || L.decor?.includes(c));
    if (L) {
      base.display = 'flex';
      // Figma's only "reverse" is itemReverseZIndex (first layer drawn on top): paint order, never flow
      // order — see the z-index below.
      base['flex-direction'] = L.dir === 'row' ? 'row' : 'column';
      if (L.wrap) base['flex-wrap'] = 'wrap';
      // With space-between Figma reports its computed auto spacing as the gap; in CSS that would
      // become a hard minimum, so the gap is dropped and justify-content distributes the space.
      if (L.gap > 0 && !L.gaps && L.justify !== 'space-between') base.gap = L.wrap && L.counterGap ? `${px(L.counterGap)} ${px(L.gap)}` : px(L.gap);
      else if (L.wrap && L.counterGap && L.justify === 'space-between') base['row-gap'] = px(L.counterGap);
      if (L.justify && L.justify !== 'start') base['justify-content'] = justifyMap[L.justify] || 'flex-start';
      base['align-items'] = alignMap[L.align] || 'flex-start';
      const [t, r, bb, l] = L.padding;
      if (t || r || bb || l) base.padding = [t, r, bb, l].map(px).join(' ');
      base['box-sizing'] = 'border-box';
    }
    if (anyAbsolute && !base.position) base.position = 'relative';
    // Size of the container itself (when not decided by the parent flex rules).
    if (!p) base.width = '100%';
    else if (!base.width && !base.flex?.startsWith('1') && base['align-self'] !== 'stretch' && n.sizing.w === 'fixed' && base.position !== 'absolute') {
      // A full-bleed frame is the page width, whatever the screen: a fixed 1920px box would disagree
      // with its own fluid gutters (computed from the page) on any other width.
      base.width = n.box.w >= frame.width * 0.95 ? '100%' : px(n.box.w);
      base['max-width'] = '100%';
    }
    // A frame (fixed or fill height) whose children overhang it on purpose (a colour panel running
    // into the next section) keeps a real height on desktop — growing to contain them would push every
    // later section down. Below desktop the responsive rules relax it.
    const overhang = L && n.sizing.h !== 'hug' && n.children.some((c) => N[c].positioning !== 'absolute' && N[c].box.y + N[c].box.h > n.box.y + n.box.h + 1);
    if (overhang && !base.height) base.height = px(n.box.h);
    else if (!L || n.sizing.h === 'fixed') {
      if (!base.height) base[L ? 'min-height' : 'height'] = px(n.box.h);
    }
    // Sections: fluid side gutters that equal the design padding at the design width.
    if (role === 'section' && L) {
      const [t, r, bb, l] = L.padding;
      if (l === r && l >= 60 && Math.abs(n.box.w - frame.width) < 2) {
        const content = round(n.box.w - 2 * l);
        base.padding = `${px(t)} max(var(--f2d-gutter, 24px), calc((100% - ${px(content)}) / 2)) ${px(bb)}`;
        b.contentWidth = content;
      }
    }
    if (role === 'section' || role === 'page') {
      if (role === 'section') delete base.flex;
      base.width = '100%';
      base['box-sizing'] = 'border-box';
    }
    // The header stays pinned at every width (below the WordPress toolbar when it shows), above the
    // page, painted so content never shows through it.
    if (role === 'section' && n.a.header) {
      Object.assign(base, { position: 'sticky', top: 'var(--wp-admin--admin-bar--height, 0px)', 'z-index': '100' });
      if (!base.background && !base['background-color']) base['background-color'] = rgba(N[frame.rootId].fills?.find((f) => f.type === 'solid')?.color || '#ffffff');
      b.header = true;
    }

    if (n.states?.hover) hoverRules(b, n, ctx);

    // children, preserving Figma paint order when anything overlaps
    // (reversed stacking: earlier children paint above later ones, e.g. a header whose logo overlay
    // hangs over the banner below it)
    const needZ = (anyAbsolute || L?.reverse) && kids.length > 1;
    kids.forEach((c, i) => b.children.push(box(c, id, needZ ? (L?.reverse ? kids.length - i : i) : null)));
    b.layout = L ? { dir: L.dir, inferred: !!L.inferred, gap: L.gap, padding: L.padding } : null;
    return b;
  }

  // Hover (and keyboard focus) states from IR `states.hover`: diff the variant against the base,
  // walking children by structural position; emit only properties that change.
  function hoverRules(b, n, ctx2) {
    const dur = n.interactions.find((i) => i.trigger === 'hover')?.durationMs ?? 200;
    const rules = [];
    const visit = (node, st) => {
      if (!node || !st) return;
      const css = {};
      // "Baked" = drawn from an exported asset (colours fixed in the file); live nodes can restyle.
      const baked = !!node.asset && ['svg', 'image'].includes(node.a?.role);
      if (node.text && st.text) {
        const c0 = rgba(node.text.runs[0]?.color), c1 = rgba(st.text.runs[0]?.color);
        if (c1 && c0 !== c1) Object.assign(css, { color: c1, '--f2d-c': c1 });
      } else if (!baked) {
        const bg0 = backgroundCss({ ...node, a: { role: 'container' } }, ctx2), bg1 = backgroundCss({ ...node, fills: st.fills, a: { role: 'container' } }, ctx2);
        const k0 = bg0.background || bg0['background-color'] || 'transparent', k1 = bg1.background || bg1['background-color'] || 'transparent';
        if (k0 !== k1) css[bg1.background ? 'background' : 'background-color'] = k1;
        const br0 = borderCss(node), br1 = borderCss({ ...node, stroke: st.stroke });
        for (const k of new Set([...Object.keys(br0), ...Object.keys(br1)])) if (br0[k] !== br1[k]) css[k] = br1[k] || (k === 'box-shadow' ? 'none' : '0 solid transparent');
        if (st.opacity !== undefined && st.opacity !== node.opacity) css.opacity = String(st.opacity);
      }
      if (baked && JSON.stringify(st.fills) !== JSON.stringify(node.fills)) {
        ctx2.issue('HOVER_ON_ASSET', 'minor', node.id, `Hover changes "${node.name}", which is rendered from an exported asset with its colours baked in; the hover variant was not exported`);
      }
      if (Object.keys(css).length) rules.push({ target: node.cls, css });
      if (!baked) node.children.forEach((cid, i) => visit(N[cid], st.children?.[i]));
    };
    visit(n, n.states.hover);
    if (rules.length) {
      b.hover = rules;
      b.css.base.transition = `background-color ${dur}ms, border-color ${dur}ms, color ${dur}ms, opacity ${dur}ms`;
    }
  }

  const root = box(frame.rootId, null, null);
  root.kind = 'page';
  // Clip sideways only: any other overflow on the page root (the frame's own clip) would make it a scroll
  // container, and the sticky header would stick to it instead of the window.
  delete root.css.base.overflow;
  root.css.base['overflow-x'] = 'clip';
  root.css.base.position = 'relative';
  delete root.css.base.height;
  applyResponsive(root, ir, frame);
  applyInteractive(root, ir, frame);
  applyFinish(root, ir, frame);
  return { frame: { id: frame.id, width: frame.width, height: frame.height }, root, issues };
}

// ---------- inferred responsive rules (no tablet/phone frames in the design) ----------
function applyResponsive(root, ir, frame) {
  const N = ir.nodes;
  const FW = frame.width;
  // Narrowest widths each breakpoint must still work at, and the gutters used there.
  const BP = { tablet: { min: 768, gutter: 32 }, phone: { min: 320, gutter: 20 } };
  // "Narrow desktop": below the width at which the widest centred content column (plus its minimum
  // gutters) still fits, everything that was placed for the design width starts to collide. Rules for
  // that range go in css.narrow, emitted before (and overridden by) the tablet/phone rules.
  let widestContent = 0;
  for (const n of Object.values(N)) {
    const L = n.layout;
    if (L && n.box.w >= FW * 0.95 && L.padding[1] === L.padding[3] && L.padding[3] >= 60) widestContent = Math.max(widestContent, n.box.w - 2 * L.padding[3]);
  }
  // Laptop tier edge: 1366, raised to the width at which the content column stops fitting.
  const contentFit = Math.round(widestContent ? widestContent + 48 - 1 : FW - 1);
  if (FW > LADDER.laptop + 1) root.narrowAt = Math.max(LADDER.laptop, Math.min(contentFit, FW - 1));
  root.frameW = FW;
  // Bucket of the ladder tier covering a computed break width (never a narrower tier).
  const bucketAt = (x, w) => (x.css[tierOf(w, root.narrowAt)] ??= {});

  // Width a node's content cannot shrink below, estimated from the IR: fixed-size vectors, buttons and
  // one-line text keep their width; images shrink to half; wrapping text to ~120px; plus padding/gaps.
  const memo = new Map();
  // Widgets (carousels) and clipping containers whose children really overflow them (masks, strips)
  // hide content by design and can shrink; a card that merely clips its rounded corners cannot.
  const hidesOverflow = (n) => ['carousel-strip', 'counter-digit'].includes(n.a.widget) || (n.clips && n.children.some((c) => N[c].box.x < n.box.x - 1 || N[c].box.x + N[c].box.w > n.box.x + n.box.w + 1));
  const minContent = (id) => {
    if (memo.has(id)) return memo.get(id);
    const n = N[id];
    let v;
    if (n.a.decor || n.positioning === 'absolute') v = 0;
    else if (hidesOverflow(n) && !n.text && n.a.role === 'container') v = Math.min(n.box.w, 120);
    else if (n.a.role === 'svg' || n.a.role === 'button' || n.a.role === 'divider') v = n.box.w;
    else if (n.a.role === 'image') v = n.box.w * 0.5;
    else if (n.text) {
      // One-line text: its words, not its (possibly stretched) box — estimated from character count.
      const size = Math.max(...n.text.runs.map((r) => r.size));
      const oneLine = n.text.lines === 1 && !n.text.content.includes('\n');
      // (Capitals in display faces run ~0.85em per character; mixed case ~0.6em.)
      const upper = n.text.runs.some((r) => r.textCase === 'upper') || !/[a-z]/.test(n.text.content);
      v = oneLine ? (n.sizing.w === 'hug' ? n.box.w : Math.min(n.box.w, n.text.content.length * size * (upper ? 0.85 : 0.6))) : Math.min(n.box.w, 120);
    } else {
      const L = layoutOf(n);
      const kids = n.children.filter((c) => !['asset-part'].includes(N[c].a.role));
      const pad = L ? L.padding[1] + L.padding[3] : 0;
      const mins = kids.map(minContent);
      v = L?.dir === 'row' && !L.wrap ? mins.reduce((a, b) => a + b, 0) + (L.justify === 'space-between' ? 0 : L.gap * Math.max(0, kids.length - 1)) + pad : Math.max(0, ...mins) + pad;
    }
    memo.set(id, v);
    return v;
  };

  // The same minimum on a phone, where text wraps (white-space is released below desktop): text counts
  // with its wrapped minimum, except short labels that keep their single line.
  const memoP = new Map();
  const minPhone = (id) => {
    if (memoP.has(id)) return memoP.get(id);
    const n = N[id];
    let v;
    if (n.text) v = n.text.content.trim().length <= 12 ? Math.min(n.box.w, minContent(id)) : Math.min(n.box.w, 120);
    else if (n.a.decor || n.positioning === 'absolute' || (hidesOverflow(n) && n.a.role === 'container')) v = minContent(id);
    else if (['svg', 'button', 'divider', 'image'].includes(n.a.role)) v = minContent(id);
    else {
      const L = layoutOf(n);
      const kids = n.children.filter((c) => !['asset-part'].includes(N[c].a.role));
      const pad = L ? Math.min(L.padding[1], 20) + Math.min(L.padding[3], 20) : 0;
      const mins = kids.map(minPhone);
      v = L?.dir === 'row' && !L.wrap ? mins.reduce((a, b) => a + b, 0) + 16 * Math.max(0, kids.length - 1) + pad : Math.max(0, ...mins) + pad;
    }
    memoP.set(id, v);
    return v;
  };

  // Longest word of a text in em (font-size units), from the design's own glyph widths, with a
  // margin because the rendered font may be wider (substitute) and uppercase display faces are wide.
  const longestWordEm = (n) => {
    const t = n.text;
    const words = t.content.split(/\s+/).filter(Boolean);
    if (!words.length) return 0;
    const size = Math.max(...t.runs.map((r) => r.size));
    const lines = Math.max(1, t.lines || 1);
    const perLine = Math.max(1, t.content.replace(/\n/g, '').length / lines);
    const typical = t.runs.some((r) => r.textCase === 'upper') ? 0.72 : 0.55;
    // The box measures the glyphs only when it hugs the text or the text wraps in it; a one-line text in
    // a wider fill/fixed box says nothing about its letters.
    const measured = n.sizing?.w === 'hug' || lines > 1 ? n.box.w / perLine / size : typical;
    const emPerChar = Math.max(measured, typical) * 1.15;
    return Math.max(...words.map((w) => w.length)) * emPerChar;
  };

  const gutterExpr = (col) => `max(var(--f2d-gutter, 24px), calc((100% - ${px(col)}) / 2))`;
  const vpad = (v, bp) => (v < 40 ? v : bp === 'tablet' ? round(v * 0.6) : round(Math.min(v * 0.5, 48)));
  // Minimum top padding a child must keep below desktop (set by its parent, see the straddle rule).
  const needTop = new Map();
  const hpad = (v, bp) => (v < 24 ? v : Math.min(v, BP[bp].gutter));

  const parentOfBox = new Map();
  const indexBoxes = (x, p) => (parentOfBox.set(x, p), x.children.forEach((c) => indexBoxes(c, x)));
  indexBoxes(root, null);
  const walk = (b, parent, inSection) => {
    const n = N[b.id];
    const base = b.css.base;
    const T = b.css.tablet, P = b.css.phone, NR = (b.css.narrow ??= {});
    // Composites that keep their own structure (carousel strips, rolling digits, tickers and everything
    // inside a ticker, card strips); forms and accordions are ordinary layout and take every rule.
    let inMarquee = false;
    for (let q = n.parent; q && !inMarquee; q = N[q]?.parent) inMarquee = N[q]?.a.widget === 'marquee';
    // (large items only: a row of small overlapping avatars is just a row)
    const layered = layoutOf(n)?.dir === 'row' && layoutOf(n).gap < 0 && n.children.filter((c) => N[c].positioning !== 'absolute' && N[c].box.w >= 200).length >= 2;
    const widget = ['carousel-strip', 'counter-digit', 'marquee'].includes(n.a.widget) || b.decor || n.a.strip || inMarquee || layered;
    const L = layoutOf(n);

    // ---- layered row (negative auto-layout spacing: a photo laid over a colour panel). Narrow
    // desktops scale it as one composition; tablets and phones show the content full width and turn
    // colour-only items into a band beneath it, with the badges that sat on them anchored inside.
    if (layered) {
      const kids = b.children.filter((c) => c.css.base.position !== 'absolute');
      // Narrow desktop: the layers keep their proportions — widths and the overlap as shares of the row.
      Object.assign(NR, { 'flex-wrap': 'nowrap', 'min-width': '0' });
      kids.forEach((c, i) => Object.assign(c.css.narrow, { flex: '0 0 auto', width: `${round((N[c.id].box.w / n.box.w) * 100, 3)}%`, 'min-width': '0', 'max-width': 'none', height: 'auto', 'aspect-ratio': `${round(N[c.id].box.w)} / ${round(N[c.id].box.h)}`, ...(i > 0 ? { 'margin-left': `${round((layoutOf(n).gap / n.box.w) * 100, 3)}%` } : {}) }));
      const hasContent = (id) => !!N[id].text || ['image', 'svg'].includes(N[id].a.role) || N[id].children.some(hasContent);
      const panels = kids.filter((c) => !hasContent(c.id));
      const badges = b.children.filter((c) => c.css.base.position === 'absolute' && !c.decor);
      const hit = (a, z) => a.x < z.x + z.w && z.x < a.x + a.w && a.y < z.y + z.h && z.y < a.y + a.h;
      const onPanel = badges.filter((x) => panels.some((pnl) => hit(N[x.id].box, N[pnl.id].box)) && !kids.filter((k) => !panels.includes(k)).some((k) => hit(N[x.id].box, N[k.id].box)));
      const bandH = Math.max(0, ...onPanel.map((x) => N[x.id].box.h)) + 48;
      for (const bp of ['tablet', 'phone']) {
        const g = BP[bp].gutter;
        Object.assign(b.css[bp], { 'flex-direction': 'column', 'flex-wrap': 'nowrap', 'align-items': 'stretch', position: 'relative', width: '100%', 'max-width': '100%', height: 'auto', 'min-height': '0', flex: '0 0 auto' });
        for (const c of kids) {
          const panel = panels.includes(c);
          Object.assign(c.css[bp], { margin: '0', width: '100%', 'max-width': '100%', flex: '0 0 auto', order: panel ? '2' : '1', height: panel ? (onPanel.length ? px(bandH) : '24px') : 'auto', ...(panel ? {} : { 'aspect-ratio': `${round(N[c.id].box.w)} / ${round(N[c.id].box.h)}` }) });
        }
        // The badge becomes the band itself (in flow, on the panel's colour), so the band grows with it when
        // its text wraps on a narrow phone; the empty panel then has nothing left to show.
        const fill = panels.map((pnl) => N[pnl.id].fills?.find((f) => f.type === 'solid')?.color).find(Boolean);
        if (onPanel.length && fill) {
          for (const pnl of panels) pnl.css[bp].display = 'none';
          for (const x of onPanel) Object.assign(x.css[bp], { position: 'relative', top: 'auto', bottom: 'auto', left: 'auto', right: 'auto', transform: 'none', order: '2', width: '100%', 'max-width': '100%', 'flex-wrap': 'wrap', padding: `24px ${px(g)}`, 'box-sizing': 'border-box', 'background-color': fill, margin: '0' });
        } else for (const x of onPanel) Object.assign(x.css[bp], { top: 'auto', bottom: '24px', left: px(g), right: 'auto', transform: 'none' });
      }
    }

    // ---- card strip (a row running past its box by design): one clipped row down to the tablet
    // breakpoint, then a swipeable row — one card and a peek of the next — instead of a tall stack.
    if (n.a.strip) {
      // Items keep their size: the row is meant to run past its box (an ancestor clips the rest).
      for (const c of b.children) if (c.css.base.position !== 'absolute') (c.css.base['flex-shrink'] = '0'), (c.css.narrow['flex-shrink'] = '0');
      // …and the rest are reachable: the strip scrolls sideways at every width (trackpad, swipe,
      // keyboard), snapping to cards. At rest it looks exactly like the clipped design.
      Object.assign(base, { 'overflow-x': 'auto', 'overflow-y': 'hidden', 'scroll-snap-type': 'x proximity', 'scrollbar-width': 'none', 'overscroll-behavior-x': 'contain' });
      for (const c of b.children) if (c.css.base.position !== 'absolute') c.css.base['scroll-snap-align'] = 'start';
      for (const bp of ['tablet', 'phone']) {
        Object.assign(b.css[bp], { width: '100%', 'max-width': '100%', 'flex-direction': 'row', 'flex-wrap': 'nowrap', 'overflow-x': 'auto', 'scroll-snap-type': 'x mandatory', 'scrollbar-width': 'none', 'overscroll-behavior-x': 'contain', 'margin-left': '0', height: 'auto' });
        for (const c of b.children) if (c.css.base.position !== 'absolute') Object.assign(c.css[bp], { flex: `0 0 min(${px(N[c.id].box.w)}, ${bp === 'phone' ? 85 : 60}%)`, width: 'auto', 'max-width': 'none', 'scroll-snap-align': 'start', height: 'auto' });
      }
      b.css.tablet.gap = px(Math.min(L?.gap || 16, 20));
    }

    // ---- text: scale down, but never so large that the longest word cannot fit the section
    if (b.kind === 'text' && b.typo && !n.a.counter) {
      const s = b.typo.size;
      const wordEm = longestWordEm(n);
      // Stepped sizes, one explicit value per ladder tier (no fluid type): headings step down at tablet
      // and phone, and every tier's value lets the longest word fit at that tier's narrowest width.
      // Columns hold on laptop / tablet-extra (the text keeps its share of the content column); from
      // tablet down blocks stack (a narrow block in a two-up grid gets half the line). Only tiers whose
      // value differs from the tier above are written. Below 360px long words may wrap.
      // Width available to the text: its own box, or — when it hugs its content — the content box of the
      // nearest ancestor that does not (a hugging label has its card's width to grow into).
      let room = n.box.w;
      for (let q = n; q && q.sizing?.w === 'hug' && q.parent && N[q.parent]; ) {
        q = N[q.parent];
        const qL = layoutOf(q);
        room = Math.max(room, q.box.w - (qL ? qL.padding[1] + qL.padding[3] : 0));
      }
      const share = Math.min(1, room / (widestContent || FW));
      // In a two-up cell at a tier when an ancestor item becomes half of a two-up grid there.
      // The text's share of the line on a tier follows its ancestors there (each tier inherits the rules
      // of the wider ones): half when an ancestor is a two-up grid cell, the full line once an ancestor
      // row stacks, else its share of the content column.
      const ORDER = ['narrow', 'tabletExtra', 'tablet', 'mobileExtra', 'phone'];
      const eff = (x, k, tier) => { let v = x.css.base[k]; for (const t of ORDER.slice(0, ORDER.indexOf(tier) + 1)) if (x.css[t]?.[k] !== undefined) v = x.css[t][k]; return v; };
      const fraction = (tier) => {
        let stacked = false;
        for (let x = parentOfBox.get(b); x; x = parentOfBox.get(x)) {
          if (/calc\(50%/.test(eff(x, 'flex', tier) || '')) return stacked ? 0.5 : Math.min(share, 0.5);
          if ((x.css.base['flex-direction'] || '').startsWith('row') && eff(x, 'flex-direction', tier) === 'column') stacked = true;
        }
        // (from mobile-extra down every block has the full line: single column)
        return stacked || ORDER.indexOf(tier) >= 3 ? 1 : share;
      };
      const steps = [
        ['narrow', 1, LADDER.tabletExtra + 1, 24],
        ['tabletExtra', 1, LADDER.tablet + 1, 24],
        ['tablet', 0.72, LADDER.mobileExtra + 1, BP.tablet.gutter],
        ['mobileExtra', 0.62, LADDER.phone + 1, 24],
        ['phone', 0.52, 360, BP.phone.gutter],
      ].map(([tier, k, minW, gutter]) => [tier, k, minW, gutter, fraction(tier)]);
      let prev = s;
      for (const [tier, k, minW, gutter, f] of steps) {
        let size = Math.max(s > 24 ? Math.max(24, s * k) : s, Math.min(s, 14));
        if (wordEm > 0 && !b.decor) size = Math.min(size, ((minW - 2 * gutter) * f) / wordEm);
        // Type only steps down as the screen narrows (a block that gets a full line again keeps its size).
        size = Math.min(prev, round(Math.max(size, Math.min(s, 12)), 1));
        if (Math.abs(size - prev) >= 0.5) {
          const css = (b.css[tier] ??= {});
          css['font-size'] = px(size);
          if (b.typo.lineHeight) css['line-height'] = `${round(b.typo.lineHeight / s, 3)}em`;
          if (b.typo.letterSpacing) css['letter-spacing'] = `${round(b.typo.letterSpacing / s, 4)}em`;
          prev = size;
        }
      }
      if (/^h[1-6]$/.test(b.tag)) P['overflow-wrap'] = 'break-word';
      // No orphaned words: headings balance their lines, body text avoids a lone last word, from the
      // laptop tier down (the design's own line breaks stay untouched at the design width).
      if (!b.decor && b.text.trim().split(/\s+/).length >= 3) NR['text-wrap'] = /^h[1-6]$/.test(b.tag) ? 'balance' : 'pretty';
      // One-line design text may wrap once the content column is narrower than the design (a heading
      // cut off at the right edge, two labels running into each other).
      // A long e-mail address or URL cannot wrap between words: below desktop it may wrap anywhere.
      if (/\S*(@|:\/\/|www\.)\S{8,}/.test(b.text)) for (const bp of ['narrow', 'tablet', 'phone']) b.css[bp]['overflow-wrap'] = 'anywhere';
      if (base['white-space'] === 'nowrap' && !b.decor && b.text.length > 12) {
        NR['white-space'] = T['white-space'] = P['white-space'] = 'normal';
        // On narrow desktops a fixed-width one-line box may still grow to its line (a wider stand-in
        // font must not wrap it while there is room); it wraps only when its container is narrower.
        // (Unless its composition already bounds it before the next item on its line.)
        if (/px$/.test(base.width || '') && !NR.width) Object.assign(NR, { width: 'max-content', 'max-width': '100%' });
      }
      // A text block centred in its parent in the design (narrower than the parent) stays visually
      // centred when it wraps below desktop, whatever its own text alignment was.
      const pn = n.parent && N[n.parent];
      // (not text that merely sits beside an icon in a row)
      const besideSiblings = layoutOf(pn || {})?.dir === 'row' && pn.children.filter((c) => N[c].positioning !== 'absolute').length > 1;
      // Measured against the parent's content box: text that fills a symmetrically padded card is
      // not "centred", it just has padding on both sides.
      const pL = pn && layoutOf(pn), pcx = pn && pn.box.x + (pL?.padding[3] || 0), pcw = pn && pn.box.w - (pL ? pL.padding[1] + pL.padding[3] : 0);
      if (pn && !b.decor && !besideSiblings && n.box.w < pcw * 0.95 && Math.abs(n.box.x + n.box.w / 2 - (pcx + pcw / 2)) <= pcw * 0.03) {
        T['text-align'] = P['text-align'] = 'center';
        T['align-self'] = P['align-self'] = T['align-self'] || 'center';
      }
    }

    // ---- padding: fluid gutters on full-width containers; large paddings shrink on tablet/phone
    if (L && !widget && b.kind !== 'page') {
      const [t, r, bb, l] = L.padding;
      const fullBleed = n.box.w >= FW * 0.95;
      if (fullBleed && l === r && l >= 60 && !b.section) {
        const content = round(n.box.w - 2 * l);
        base.padding = `${px(t)} max(var(--f2d-gutter, 24px), calc((100% - ${px(content)}) / 2)) ${px(bb)}`;
      } else if (fullBleed && l !== r && Math.max(l, r) >= 60 && widestContent) {
        // Asymmetric: each side relative to the page's content column — the design gutter becomes the
        // fluid gutter, a larger side keeps its extra as a share of the column (room reserved for side
        // art), a smaller side (an edge bleed) stays. Identical at the design width.
        const G = (FW - widestContent) / 2;
        const col = round(n.box.w - 2 * G);
        const side = (v) => (v < 60 ? px(v) : Math.abs(v - G) <= 2 ? gutterExpr(col) : v > G ? `calc(${gutterExpr(col)} + min(${px(col)}, 100% - 48px) * ${round((v - G) / col, 4)})` : px(v));
        base.padding = `${px(t)} ${side(r)} ${px(bb)} ${side(l)}`;
      }
      // Only padding the box really has: a frame rendered as one image/SVG (an arrow button) has none.
      if (base.padding && (t >= 40 || r >= 24 || bb >= 40 || l >= 24)) {
        for (const bp of ['tablet', 'phone']) {
          // Stacked content gets gutters on both sides, even where the desktop design bled to an edge.
          const g = fullBleed && Math.max(l, r) >= 60 ? BP[bp].gutter : null;
          b.css[bp].padding = [Math.max(vpad(t, bp), needTop.get(b.id) || 0), g ?? hpad(r, bp), vpad(bb, bp), g ?? hpad(l, bp)].map(px).join(' ');
        }
      }
    }

    // ---- buttons stay one unit (label and icon never wrap apart), but a label longer than the line
    // wraps inside the button instead of being clipped at both ends by it; icons keep their size.
    if (b.kind === 'button' && base.display === 'flex') {
      // The label part (a text or a fixed-width label row) takes the room a wider button gets below
      // desktop, so a trailing arrow stays at the button's right edge.
      const label = b.children.find((c) => c.css.base.position !== 'absolute' && (c.kind === 'text' || hasText(ir, c.id)) && N[c.id].box.w >= 100);
      if (label && b.children.filter((c) => c.css.base.position !== 'absolute').length >= 2) for (const bp of ['tablet', 'phone']) Object.assign(label.css[bp], { flex: '1 1 0', 'min-width': '0', width: 'auto' });
      for (const c of b.children) {
        const words = c.kind === 'text' ? N[c.id].text?.content.trim().split(/\s+/).length || 0 : 0;
        if (words < 2) continue;
        // A short label ("Get a quote") never wraps: it keeps its rendered width (a web font a hair wider
        // than Figma's box must not break it) and the button grows by those pixels.
        if (words <= 3 && N[c.id].box.w < 200) {
          for (const bp of ['narrow', 'tablet', 'phone']) Object.assign(c.css[bp], { 'white-space': 'nowrap', width: 'auto', 'min-width': 'max-content', 'max-width': 'none' });
          for (const bp of ['narrow', 'tablet', 'phone']) Object.assign(b.css[bp], { 'min-width': 'max-content' });
          continue;
        }
        for (const bp of ['narrow', 'tablet', 'phone']) Object.assign(c.css[bp], { flex: c.css[bp].flex || '0 1 auto', 'min-width': '0' }); // (a label already stretching keeps that)
      }
    }

    // ---- rows (a button is one unit: its label and icon never wrap apart)
    if (base.display === 'flex' && base['flex-direction']?.startsWith('row') && b.children.length > 1 && !widget && b.kind !== 'button') {
      const flow = b.children.filter((c) => c.css.base.position !== 'absolute');
      const wideKids = flow.filter((c) => N[c.id].box.w >= 200);
      const wide = wideKids.length;
      const small = n.box.h <= 100 && n.box.w <= 700;
      // Content blocks shrink proportionally, then the row wraps — a fill column (flex-basis 0) must
      // never be squeezed to nothing by a fixed-width sibling (e.g. a form), and no column may shrink
      // below what its content cannot shrink below (logos, one-line text, buttons). Line breaking uses
      // the flex-basis, so basis = max(half the design width, content minimum). grow = slack (design
      // width − basis): at the design width the free space is exactly Σ slack, so every item lands at
      // exactly its Figma size; narrower, items give up width in proportion to their slack.
      // Only for rows whose width comes from outside (fill/fixed) — a hug row is sized by its content.
      if (!small && wide >= 2 && !base['flex-wrap'] && n.sizing.w !== 'hug') {
        base['flex-wrap'] = 'wrap';
        base['row-gap'] = px(Math.max(16, Math.min(L?.gap || 0, 24)));
        // A row that may wrap can gain lines: a fixed design height becomes a minimum.
        if (base.height) (base['min-height'] = base.height), delete base.height;
        // A row with free space in the design (e.g. a right-aligned contact strip) must not let its
        // items grow into it — they keep their design size and only shrink toward their minimum.
        // (space-between: the spacing itself is free space; CSS distributes it, items must not eat it)
        const fillsRow = !L || n.box.w - L.padding[1] - L.padding[3] - flow.reduce((a, c) => a + N[c.id].box.w, 0) - (L.justify === 'space-between' ? 0 : Math.max(0, L.gap) * (flow.length - 1)) < 2;
        for (const c of wideKids) {
          const cw = N[c.id].box.w;
          const basis = Math.min(cw, Math.max(cw * 0.5, minContent(c.id)));
          c.css.base.flex = fillsRow ? `${round(cw - basis)} 1 ${px(round(basis))}` : `0 1 ${px(round(cw))}`;
          c.css.base['min-width'] = fillsRow ? '0' : px(round(basis));
          if (N[c.id].sizing.w === 'fixed') c.css.base['max-width'] = px(cw);
          // …but once its row has wrapped (narrow desktop) a block may take the whole line rather than
          // sit at its design width beside empty space.
          if (N[c.id].sizing.w === 'fixed') c.css.narrow['max-width'] = '100%';
          delete c.css.base.width;
        }
      }
      // Rows with slack in the design (e.g. a space-between nav) wrap when their content stops fitting;
      // with slack, nothing can wrap at the design width itself.
      const kidsW = flow.reduce((a, c) => a + N[c.id].box.w, 0);
      const slack = L ? n.box.w - L.padding[1] - L.padding[3] - kidsW - (L.justify === 'space-between' ? 0 : L.gap * Math.max(0, flow.length - 1)) : 0;
      if (!small && !base['flex-wrap'] && slack >= 2 && n.sizing.w !== 'hug') (base['flex-wrap'] = 'wrap'), (base['row-gap'] = px(Math.min(L.gap || 16, 24)));
      // Shrinkable content-sized blocks stop at their content minimum (links never overlap the button).
      for (const c of flow) if (c.css.base.flex === '0 1 auto') c.css.base['min-width'] = px(round(Math.min(N[c.id].box.w, minContent(c.id))));
      // Tablet: every row may wrap (fixed-size items must never run off the edge). A row sized by its
      // content (hug) must also be allowed to shrink to its parent, or it can never wrap; its
      // non-icon items may shrink too.
      T['flex-wrap'] = 'wrap';
      // Wrapped lines need breathing room even when the design's gap is 0 (single-line in Figma).
      T['row-gap'] = px(Math.max(16, Math.min(L?.gap || 0, 24)));
      // Desktop gaps (e.g. 154px between slider arrows) do not scale down by themselves.
      if (L?.gap > 32 && L.justify !== 'space-between') (T['column-gap'] = '32px'), (P['column-gap'] = '16px');
      T['max-width'] = P['max-width'] = '100%';
      T['min-width'] = P['min-width'] = '0';
      for (const c of flow) if (N[c.id].box.w >= 100) (c.css.tablet['min-width'] = '0'), (c.css.tablet['max-width'] = '100%');
      // Narrow desktop: one visual block (a picture or composition without text) beside one text block
      // stays side by side — the visual keeps its share of the row, the text takes the rest.
      if (!small && wide === 2 && wideKids.length === 2) {
        const vis = wideKids.find((c) => !hasText(ir, c.id) || N[c.id].a.role === 'image' || (layoutOf(N[c.id])?.gap < 0 && N[c.id].children.some((k) => ['image', 'svg'].includes(N[k].a.role))));
        const txt = wideKids.find((c) => c !== vis && hasText(ir, c.id));
        if (vis && txt) {
          NR['flex-wrap'] = 'nowrap';
          Object.assign(vis.css.narrow, { flex: `0 1 ${round((N[vis.id].box.w / (n.box.w - L.padding[1] - L.padding[3])) * 100, 3)}%`, 'min-width': '0', width: 'auto' });
          Object.assign(txt.css.narrow, { flex: '1 1 0', 'min-width': '0' });
        }
      }
      // An icon + its label never wrap apart: the label wraps inside instead (a bullet arrow left
      // alone on one line with its text on the next).
      const iconLabel = flow.length <= 3 && flow.filter((c) => N[c.id].text).length === 1 && flow.every((c) => N[c.id].text || (N[c.id].box.w <= 48 && N[c.id].box.h <= 48));
      if (iconLabel) {
        NR['flex-wrap'] = T['flex-wrap'] = P['flex-wrap'] = 'nowrap';
        for (const c of flow) if (N[c.id].text) for (const bp of ['narrow', 'tablet', 'phone']) Object.assign(c.css[bp], { flex: '0 1 auto', 'min-width': '0' });
      }
      // Narrow desktop: content blocks give up width instead of pushing out of a row that cannot grow
      // (e.g. a slider wider than the content column between its arrows).
      for (const c of flow) if (N[c.id].box.w >= 200 && !N[c.id].text) Object.assign(c.css.narrow, { 'flex-shrink': '1', 'min-width': '0' });
      // Rows of links/buttons (no block, or several blocks, e.g. links + a call button in a nav) wrap
      // instead of pushing their last item under a neighbour; large design gaps tighten first.
      if (wide !== 1 && !iconLabel && NR['flex-wrap'] !== 'nowrap') {
        Object.assign(NR, { 'flex-wrap': 'wrap', 'row-gap': T['row-gap'] || px(Math.max(16, Math.min(L?.gap || 0, 24))), 'min-width': '0' });
        if (L?.gap > 32 && L.justify !== 'space-between') NR['column-gap'] = '32px';
      }
      // A page-wide bar (logo … links + call button) moves its second item to its own line at a width
      // computed from the design, not when its content happens to overflow: that depends on the font,
      // and a web font arriving after first paint would re-wrap the bar and push the page down.
      if (L?.justify === 'space-between' && flow.length === 2 && n.box.w >= FW * 0.95 && root.narrowAt) {
        // Design width of an item with its nested hug rows' gaps tightened to 32px (the narrow tier's).
        const tight = (id) => {
          const m = N[id], ml = layoutOf(m);
          const kids = m.children.filter((k) => N[k].positioning !== 'absolute');
          if (!ml || ml.dir !== 'row' || m.sizing.w !== 'hug') return m.box.w;
          const save = ml.gap > 32 && ml.justify !== 'space-between' ? (ml.gap - 32) * (kids.length - 1) : 0;
          return m.box.w - save - kids.reduce((a, k) => a + (N[k].box.w - tight(k)), 0);
        };
        const at = Math.min(root.narrowAt, Math.round(tight(flow[0].id) + tight(flow[1].id) + 32 + L.padding[1] + L.padding[3]));
        if (at > BREAKPOINTS.tablet) {
          Object.assign(bucketAt(b, at), { 'flex-wrap': 'wrap', 'row-gap': px(Math.max(16, Math.min(L.gap || 0, 24))) });
          Object.assign(bucketAt(flow[1], at), { flex: '1 1 100%', 'max-width': '100%', 'min-width': '0' });
        }
      }
      if (!small && wide >= 3) {
        const lastWide = wideKids.length % 2 ? wideKids.at(-1) : null;
        for (const c of flow) if (N[c.id].box.w >= 200) c.css.tablet.flex = c === lastWide ? '1 1 100%' : '1 1 calc(50% - 32px)';
        T['align-items'] = 'stretch';
      }
      const tabletLine = BP.tablet.min - 2 * BP.tablet.gutter;
      const connectorT = (c) => N[c.id].box.w < 120 && N[c.id].box.h <= 4 && ['svg', 'divider', 'shape'].includes(N[c.id].a.role);
      // Steps wrapping two per line: connectors can no longer follow the sequence — hide them.
      if (!small && wide >= 3) for (const c of flow) if (connectorT(c)) c.css.tablet.display = 'none';
      // Narrow desktop: a row of 3+ equal blocks (stats, counters, steps) becomes the same two-up grid
      // at its own breakpoint — the page width below which the blocks would be squeezed under their
      // content minimum (clipped badges, cut digits) or leave one orphan on a second line.
      const wideW = wideKids.map((c) => N[c.id].box.w);
      if (!small && wide >= 3 && root.narrowAt && Math.max(...wideW) <= Math.min(...wideW) * 1.25) {
        const need = wideKids.reduce((a, c) => a + Math.max(minContent(c.id), 200), 0) + flow.filter((c) => N[c.id].box.w < 200).reduce((a, c) => a + N[c.id].box.w, 0) + (L?.gap || 0) * (flow.length - 1);
        // 3–4 column grids go two-up by the tablet-extra tier (1366–1024 rule) at the latest, earlier when
        // their content needs it; cards in a line share one height; an odd last card spans the line.
        const at = Math.max(LADDER.tabletExtra, Math.min(root.narrowAt, Math.round(need * (widestContent || FW) / n.box.w + 48)));
        if (at > BREAKPOINTS.tablet) {
          const cssAt = (x) => bucketAt(x, at);
          Object.assign(cssAt(b), { 'flex-wrap': 'wrap', 'row-gap': px(Math.max(24, Math.min(L?.gap || 0, 40))), 'column-gap': '32px', 'align-items': 'stretch' });
          const lastWide = wideKids.length % 2 ? wideKids.at(-1) : null;
          for (const c of flow) {
            if (N[c.id].box.w >= 200) Object.assign(cssAt(c), { flex: c === lastWide ? '1 1 100%' : '1 1 calc(50% - 32px)', 'min-width': '0', 'max-width': '100%' });
            else if (connectorT(c)) cssAt(c).display = 'none';
          }
          // Small decorative marks placed between the blocks (dots, ticks) lose their place in a grid.
          for (const c of b.children) if (c.decor && c.css.base.position === 'absolute' && N[c.id].box.w <= 24 && N[c.id].box.h <= 24) cssAt(c).display = c.css.tablet.display = 'none';
        }
      }
      // One block + small companions (arrows around a slider): stays a row on tablets when the block
      // keeps a readable width beside them.
      if (!small && wide === 1 && flow.reduce((a, c) => a + (N[c.id].box.w >= 200 ? Math.max(minPhone(c.id), 0.6 * tabletLine) : N[c.id].box.w), 0) + 24 * (flow.length - 1) <= tabletLine) {
        T['flex-wrap'] = 'nowrap';
        for (const c of flow) if (N[c.id].box.w >= 200) Object.assign(c.css.tablet, { flex: '1 1 0', 'min-width': '0' });
      }
      // Phone, decided by the row's structure:
      //  - two or more content blocks (cards, columns, steps) → stack them;
      //  - one content block + small items (icon + text, slider arrows) → stay a row, the block flexes;
      //  - only small items (links, buttons, badges) → wrap.
      const connector = (c) => N[c.id].box.w < 120 && N[c.id].box.h <= 4 && ['svg', 'divider', 'shape'].includes(N[c.id].a.role);
      if (!small && wide >= 2) {
        // Rows stack in reading order from the mobile-extra tier (≤880) down; with one picture and one
        // text block the text comes first, the picture after it.
        const vis = wide === 2 ? wideKids.find((c) => !hasText(ir, c.id)) : null;
        const txt = vis && wideKids.find((c) => c !== vis && hasText(ir, c.id));
        for (const bp of ['mobileExtra', 'phone']) {
          const css = (b.css[bp] ??= {});
          Object.assign(css, { 'flex-direction': 'column', 'align-items': 'stretch', gap: '24px' });
          for (const c of flow) {
            const cc = (c.css[bp] ??= {});
            if (N[c.id].box.w >= 200) Object.assign(cc, { flex: '0 0 auto', width: '100%', 'max-width': '100%', 'margin-left': '0' });
            // Horizontal connectors between stacked steps turn vertical and centre on the sequence.
            // (display: the tablet/narrow rules that hide connectors also match phone widths.)
            else if (connector(c)) Object.assign(cc, { display: 'block', flex: '0 0 auto', 'align-self': 'center', transform: 'rotate(90deg)', margin: `${px(round(N[c.id].box.w / 2 - 8))} 0` });
            else Object.assign(cc, { flex: '0 0 auto', 'align-self': 'center', 'margin-left': '0' });
          }
          if (txt) (txt.css[bp] ??= {}).order = '-1';
        }
      } else if (!small && wide === 1 && flow.reduce((a, c) => a + (N[c.id].box.w >= 200 && hasText(ir, c.id) ? Math.max(minPhone(c.id), 0.6 * (BP.phone.min - 2 * BP.phone.gutter)) : minPhone(c.id)), 0) + 16 * (flow.length - 1) <= BP.phone.min - 2 * BP.phone.gutter) {
        // (A text block counts with a readable width — 60% of the phone line — not its technical minimum.)
        // The block still fits beside its small companions (icon + text): keep the row.
        P['flex-wrap'] = 'nowrap';
        for (const c of flow) if (N[c.id].box.w >= 200) Object.assign(c.css.phone, { flex: '1 1 0', 'min-width': '0', width: 'auto', 'max-width': 'none' });
      } else {
        // Wrap. Items keep a real basis (their design width, at most the full line) so two form fields
        // or two buttons that cannot share a line each take their own. A block that cannot sit beside
        // its companions takes its own line; with controls on both sides (arrows around a slider) the
        // block comes first and the controls share the next line.
        P['flex-wrap'] = 'wrap';
        if (L?.gap) P['row-gap'] = px(Math.min(L.gap, 16));
        for (const c of flow) if (N[c.id].box.w >= 200) Object.assign(c.css.phone, { flex: wide === 1 ? '1 1 100%' : `1 1 min(${px(N[c.id].box.w)}, 100%)`, 'min-width': '0', 'max-width': '100%' });
        const wi = flow.findIndex((c) => N[c.id].box.w >= 200);
        if (wide === 1 && wi > 0 && wi < flow.length - 1 && flow.every((c, k) => k === wi || !hasText(ir, c.id))) {
          flow[wi].css.phone.order = '-1';
          P['justify-content'] = 'center';
        }
        // Small text items (two calls to action) that cannot share the narrowest phone line stack — one
        // column on phones, decided by the design, not by where a late web font happens to wrap them.
        const texty = flow.filter((c) => hasText(ir, c.id));
        if (!wide && !L?.wrap && !iconLabel && texty.length >= 2 && flow.reduce((a, c) => a + N[c.id].box.w, 0) + (L?.gap || 16) * (flow.length - 1) > BP.phone.min - 2 * BP.phone.gutter) Object.assign(P, { 'flex-direction': 'column', 'flex-wrap': 'nowrap', 'align-items': 'flex-start', gap: px(Math.min(Math.max(L?.gap || 16, 12), 20)) });
      }
      // (an icon + label pair stays one line whatever the phone rules above decided)
      if (iconLabel) NR['flex-wrap'] = T['flex-wrap'] = P['flex-wrap'] = 'nowrap';
      // A wrapped row that was right-aligned or spread on desktop reads ragged on a phone: its lines
      // start at the left edge (centred designs stay centred).
      if (!iconLabel && P['flex-wrap'] === 'wrap' && ['flex-end', 'space-between', 'space-around'].includes(base['justify-content']) && !P['justify-content']) P['justify-content'] = 'flex-start';
      // Wrapped/stacked rows grow: no fixed heights below desktop.
      if (base.height || base['min-height']) (T.height = P.height = 'auto'), (T['min-height'] = P['min-height'] = '0');
      // Narrow desktop: the design height becomes a minimum (the row may gain a line).
      if (base.height || base['min-height']) Object.assign(NR, { height: 'auto', 'min-height': base.height || base['min-height'] });
    }

    // ---- flex containers whose text can reflow: fixed heights relax below desktop (on narrow desktops
    // the design height stays as a minimum). Small fixed boxes (icon circles, badges, pills) keep their
    // exact size.
    if (base.display === 'flex' && !widget && b.kind !== 'page' && (base.height || base['min-height']) && hasText(ir, b.id) && n.box.w >= 200) {
      T.height = P.height = 'auto';
      T['min-height'] = P['min-height'] = '0';
      Object.assign(NR, { height: 'auto', 'min-height': base.height || base['min-height'] });
    }

    // ---- absolute compositions with content: a vertical flow where they cannot fit. Invisible
    // (opacity 0, hover-reveal) layers stay out of the flow.
    // Only compositions that carry text: purely decorative ones (curves, badges) keep their placement.
    // Flow order follows reading order (top to bottom, then left to right), not Figma layer order.
    // Small fixed items keep their size; content-free boxes (e.g. a clipped carousel) keep their height.
    const contentAbs = b.children.filter((c) => c.css.base.position === 'absolute' && !c.decor && !N[c.id].a.background && N[c.id].opacity > 0);
    if (!L && contentAbs.length >= 2 && b.kind !== 'page' && !widget && hasText(ir, b.id)) {
      const bps = n.box.w > 900 ? ['tablet', 'phone'] : n.box.w >= 500 ? ['phone'] : [];
      // Reading order: group items that share a visual line (vertical overlap of at least half the
      // smaller height), lines top to bottom, items in a line left to right.
      const lines = [];
      for (const c of [...contentAbs].sort((x, y) => N[x.id].box.y - N[y.id].box.y)) {
        const cb = N[c.id].box;
        const line = lines.find((l) => l.some((o) => {
          const ob = N[o.id].box;
          return Math.min(cb.y + cb.h, ob.y + ob.h) - Math.max(cb.y, ob.y) >= 0.5 * Math.min(cb.h, ob.h);
        }));
        if (line) line.push(c);
        else lines.push([c]);
      }
      const ordered = lines.flatMap((l) => l.sort((x, y) => N[x.id].box.x - N[y.id].box.x));
      // Narrow desktop: a fluid composition keeps its proportions — left-anchored items move with the
      // width and text boxes narrow with it, so a description no longer runs under the arrow beside it.
      if (n.sizing.w === 'fill' || n.box.w >= FW * 0.6) {
        for (const c of contentAbs) {
          const cb = c.css.base, cn = N[c.id];
          if (!/px$/.test(cb.left || '') || cb.right != null) continue;
          // Items near the start stay put (they sit beside start-anchored art, e.g. a big outlined number).
          const lx = parseFloat(cb.left);
          const moves = lx >= n.box.w * 0.25;
          if (moves) c.css.narrow.left = `${round((lx / n.box.w) * 100, 3)}%`;
          if (hasText(ir, c.id) && /px$/.test(cb.width || '')) {
            if (moves) c.css.narrow.width = `${round((cn.box.w / n.box.w) * 100, 3)}%`;
            else {
              // A start-anchored text keeps its width but ends before the next item on its line moves in.
              const next = contentAbs.filter((o) => o !== c && N[o.id].box.x - n.box.x >= n.box.w * 0.25 && N[o.id].box.x > cn.box.x && Math.min(N[o.id].box.y + N[o.id].box.h, cn.box.y + cn.box.h) > Math.max(N[o.id].box.y, cn.box.y));
              const nx = Math.min(...next.map((o) => N[o.id].box.x - n.box.x));
              // …but never narrower than its longest word (it may wrap between words, not inside one).
              const wordPx = cn.text ? round(longestWordEm(cn) * Math.max(...cn.text.runs.map((r) => r.size))) : 0;
              if (Number.isFinite(nx)) c.css.narrow.width = `min(${px(cn.box.w)}, max(${px(Math.min(wordPx, cn.box.w))}, calc(${round((nx / n.box.w) * 100, 3)}% - ${px(round(lx + 24))})))`;
            }
            if (cn.text) c.css.narrow.height = 'auto';
          }
        }
      }
      for (const bp of bps) {
        Object.assign(b.css[bp], { height: 'auto', 'min-height': '0', display: 'flex', 'flex-direction': 'column', 'align-items': 'flex-start', gap: '16px', padding: `24px ${BP[bp].gutter}px` });
        ordered.forEach((c, i) => {
          const cn = N[c.id];
          const css = { position: 'relative', left: 'auto', right: 'auto', top: 'auto', bottom: 'auto', order: String(i), flex: '0 0 auto' };
          // Keep the design's horizontal alignment: centred items stay centred, right items stay right.
          const mid = cn.box.x + cn.box.w / 2 - (n.box.x + n.box.w / 2);
          if (Math.abs(mid) <= n.box.w * 0.05) css['align-self'] = 'center';
          else if (cn.box.x - n.box.x > n.box.w * 0.6) css['align-self'] = 'flex-end';
          if (cn.box.w < 200 && !hasText(ir, c.id)) Object.assign(css, { width: px(cn.box.w), height: px(cn.box.h), 'flex-shrink': '0' });
          else if (!hasText(ir, c.id) || !cn.layout && cn.children.length) Object.assign(css, { width: '100%', 'max-width': '100%', height: px(round(Math.min(cn.box.h, bp === 'phone' ? cn.box.h * 0.6 : cn.box.h))) });
          else Object.assign(css, { width: 'auto', 'max-width': '100%', height: 'auto' });
          Object.assign(c.css[bp], css);
        });
      }
    }

    // ---- carousel strips: on tablet/phone one slide fills the slider (text slides) or most of it
    if (n.a.widget === 'carousel-strip') {
      const textSlides = b.children.some((c) => hasText(ir, c.id));
      // A slider showing one text slide at a time also fits its (narrower) container on narrow desktops;
      // otherwise the slide keeps its design width and is cut by the slider window.
      const single = textSlides && parent && b.children.every((c) => N[c.id].box.w >= N[parent.id].box.w * 0.9);
      for (const bp of single ? ['narrow', 'tablet', 'phone'] : ['tablet', 'phone']) {
        // Text slides are in flow so the slider grows with the (taller) phone layout; image strips stay
        // a clipped band.
        // The strip joins the flow and the slider sizes to it: text slides by their content, image
        // slides by their design aspect ratio (a 440×640 card stays a card, not a sliver).
        Object.assign(b.css[bp], { width: '100%', 'max-width': '100%', display: 'flex', 'flex-wrap': 'nowrap', position: 'relative', left: '0', top: '0', height: 'auto', 'align-items': 'flex-start' });
        if (parent) Object.assign(parent.css[bp], { height: 'auto', 'min-height': '0', width: '100%' });
        for (const c of b.children) {
          const cb = N[c.id].box;
          const basis = textSlides ? '100%' : `min(${px(cb.w)}, 85%)`;
          Object.assign(c.css[bp], { position: 'relative', left: 'auto', top: 'auto', flex: `0 0 ${basis}`, width: basis, 'max-width': 'none', height: 'auto', ...(textSlides ? {} : { 'aspect-ratio': `${round(cb.w)} / ${round(cb.h)}` }) });
        }
      }
    }

    // ---- items wider than their parent (hug overhang, e.g. slider + arrows): never wider than the page
    if (base['flex-shrink'] === '0' && base.width && inSection) base['max-width'] = 'calc(100cqw - 48px)';

    // ---- in-flow images keep their proportions when they shrink; so do stretched (left + right
    // anchored) layers such as full-width curves and masks — a 1920×322 band must not stay 322px tall
    // on a 390px screen.
    if (b.kind === 'image' || b.kind === 'svg') {
      const stretched = base.position === 'absolute' && base.left && base.right;
      if (b.w >= 300 && (base.position !== 'absolute' || stretched)) (T.height = 'auto'), (P.height = 'auto'), (T['aspect-ratio'] = P['aspect-ratio'] = `${round(b.w)} / ${round(b.h)}`);
    }

    // ---- a centred block inside a full-width parent without side padding (a 1440px container in a
    // bare section) keeps the page gutters once the page is narrower than the block.
    if (parent && base.position !== 'absolute' && !b.decor) {
      const pn = N[parent.id], pL = layoutOf(pn);
      const side = pL ? Math.min(pL.padding[1], pL.padding[3]) : 0;
      const centred = Math.abs(n.box.x + n.box.w / 2 - (pn.box.x + pn.box.w / 2)) <= 4;
      if (pL && pn.box.w >= FW * 0.95 && side < 24 && centred && n.box.w <= pn.box.w - 96 && n.box.w >= FW * 0.5) {
        NR['max-width'] = 'calc(100% - 48px)';
        T['max-width'] = `calc(100% - ${2 * BP.tablet.gutter}px)`;
        P['max-width'] = `calc(100% - ${2 * BP.phone.gutter}px)`;
        for (const bp of ['narrow', 'tablet', 'phone']) Object.assign(b.css[bp], { 'margin-left': 'auto', 'margin-right': 'auto', 'align-self': 'center' });
      }
    }

    // ---- a mark in the right part of a button (an arrow box) stays at the button's right edge when the
    // button changes width below the design (e.g. a full-width button on a phone).
    if (base.position === 'absolute' && parent?.kind === 'button' && /px$/.test(base.left || '') && base.right == null) {
      const pb = N[parent.id].box;
      if (n.box.x - pb.x >= pb.w * 0.6) {
        const r = round(pb.x + pb.w - n.box.x - n.box.w);
        Object.assign(b.css.narrow, { left: 'auto', right: px(r) });
        // Below desktop a full-width button reaches the gutter: the mark stays inside it, and the button
        // keeps room for it so it never covers the label.
        for (const bp of ['tablet', 'phone']) {
          Object.assign(b.css[bp], { left: 'auto', right: px(Math.max(0, r)) });
          const pad = (parent.css[bp].padding || parent.css.base.padding || '0px').split(' ').map((v) => parseFloat(v) || 0);
          const [t, rr, bb, l] = pad.length === 4 ? pad : pad.length === 2 ? [pad[0], pad[1], pad[0], pad[1]] : [pad[0], pad[0], pad[0], pad[0]];
          const need = round(n.box.w + Math.max(0, r) + 8);
          if (rr < need) parent.css[bp].padding = [t, need, bb, l].map(px).join(' ');
        }
      }
    }

    // ---- side art: a large decorative image placed beside the content of a laid-out container (it
    // overlaps no text there) joins the flow below that content on tablets and phones, instead of
    // painting over the text that now spans the full width.
    if (b.decor && b.kind === 'image' && base.position === 'absolute' && parent && layoutOf(N[parent.id]) && n.box.w >= 150 && n.box.h >= 150) {
      const texts = [];
      const collect = (id) => (N[id].text ? texts.push(N[id]) : N[id].children.forEach(collect));
      N[parent.id].children.filter((id) => id !== n.id).forEach(collect);
      const hit = (a, c) => a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h;
      if (!texts.some((t) => hit(t.box, n.box))) {
        // Narrow desktop: it stays beside the content, anchored to the content column's edge on its side
        // and scaled with the column (its reserved room in the parent's padding scales the same way).
        const pb = N[parent.id].box;
        if (widestContent && pb.w >= FW * 0.95) {
          const G = (FW - widestContent) / 2, col = widestContent;
          const right = n.box.x + n.box.w / 2 > pb.x + pb.w / 2;
          const inset = round(right ? pb.x + pb.w - G - (n.box.x + n.box.w) : n.box.x - (pb.x + G));
          Object.assign(NR, { [right ? 'left' : 'right']: 'auto', [right ? 'right' : 'left']: `calc(${gutterExpr(col)} + ${px(inset)})`, width: `min(${px(round(n.box.w))}, calc(min(${px(col)}, 100% - 48px) * ${round(n.box.w / col, 4)}))`, height: 'auto', 'aspect-ratio': `${round(n.box.w)} / ${round(n.box.h)}` });
        }
        for (const bp of ['tablet', 'phone']) {
          Object.assign(b.css[bp], { position: 'relative', left: 'auto', top: 'auto', right: 'auto', bottom: 'auto', transform: 'none', display: 'block', width: `min(${px(round(n.box.w))}, ${bp === 'phone' ? 80 : 55}%)`, height: 'auto', 'aspect-ratio': `${round(n.box.w)} / ${round(n.box.h)}`, 'align-self': 'center', order: '99', margin: '0 auto' });
        }
      }
    }

    // ---- decoration that mostly lies outside its parent (e.g. a car photo bleeding into the previous
    // section) cannot keep its relationship on narrow screens: it would cover other content. Drop it.
    // (Not when the parent clips it on purpose — e.g. a rolling-digit strip inside its window.)
    if (b.decor && parent && base.position === 'absolute' && ['image', 'svg', 'text'].includes(b.kind) && !N[parent.id].clips && !n.a.counter) {
      const pb = N[parent.id].box, cb = n.box;
      const inside = Math.max(0, Math.min(cb.x + cb.w, pb.x + pb.w) - Math.max(cb.x, pb.x)) * Math.max(0, Math.min(cb.y + cb.h, pb.y + pb.h) - Math.max(cb.y, pb.y));
      if (inside < 0.5 * cb.w * cb.h && cb.w * cb.h > 40000) {
        // In a section whose content is centred, it keeps its distance to that content on wider screens
        // (anchored to the centre, not the page edge, so it never slides under the content), and is
        // dropped as soon as the content column itself shrinks.
        if (/max\(var\(--f2d-gutter/.test(parent.css.base.padding || '') && /px$/.test(base.left || '') && base.right == null) base.left = `calc(50% + ${px(round(parseFloat(base.left) - pb.w / 2))})`;
        NR.display = T.display = P.display = 'none';
      }
    }

    // ---- an absolutely placed element straddling a sibling's top edge (e.g. a logo badge on a card)
    // needs that sibling's top padding to stay at least as deep as the overhang.
    // (Decoration counts too: a decorative badge sitting on a heading is just as broken.)
    // Only badge-like items (small, crossing the edge) — not large background art behind the content.
    for (const a of b.children.filter((c) => c.css.base.position === 'absolute' && !N[c.id].a.background && N[c.id].opacity > 0 && N[c.id].box.w <= 400 && N[c.id].box.h <= 300)) {
      const ab = N[a.id].box;
      for (const s of b.children.filter((c) => c.css.base.position !== 'absolute')) {
        const sn = N[s.id], sb = sn.box, sL = layoutOf(sn);
        if (!sL) continue;
        const overX = Math.min(ab.x + ab.w, sb.x + sb.w) - Math.max(ab.x, sb.x) > 0;
        if (overX && ab.y < sb.y + sL.padding[0] && ab.y + ab.h > sb.y) {
          // A badge that also pokes above its own parent would cover the previous section once that
          // section's bottom padding shrinks: below desktop it moves fully inside (top: 0) and the
          // sibling makes room for its whole height.
          const above = n.box.y - ab.y;
          let need = ab.y + ab.h - sb.y + 16;
          if (above > 0) {
            for (const bp of ['tablet', 'phone']) Object.assign(a.css[bp], { top: px(sb.y - n.box.y), bottom: 'auto' });
            need = ab.h + 16;
          }
          // Recorded now, applied when the sibling computes its own padding (it is walked after this).
          needTop.set(s.id, Math.max(needTop.get(s.id) || 0, round(need)));
        }
      }
    }

    // The page wrapper is the size container: cqw = page width (container units measure the content
    // box, and the page wrapper has no padding). Replaces vw, which overflows under Windows scrollbars.
    if (b.kind === 'page' || n.a.role === 'page') base['container-type'] = 'inline-size';
    for (const c of b.children) walk(c, b, inSection || b.section);

    // ---- final consistency pass for this box at each breakpoint:
    //  - a container that turns into a column must reset its children's flex sizes, because a desktop
    //    flex-basis is a width and would become a height (60px connectors → squares, `1 1 0` → collapse);
    //  - nothing in flow may be wider than its parent below desktop.
    for (const bp of ['tablet', 'phone']) {
      const css = b.css[bp];
      const becameColumn = css['flex-direction'] === 'column' && !(base['flex-direction'] || '').startsWith('column');
      if (becameColumn) for (const c of b.children) if (c.css.base.position !== 'absolute' || c.css[bp].position === 'relative') if (!c.css[bp].flex) c.css[bp].flex = '0 0 auto';
      // In a column, children that fill its height (flex: 1 1 0) collapse to nothing once that height is
      // no longer definite (relaxed, or no longer stretched by a row that stacked). Below desktop they
      // grow to fill when there is room but never shrink below their content.
      const colNow = (css['flex-direction'] || base['flex-direction'] || '').startsWith('column');
      if (colNow) for (const c of b.children) if (c.css.base.flex === '1 1 0' && !c.css[bp].flex) c.css[bp].flex = '1 0 auto';
      if (b.kind !== 'page' && !b.decor && base.position !== 'absolute' && !css['max-width'] && !n.a.widget) css['max-width'] = '100%';
    }
    if (b.kind !== 'page' && !b.decor && base.position !== 'absolute' && !base['max-width'] && !NR['max-width'] && !n.a.widget) NR['max-width'] = '100%';
    // (narrow desktops too: a heading that gains a line must not squeeze the text that fills below it)
    if ((NR['flex-direction'] || base['flex-direction'] || '').startsWith('column')) for (const c of b.children) if (c.css.base.flex === '1 1 0' && !c.css.narrow.flex) c.css.narrow.flex = '1 0 auto';
  };
  walk(root, null, false);
}

// ---------- interactive components (accordion, slider, marquee, nav menu) ----------
// Marks the boxes the analyzer recognised with runtime hook classes, inserts the menu button and
// derives state styles from the design itself. Behaviour comes from the bridge runtime
// (wp-plugin/f2d-bridge/assets/f2d-runtime.js); without it every component keeps the design's
// resting state.
function applyInteractive(root, ir, frame) {
  const N = ir.nodes;
  const all = [];
  const index = (b, parent) => (all.push({ b, parent }), b.children.forEach((c) => index(c, b)));
  index(root, null);
  const parentOf = new Map(all.map((x) => [x.b, x.parent]));
  const hook = (b, h) => (b.hooks ??= []).includes(h) || b.hooks.push(h);
  const byId = new Map(all.map((x) => [x.b.id, x]));
  const nodeOf = (b) => N[b.id];
  const STATE_KEYS = ['background', 'background-color', 'background-image', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'box-shadow', 'color', '--f2d-c', 'font-weight', 'opacity', 'padding'];

  for (const { b, parent } of all) {
    const n = nodeOf(b);
    if (!n) continue;
    const a = n.a;
    // ---- nav menu
    if (a.navLinks) hook(b, 'f2d-menu-links');
    if (a.menuPanel && parent) {
      hook(b, 'f2d-menu-panel');
      if (a.navLinks) hook(b, 'f2d-menu-links');
      // The bar's painted background (a full-size first vector) colours the open panel.
      const bg = b.children.find((c) => nodeOf(c)?.a.decor && nodeOf(c).fills?.[0]?.color);
      if (bg) hook(bg, 'f2d-menu-bg');
      const fill = bg ? nodeOf(bg).fills[0].color : n.fills?.find((f) => f.type === 'solid')?.color;
      if (fill) (b.rules ??= []).push({ bp: 'base', js: true, state: '.is-open', css: { 'background-color': fill } });
      // Compact header breakpoint: the widest page the header's rows need, each row = its items + gaps
      // (space-between at 32px) + the room an overlay (a hanging logo) takes in its band + gutters.
      let sec = b;
      while (sec && !sec.section) sec = parentOf.get(sec);
      const FW = frame.width, G = root.narrowAt ? (FW - (root.narrowAt + 1 - 48)) / 2 : 0;
      const overlay = parent.css.base.position === 'absolute' ? parent : null;
      const obstacles = overlay ? overlay.children.filter((c) => c.kind === 'image' && nodeOf(c)).map((c) => nodeOf(c).box) : [];
      let need = 0;
      const visit = (x) => {
        const xn = nodeOf(x), L = xn && layoutOf(xn);
        if (L?.dir === 'row') {
          const kids = xn.children.map((c) => N[c]).filter((k) => k.positioning !== 'absolute' && !k.a.decor);
          if (kids.length >= 2) {
            const w = kids.reduce((s2, k) => s2 + k.box.w, 0) + (L.justify === 'space-between' ? 32 : Math.max(0, L.gap)) * (kids.length - 1);
            const firstX = Math.min(...kids.map((k) => k.box.x));
            const band = xn.box;
            const reserve = Math.max(0, ...obstacles.filter((o) => o.x < firstX && o.y < band.y + band.h && o.y + o.h > band.y).map((o) => o.x + o.w - G + 32));
            need = Math.max(need, reserve + w + 48);
          }
        }
        x.children.forEach(visit);
      };
      if (sec) visit(sec);
      // …snapped to the ladder tier covering that width (the menu switches at the tier edge).
      const needAt = Math.max(BREAKPOINTS.tablet, Math.min(root.narrowAt || FW - 1, Math.round(need)));
      const tier = tierOf(needAt, root.narrowAt);
      const menuAt = tier === 'narrow' ? root.narrowAt : tier === 'tabletExtra' ? LADDER.tabletExtra : BREAKPOINTS.tablet;
      root.menuAt = menuAt;
      root.menuNeed = Math.round(need);
      const compact = (x) => (x.css[tier] ??= {});
      const firstText = (x) => (x.kind === 'text' ? x : x.children.map(firstText).find(Boolean));
      const linkText = firstText(all.find((x) => nodeOf(x.b)?.a.navLinks)?.b || b);
      const color = linkText?.css.base['--f2d-c'] || linkText?.css.base.color || 'currentColor';
      // The button wears the bar's own colours (light bars on the dark nav bar), so it reads on any
      // header background; it sits at the end of the header row.
      const toggle = {
        id: `${b.id}#menu-toggle`, cls: `${b.cls}-mt`, name: 'Menu button', kind: 'control', tag: 'button', synthetic: true, children: [],
        hooks: ['f2d-menu-toggle'], html: '<span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span><span class="f2d-sr">Menu</span>',
        css: { base: { display: 'none' }, narrow: {}, tablet: {}, phone: {} },
      };
      Object.assign(compact(toggle), { display: 'flex', position: 'relative', flex: '0 0 48px', 'margin-left': 'auto', 'z-index': '61', color, ...(fill ? { 'background-color': fill } : {}) });
      parent.children.splice(parent.children.indexOf(b), 0, toggle);
      hook(parent, 'f2d-menu-host');
      // A sticky header stays slim when compact: its other bars (a contact strip above the menu row)
      // move into the drawer, shown only while it is open, and the open header scrolls inside the
      // viewport. Without the runtime they stay where the design has them.
      if (sec?.header) {
        hook(sec, 'f2d-header');
        Object.assign(compact(sec), { height: 'auto', 'min-height': '0' });
        const holds = (x, y) => x === y || x.children.some((c) => holds(c, y));
        for (const c of sec.children) if (!holds(c, b) && !c.decor && N[c.id] && hasText(ir, c.id)) hook(c, 'f2d-menu-extra');
      }
      // A header overlay (logo + bar placed over the banner) becomes the top row on small screens:
      // logo left, menu button right, the open panel dropping below it; the contact strip follows.
      // The logo is sized by height so the bar stays slim (≤ ~20% of a 390px-tall landscape screen).
      if (parent.css.base.position === 'absolute') {
        for (const [bp, gutter, logoH] of [['compact', 32, 64], ['phone', 20, 56]]) {
          const css = (x) => (bp === 'compact' ? compact(x) : x.css[bp]);
          Object.assign(css(parent), { position: 'relative', left: 'auto', top: 'auto', right: 'auto', bottom: 'auto', width: '100%', 'max-width': '100%', height: 'auto', 'min-height': '0', order: '-1', display: 'flex', 'flex-direction': 'row', 'flex-wrap': 'nowrap', 'align-items': 'center', gap: '16px', padding: `8px ${gutter}px`, '--f2d-drawer-gutter': `${gutter}px` });
          for (const c of parent.children) {
            const cn = nodeOf(c);
            if (c.kind === 'image' && cn) Object.assign(css(c), { width: px(round(Math.min(cn.box.w, (logoH * cn.box.w) / cn.box.h))), height: 'auto', 'aspect-ratio': `${round(cn.box.w)} / ${round(cn.box.h)}`, flex: '0 0 auto', position: 'relative', left: 'auto', top: 'auto', margin: '0' });
          }
        }
      }
    }
    // ---- accordion
    if (a.widget === 'accordion') {
      hook(b, 'f2d-acc');
      const items = b.children.filter((c) => nodeOf(c)?.a.accItem);
      const ref = items.find((c) => nodeOf(c).a.accItem === 'closed');
      for (const it of items) {
        hook(it, 'f2d-acc-item');
        const head = it.children.find((c) => nodeOf(c)?.a.accHead);
        if (head) hook(head, 'f2d-acc-head');
        for (const c of it.children) if (nodeOf(c)?.a.accPanel) hook(c, 'f2d-acc-panel');
        if (nodeOf(it).a.accItem !== 'open' || !ref || !head) continue;
        hook(it, 'is-open'); // the design's state is in the markup: nothing moves when the runtime starts
        // Closed look of an open item = the design's closed item, part by part.
        const diff = (x, y) => Object.fromEntries(STATE_KEYS.filter((k) => (y.css.base[k] ?? null) !== (x.css.base[k] ?? null)).map((k) => [k, y.css.base[k] ?? (k.startsWith('background') ? 'transparent' : k === 'box-shadow' || k.startsWith('border') ? 'none' : 'initial')]));
        const refHead = ref.children.find((c) => nodeOf(c)?.a.accHead);
        const pairs = [[it, ref], [head, refHead]];
        if (refHead) {
          const texts = (x) => x.children.filter((c) => c.kind === 'text');
          texts(head).forEach((t, i) => texts(refHead)[i] && pairs.push([t, texts(refHead)[i]]));
        }
        for (const [x, y] of pairs) {
          if (!y) continue;
          const css = diff(x, y);
          if (Object.keys(css).length) (x.rules ??= []).push({ js: true, ancestor: x === it ? null : it, state: ':not(.is-open)', css });
        }
        // Icon swap: the open item shows its own icon when open and the closed item's icon when closed.
        const ownIcon = head.children.find((c) => nodeOf(c)?.a.accIcon);
        const refIcon = refHead?.children.find((c) => nodeOf(c)?.a.accIcon);
        if (ownIcon && refIcon) {
          hook(ownIcon, 'f2d-acc-icon-open');
          const clone = { ...structuredClone({ ...refIcon, children: [] }), children: refIcon.children, hooks: ['f2d-acc-icon-closed'], synthetic: true, ariaHidden: true };
          head.children.splice(head.children.indexOf(ownIcon) + 1, 0, clone);
        }
      }
    }
    // ---- slider
    if (a.widget === 'slider') {
      hook(b, 'f2d-slider');
      const ctl = b.children.filter((c) => nodeOf(c)?.a.sliderControl);
      const h = Math.max(0, ...ctl.map((c) => nodeOf(c).box.h));
      b.children.filter((c) => nodeOf(c)?.a.slide).forEach((c, i) => (hook(c, 'f2d-slide'), i === 0 && hook(c, 'is-active')));
      for (const c of ctl) {
        const prev = nodeOf(c).a.sliderControl === 'prev';
        hook(c, prev ? 'f2d-slider-prev' : 'f2d-slider-next');
        // Below desktop one card shows at a time; the controls sit centred under it.
        const w = nodeOf(c).box.w;
        Object.assign(c.css.tablet, { display: 'block', top: 'auto', bottom: '0', left: prev ? `calc(50% - ${px(round(w + 12))})` : 'calc(50% + 12px)', right: 'auto', transform: 'none' });
        // Narrow desktop: every card is visible (nothing to page) and controls that overhang the cards
        // would sit in a gutter too narrow for them — hidden until the slider pages again (tablet).
        const sb = nodeOf(b).box, cb = nodeOf(c).box;
        if (cb.x < sb.x || cb.x + cb.w > sb.x + sb.w) c.css.narrow.display = 'none';
      }
      if (h) Object.assign(b.css.tablet, { position: 'relative', 'padding-bottom': px(round(h + 24)) });
    }
    // ---- marquee: one clipped row at every width; text boxes size to their words
    if (a.widget === 'marquee') {
      hook(b, 'f2d-marquee');
      for (const c of b.children) (c.css.base['flex-shrink'] = '0'), (c.css.narrow['flex-shrink'] = '0'); // items keep their size
      const walkM = (x) => {
        if (x.kind === 'text') for (const bp of ['tablet', 'phone']) Object.assign(x.css[bp], { width: 'auto', 'max-width': 'none', 'white-space': 'nowrap' });
        x.children.forEach(walkM);
      };
      b.children.forEach((c) => (Object.assign(c.css.tablet, { flex: '0 0 auto', 'max-width': 'none', width: 'auto' }), walkM(c)));
      Object.assign(b.css.tablet, { 'flex-wrap': 'nowrap', overflow: 'hidden' });
      Object.assign(b.css.phone, { 'flex-wrap': 'nowrap', 'flex-direction': 'row' });
    }
  }
  return byId;
}

// ---------- page-wide UX rules on top of the design (the DEV Connect "pixel-perfect, then good UX" set)
//  - 4K containment: above the design width (never below 1920) backgrounds stay full-bleed while content
//    keeps the column it has at that width, centred; nothing stretches and no section grows taller;
//  - every button has a hover/focus state (derived from its own colour when the design has none);
//  - tap targets on phones are at least 44×44.
function applyFinish(root, ir, frame) {
  const N = ir.nodes;
  const FW = frame.width;
  const cap = Math.max(FW, 1920);
  root.wideAt = cap;
  const shift = (v) => `calc(50% - ${px(cap / 2)} + ${v})`;
  const isPx = (v) => typeof v === 'string' && /^-?[\d.]+px$/.test(v);
  const full = (x) => !!N[x.id] && N[x.id].box.w >= FW * 0.95 && !x.decor;
  const edge = (x) => N[x.id].box.x <= 1 || N[x.id].box.x + N[x.id].box.w >= FW - 1;
  // Split sections (a picture half bleeding to one screen edge, text aligned to the column): the bleed
  // keeps touching its edge and grows by the extra margin, everything placed on it follows the centred
  // column. The extra is measured on the page (the root is the size container: 100cqw = page width).
  const D = `(50cqw - ${px(cap / 2)})`;
  const split = (b, L) => {
    const [, r, , l] = L.padding;
    const flow = b.children.filter((c) => N[c.id] && c.css.base.position !== 'absolute');
    // A row has a half at each end; in a column every block may bleed to the side.
    const halves = L.dir === 'row' ? [['left', l, flow[0]], ['right', r, flow.at(-1)]] : flow.flatMap((c) => [['left', l, c], ['right', r, c]]);
    for (const [side, pad, half] of halves) {
      if (!half || pad >= 60 || full(half)) continue;
      const hb = N[half.id].box;
      if (side === 'left' ? hb.x > 1 : hb.x + hb.w < FW - 1) continue;
      const hL = layoutOf(N[half.id]);
      const own = hL ? (side === 'left' ? hL.padding[3] : hL.padding[1]) : 0;
      half.css.wide[`padding-${side}`] = `calc(${px(own)} + ${D})`;
      for (const c of half.children.filter((k) => N[k.id])) {
        const cb = c.css.base, kb = N[c.id].box;
        // (decoration — a background panel spanning the half — keeps spanning it)
        if (cb.position === 'absolute') {
          if (!c.decor && isPx(cb[side])) c.css.wide[side] = `calc(${cb[side]} + ${D})`;
          continue;
        }
        // The painted block on the edge (a colour band, a photo) reaches back to the screen edge;
        // content on the edge (a card strip) stays in the column.
        if ((side === 'left' ? kb.x <= 1 : kb.x + kb.w >= FW - 1) && !hasText(ir, c.id)) {
          const w0 = isPx(cb.width) ? cb.width : px(kb.w);
          Object.assign(c.css.wide, { [`margin-${side}`]: `calc(-1 * ${D})`, width: `calc(${w0} + ${D})`, flex: `0 0 calc(${w0} + ${D})`, 'max-width': 'none' });
        }
      }
    }
  };
  const contain = (b) => {
    const n = N[b.id];
    if (n.a.widget === 'marquee') return; // a ticker band runs edge to edge
    const kids = b.children.filter((c) => N[c.id]);
    // Placed children (no auto-layout, or absolute) keep their offset from the centred column;
    // decoration touching the page edge (side art) stays on the edge.
    for (const c of kids) {
      const cb = c.css.base;
      if (cb.position !== 'absolute' || full(c) || (c.decor && edge(c))) continue;
      if (isPx(cb.left)) c.css.wide.left = shift(cb.left);
      else if (isPx(cb.right)) c.css.wide.right = shift(cb.right);
    }
    // A full-bleed full-size image keeps its desktop height (cropped, never taller).
    for (const c of kids) if (full(c) && c.kind === 'image' && !isPx(c.css.base.height)) Object.assign(c.css.wide, { height: px(N[c.id].box.h), 'object-fit': 'cover', 'aspect-ratio': 'auto' });
    const fullKids = kids.filter(full);
    if (fullKids.some((c) => c.css.base.position !== 'absolute')) return fullKids.forEach(contain);
    fullKids.forEach(contain);
    // Content level: the box that carries the background pads its content into the column (fluid
    // section gutters already centre their content column and stay as they are).
    const L = layoutOf(n);
    if (L) split(b, L);
    if (!L || String(b.css.base.padding || '').includes('%')) return;
    const [t, r, bb, l] = L.padding;
    b.css.wide.padding = `${px(t)} ${shift(px(r))} ${px(bb)} ${shift(px(l))}`;
  };
  for (const s of root.children) if (full(s)) contain(s);

  const walk = (b) => {
    const n = N[b.id];
    // A portrait photo stretched to the full line below desktop would be taller than the screen (a
    // landscape phone sees nothing else): at most 80% of the screen's height, cropped (cover).
    if (b.kind === 'image' && n && n.box.h > n.box.w * 1.1) for (const bp of ['tablet', 'phone']) if (b.css[bp]?.['aspect-ratio'] && b.css[bp].width === '100%') Object.assign(b.css[bp], { 'max-height': '80vh' });
    if (b.kind === 'text' && b.html?.includes('f2d-lb')) (b.rules ??= []).push({ bp: root.narrowAt ? 'narrow' : 'tabletExtra', state: ' .f2d-lb', css: { display: 'none' } });
    if (b.kind === 'button' && n) {
      // Derived hover/focus: a little lighter on dark buttons, a little darker on light ones.
      if (!b.hover) {
        const c = (n.fills || []).find((f) => f.type === 'solid')?.color;
        const rgb = c && (c.startsWith('#') ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number));
        const lum = rgb ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 : 1;
        b.hover = [{ target: b.cls, css: { filter: `brightness(${lum < 0.35 ? 1.18 : 0.9})` } }];
        b.css.base.transition = 'filter 200ms';
        b.derivedHover = true;
      }
      Object.assign(b.css.phone, { 'min-height': '44px', 'min-width': b.css.phone['min-width'] === 'max-content' ? 'max-content' : '44px' }); // (a padded label is wider than 44px)
    }
    // (a drawn control smaller than that would be stretched: QA reports it instead)
    if ((n?.a.sliderControl && !(['image', 'svg'].includes(b.kind) && Math.min(n.box.w, n.box.h) < 44)) || n?.a.accHead) Object.assign(b.css.phone, { 'min-height': '44px', 'min-width': '44px' });
    // Whole-text links: the anchor itself is the hit area.
    if (b.kind === 'text' && n?.text && n.text.runs.length && n.text.runs.every((r) => r.href)) (b.rules ??= []).push({ bp: 'phone', state: ' a', css: { display: 'inline-flex', 'align-items': 'center', 'min-height': '44px', 'min-width': '44px' } });
    b.children.forEach(walk);
  };
  walk(root);
}

// Global CSS for the runtime components; `p` is the compiler's scope prefix (Divi: the specificity
// prefix, preview: ''). Hooks are doubled where they must beat a box's own layout rule.
export function runtimeCss(p = '', menuAt = BREAKPOINTS.tablet) {
  const s = p ? `${p} ` : '';
  return [
    `${s}.f2d-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }`,
    `${s}.f2d-menu-toggle.f2d-menu-toggle { flex-direction: column; align-items: center; justify-content: center; gap: 5px; width: 48px; height: 48px; padding: 0; border: 0; background: transparent; cursor: pointer; }`,
    `${s}.f2d-menu-toggle > span[aria-hidden] { display: block; width: 26px; height: 2px; background: currentColor; transition: transform .2s, opacity .2s; }`,
    `${s}.f2d-menu-toggle[aria-expanded="true"] > span:nth-child(1) { transform: translateY(7px) rotate(45deg); }`,
    `${s}.f2d-menu-toggle[aria-expanded="true"] > span:nth-child(2) { opacity: 0; }`,
    `${s}.f2d-menu-toggle[aria-expanded="true"] > span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }`,
    `html:not(.f2d-js) ${s}.f2d-menu-toggle.f2d-menu-toggle { display: none; }`,
    `@media (max-width: ${menuAt}px) {`,
    `  html.f2d-js ${s}.f2d-menu-panel.f2d-menu-panel { display: none; }`,
    // The open drawer drops into the header's flow under the menu row; while it is open the header
    // scrolls inside the viewport, so a long drawer stays reachable in landscape.
    `  html.f2d-js ${s}.f2d-menu-panel.f2d-menu-panel.is-open { display: flex; flex-direction: column; align-items: stretch; flex-wrap: nowrap; position: static; order: 99; flex: 1 1 100%; width: auto; height: auto; min-height: 0; max-width: none; margin: 0 calc(-1 * var(--f2d-drawer-gutter, 0px)); padding: 12px var(--f2d-drawer-gutter, 0px) 24px; gap: 16px; overflow: visible; }`,
    `  html.f2d-menu-open ${s}.f2d-menu-host.f2d-menu-host { flex-wrap: wrap; height: auto; min-height: 0; }`,
    `  html.f2d-js:not(.f2d-menu-open) ${s}.f2d-menu-extra.f2d-menu-extra { display: none; }`,
    `  html.f2d-menu-open ${s}.f2d-header.f2d-header { max-height: calc(100vh - var(--wp-admin--admin-bar--height, 0px)); max-height: calc(100dvh - var(--wp-admin--admin-bar--height, 0px)); overflow-y: auto; overscroll-behavior: contain; }`,
    `  html.f2d-js ${s}.f2d-menu-panel.is-open .f2d-menu-links.f2d-menu-links { flex-direction: column; align-items: stretch; flex-wrap: nowrap; gap: 0; width: auto; height: auto; }`,
    `  html.f2d-js ${s}.f2d-menu-panel.is-open .f2d-menu-links.f2d-menu-links > * { height: auto; min-height: 48px; justify-content: flex-start; flex: 0 0 auto; padding-left: 0; padding-right: 0; }`,
    // Drawer parts size to their content (a desktop flex-basis would become their height); the
    // call-to-action keeps its own width, so a drawn button shape is not stretched.
    `  html.f2d-js ${s}.f2d-menu-panel.f2d-menu-panel.is-open > * { flex: 0 0 auto; height: auto; }`,
    `  html.f2d-js ${s}.f2d-menu-panel.f2d-menu-panel.is-open > :not(.f2d-menu-links) { align-self: flex-start; }`,
    `  html.f2d-js ${s}.f2d-menu-panel.is-open .f2d-menu-bg.f2d-menu-bg { display: none; }`,
    `}`,
    `@media (max-width: ${BREAKPOINTS.tablet}px) {`,
    `  html:not(.f2d-js) ${s}.f2d-slider-prev.f2d-slider-prev, html:not(.f2d-js) ${s}.f2d-slider-next.f2d-slider-next { display: none; }`,
    `}`,
    `html.f2d-js ${s}.f2d-acc-head { cursor: pointer; }`,
    `html.f2d-js ${s}.f2d-acc-item:not(.is-open) .f2d-acc-panel.f2d-acc-panel { display: none; }`,
    `html:not(.f2d-js) ${s}.f2d-acc-icon-closed.f2d-acc-icon-closed, ${s}.f2d-acc-item.is-open .f2d-acc-icon-closed.f2d-acc-icon-closed { display: none; }`,
    `html.f2d-js ${s}.f2d-acc-item:not(.is-open) .f2d-acc-icon-open.f2d-acc-icon-open { display: none; }`,
    `@media (max-width: ${BREAKPOINTS.tablet}px) { html.f2d-js ${s}.f2d-slider .f2d-slide.f2d-slide:not(.is-active) { display: none; } }`,
    `${s}.f2d-slider-prev.f2d-slider-prev, ${s}.f2d-slider-next.f2d-slider-next { cursor: pointer; pointer-events: auto; z-index: 3; }`,
    `${s}.f2d-slider.is-paged [aria-disabled="true"] { opacity: .35; cursor: default; }`,
    `${s}.f2d-marquee-track { display: flex; flex-wrap: nowrap; align-items: inherit; width: max-content; animation: f2d-marquee var(--f2d-marquee-dur, 60s) linear infinite; }`,
    `${s}.f2d-marquee:hover .f2d-marquee-track, ${s}.f2d-marquee:focus-within .f2d-marquee-track { animation-play-state: paused; }`,
    `@keyframes f2d-marquee { to { transform: translateX(-50%); } }`,
    `@media (prefers-reduced-motion: reduce) { ${s}.f2d-marquee-track { animation: none; } }`,
  ].join('\n');
}

// ---------- CSS serialisation ----------
const decl = (css) =>
  Object.entries(css)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ');

export function boxCss(root, { scope = '', selector = (b) => `.${b.cls}` } = {}) {
  // Tiers of the ladder, widest first (later tiers override): wide = above the design width (4K
  // containment), narrow = laptop, then Divi's tablet / phone with the extra tiers between them.
  const TIERS = ['base', 'wide', 'narrow', 'tabletExtra', 'tablet', 'mobileExtra', 'phone'];
  const out = Object.fromEntries(TIERS.map((k) => [k, []]));
  const at = new Map(); // legacy per-box breakpoints (repairs may still use them) → rules
  const walk = (b) => {
    // State rules: only while the runtime is active (html.f2d-js) and/or under an ancestor's state,
    // e.g. a closed accordion item's look: html.f2d-js <scope><item>:not(.is-open) <this box>.
    for (const r of b.rules || []) {
      const d = decl(r.css);
      if (!d) continue;
      const self = `${scope}${r.ancestor ? `${selector(r.ancestor)}${r.state || ''} ${selector(b)}` : `${selector(b)}${r.state || ''}`}`;
      out[r.bp || 'base'].push(`${r.js ? 'html.f2d-js ' : ''}${self} { ${d} }`);
    }
    for (const k of TIERS) {
      const d = b.css[k] && decl(b.css[k]);
      if (d) out[k].push(`${scope}${selector(b)} { ${d} }`);
    }
    for (const [w, css] of Object.entries(b.css.at || {})) {
      const d = decl(css);
      if (d) at.set(+w, [...(at.get(+w) || []), `${scope}${selector(b)} { ${d} }`]);
    }
    for (const h of b.hover || []) {
      const self = h.target === b.cls;
      const t = self ? '' : ' ' + selector({ cls: h.target });
      out.base.push(`${scope}${selector(b)}:hover${t}, ${scope}${selector(b)}:focus-visible${t} { ${decl(h.css)} }`);
      if (!self) out.base.push(`${scope}${selector({ cls: h.target })} { transition: ${b.css.base.transition}; }`);
    }
    b.children.forEach(walk);
  };
  walk(root);
  const block = (q, rules) => (rules.length ? `@media (${q}) {\n${rules.join('\n')}\n}` : '');
  return [
    out.base.join('\n'),
    root.wideAt ? block(`min-width: ${root.wideAt + 1}px`, out.wide) : '',
    root.narrowAt ? block(`max-width: ${root.narrowAt}px`, out.narrow) : '',
    ...[...at.keys()].sort((a, b) => b - a).map((w) => block(`max-width: ${w}px`, at.get(w))),
    block(`max-width: ${LADDER.tabletExtra}px`, out.tabletExtra),
    `@media (max-width: ${BREAKPOINTS.tablet}px) {\n${out.tablet.join('\n')}\n}`,
    block(`max-width: ${LADDER.mobileExtra}px`, out.mobileExtra),
    `@media (max-width: ${BREAKPOINTS.phone}px) {\n${out.phone.join('\n')}\n}`,
  ].filter(Boolean).join('\n');
}

// Lint generated CSS for target-OS hazards (Windows classic scrollbars make vw overflow).
export function lintCss(cssText, { os }) {
  const findings = [];
  const re = /([\w-]+)\s*:\s*[^;]*\b\d*\.?\d+vw\b/g;
  let m;
  while ((m = re.exec(cssText))) {
    if (/^(width|min-width|max-width|left|right|margin-left|margin-right|padding-left|padding-right)$/.test(m[1])) findings.push({ code: 'VW_WIDTH', severity: os === 'macos' ? 'minor' : 'major', snippet: m[0].slice(0, 80) });
  }
  return findings;
}
