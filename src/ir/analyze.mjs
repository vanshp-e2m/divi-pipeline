// Design analysis (deterministic half of "Agent A"): roles, sections, decorations, inferred layout,
// heading levels, interaction widgets. Writes results onto IR nodes under `a` (analysis) so the
// original Figma values stay untouched next to the derived ones.
import { median, round } from '../util/core.mjs';

const isContainerType = (t) => ['frame', 'instance', 'component', 'group', 'section'].includes(t);
const area = (b) => b.w * b.h;
const overlapY = (a, b) => Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const overlapX = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
const contains = (o, i, tol = 1) => i.x >= o.x - tol && i.y >= o.y - tol && i.x + i.w <= o.x + o.w + tol && i.y + i.h <= o.y + o.h + tol;

// An interactive node with a hover state is not flattened into one exported asset when it can be
// rebuilt from its own fill + child assets: a baked SVG cannot change colour on hover.
export function keepLive(ir, n) {
  if (!n.states?.hover || !n.children.length) return false;
  if (!n.fills.every((f) => f.type === 'solid' || f.type === 'gradient')) return false;
  return n.children.every((c) => ir.nodes[c]?.asset && ir.assets[ir.nodes[c].asset]);
}

export function hasText(ir, id) {
  const n = ir.nodes[id];
  if (n.text) return true;
  return n.children.some((c) => hasText(ir, c));
}

function visualStyle(n) {
  const fills = n.fills.filter((f) => (f.opacity ?? 1) > 0 && !(f.type === 'solid' && /rgba\([^)]*,\s*0\)$/.test(f.color || '')));
  return {
    fill: fills.length > 0,
    stroke: !!(n.stroke && (n.stroke.weight || 0) > 0),
    radius: !!(n.radius && n.radius.some((r) => r > 0)),
    effects: n.effects.length > 0,
    padding: !!(n.layout && n.layout.padding.some((p) => p > 0)),
    opacity: n.opacity < 1,
    clips: n.clips,
  };
}
export const hasOwnStyle = (n) => {
  const s = visualStyle(n);
  return s.fill || s.stroke || s.radius || s.effects || s.opacity;
};

// Infer a flex layout for a container that has none (absolute children in Figma).
export function inferLayout(ir, n) {
  // Children clipped away entirely by this container (e.g. hover-animation copies parked off-canvas)
  // are not part of its visible arrangement.
  const visibleIn = (c) => !n.clips || (c.box.x < n.box.x + n.box.w && c.box.x + c.box.w > n.box.x && c.box.y < n.box.y + n.box.h && c.box.y + c.box.h > n.box.y);
  // …unless they continue a single row of items running past the clip edge (a ticker / strip): then
  // every item belongs to the row.
  const all = n.children.map((c) => ir.nodes[c]).filter((c) => c.positioning !== 'absolute');
  const sortedX = [...all].sort((a, b) => a.box.x - b.box.x);
  const strip = n.clips && all.length >= 3 && all.some((c) => !visibleIn(c)) && Math.max(...all.map((k) => k.box.y)) - Math.min(...all.map((k) => k.box.y)) <= 4 && sortedX.every((k, i) => i === 0 || k.box.x >= sortedX[i - 1].box.x + sortedX[i - 1].box.w - 1);
  let kids = strip ? all : all.filter(visibleIn);
  // A first-painted, text-free child covering the container is its background, not a flow item.
  if (kids[0] && kids[0].id === n.children[0] && !kids[0].children.length && !kids[0].text && area(kids[0].box) >= 0.9 * area(n.box)) kids = kids.slice(1);
  if (kids.length < 2) return null;
  const decor = new Set();
  // Hairlines spanning (almost) the full width at an edge are borders, not flow items.
  for (const k of kids) {
    if ((k.type === 'line' || k.box.h <= 2) && k.box.w >= n.box.w * 0.9) decor.add(k.id);
  }
  const flow = kids.filter((k) => !decor.has(k.id));
  if (flow.length < 2) return null;
  const byX = [...flow].sort((a, b) => a.box.x - b.box.x);
  const byY = [...flow].sort((a, b) => a.box.y - b.box.y);
  const disjoint = (arr, axis) => arr.every((k, i) => i === 0 || (axis === 'x' ? k.box.x >= arr[i - 1].box.x + arr[i - 1].box.w - 1 : k.box.y >= arr[i - 1].box.y + arr[i - 1].box.h - 1));
  const pad = (items) => {
    const minX = Math.min(...items.map((k) => k.box.x)), maxX = Math.max(...items.map((k) => k.box.x + k.box.w));
    const minY = Math.min(...items.map((k) => k.box.y)), maxY = Math.max(...items.map((k) => k.box.y + k.box.h));
    return [minY - n.box.y, n.box.x + n.box.w - maxX, n.box.y + n.box.h - maxY, minX - n.box.x].map((v) => round(Math.max(0, v)));
  };
  if (disjoint(byX, 'x')) {
    const gaps = byX.slice(1).map((k, i) => k.box.x - (byX[i].box.x + byX[i].box.w));
    const centers = flow.map((k) => k.box.y + k.box.h / 2);
    const tops = flow.map((k) => k.box.y);
    const spread = (a) => Math.max(...a) - Math.min(...a);
    const align = spread(centers) <= 4 ? 'center' : spread(tops) <= 4 ? 'start' : 'center';
    const uniformGap = spread(gaps) <= 4;
    return {
      dir: 'row', wrap: false, gap: uniformGap ? round(median(gaps)) : 0, gaps: uniformGap ? null : gaps.map((g) => round(g)),
      counterGap: 0, padding: pad(flow), justify: 'start', align, reverse: false, order: byX.map((k) => k.id), decor: [...decor],
      inferred: true, confidence: align === 'center' && spread(centers) <= 4 ? 0.85 : 0.6,
    };
  }
  if (disjoint(byY, 'y')) {
    const gaps = byY.slice(1).map((k, i) => k.box.y - (byY[i].box.y + byY[i].box.h));
    const lefts = flow.map((k) => k.box.x), centers = flow.map((k) => k.box.x + k.box.w / 2);
    const spread = (a) => Math.max(...a) - Math.min(...a);
    const align = spread(lefts) <= 4 ? 'start' : spread(centers) <= 4 ? 'center' : 'start';
    const uniformGap = spread(gaps) <= 4;
    return {
      dir: 'column', wrap: false, gap: uniformGap ? round(median(gaps)) : 0, gaps: uniformGap ? null : gaps.map((g) => round(g)),
      counterGap: 0, padding: pad(flow), justify: 'start', align, reverse: false, order: byY.map((k) => k.id), decor: [...decor],
      inferred: true, confidence: 0.7,
    };
  }
  return null; // genuinely overlapping composition -> stays absolute
}

function looksLikeButton(ir, n) {
  if (!isContainerType(n.type) || !n.layout || n.layout.dir !== 'row') return false;
  if (n.box.h > 96 || n.box.w > 520) return false;
  const texts = [];
  const stack = [...n.children];
  while (stack.length) {
    const c = ir.nodes[stack.pop()];
    if (c.text) texts.push(c);
    else stack.push(...c.children);
  }
  if (texts.length !== 1 || texts[0].text.content.length > 40) return false;
  const s = visualStyle(n);
  const named = /button|btn|cta|quote|component|frame 7|frame 231/i.test(n.name);
  return (s.fill || s.stroke) && (s.radius || named || n.interactions?.length || !!n.states);
}

export function analyze(ir) {
  const N = ir.nodes;
  const interByNode = new Map();
  for (const it of ir.interactions) {
    if (!interByNode.has(it.nodeId)) interByNode.set(it.nodeId, []);
    interByNode.get(it.nodeId).push(it);
  }
  for (const n of Object.values(N)) {
    n.interactions = interByNode.get(n.id) || [];
    n.a = { role: null, notes: [] };
  }

  for (const f of ir.frames) {
    const root = N[f.rootId];
    root.a.role = 'page';
    const frameBox = root.box;

    // ---- sections: root children in flow order (absolute root children are page-level decor)
    const flowKids = root.children.map((c) => N[c]).filter((c) => c.positioning !== 'absolute');
    flowKids.sort((a, b) => a.box.y - b.box.y);
    flowKids.forEach((s, i) => {
      s.a.role = 'section';
      s.a.sectionIndex = i;
    });
    root.children.map((c) => N[c]).filter((c) => c.positioning === 'absolute').forEach((c) => (c.a.role = 'page-decor'));

    // ---- per node roles
    const visit = (id, parent) => {
      const n = N[id];
      const p = parent ? N[parent] : null;
      const textInside = hasText(ir, id);
      if (!n.a.role || n.a.role === 'node') {
        if (n.text) n.a.role = 'text';
        else if (n.asset && !textInside && !keepLive(ir, n)) n.a.role = ir.assets[n.asset]?.kind === 'image' ? 'image' : 'svg';
        else if (n.type === 'line') n.a.role = 'divider';
        else if (looksLikeButton(ir, n)) n.a.role = 'button';
        else if (n.fills.some((f) => f.type === 'image') && !n.children.length) n.a.role = 'image';
        else if (isContainerType(n.type) || n.children.length) n.a.role = 'container';
        else n.a.role = 'shape';
      }
      // In a container without auto-layout every child is effectively absolutely positioned.
      const absolute = n.positioning === 'absolute' || (p && !p.layout);
      if (p?.a.decor) n.a.decor = true; // decoration is inherited by the whole subtree
      // Decoration: absolute, out-of-flow, not text-bearing — or giant watermark text.
      if (p && n.positioning === 'absolute' && !textInside) n.a.decor = true;
      const bigText = n.text ? Math.max(...n.text.runs.map((r) => r.size)) : 0;
      if (p && (absolute || p.positioning === 'absolute') && n.text && (bigText >= 120 || !contains(p.box, n.box, 2))) n.a.decor = true;
      if (p && !contains(p.box, n.box, 2)) n.a.bleeds = true;
      // A wide (>= 80% of the frame), text-free vector placed freely in a layout-less container is a
      // decorative layer (curves, masks, bands), not content to reflow.
      if (p && absolute && !textInside && ['svg', 'shape'].includes(n.a.role) && n.box.w >= frameBox.w * 0.8 && !n.interactions?.length) n.a.decor = true;
      // Background layer: first-painted child covering >=90% of an absolute-layout parent.
      // Must match the parent's box (not just cover it): a larger child bleeds and keeps its own placement.
      const fits = p && Math.abs(n.box.x - p.box.x) <= 2 && Math.abs(n.box.y - p.box.y) <= 2 && Math.abs(n.box.w - p.box.w) <= 2 && Math.abs(n.box.h - p.box.h) <= 2;
      if (p && absolute && !textInside && p.children[0] === id && fits && !n.children.length) n.a.background = true;
      // Rolling-digit counters: a tall text strip of 1–2 char lines clipped by its parent.
      if (n.text && p?.clips) {
        const lines = n.text.content.split('\n');
        if (lines.length >= 5 && lines.every((l) => l.trim().length <= 3) && n.box.h > p.box.h * 3) {
          n.a.counter = true;
          p.a.widget = 'counter-digit';
        }
      }

      // A row whose children sit on several lines is a wrapping row whose wrap flag the export lost
      // (a 4×3 grid of buttons exported as one row): wrap it, with the gaps measured from the boxes.
      if (n.layout?.dir === 'row' && !n.layout.wrap) {
        const kids = n.children.map((c) => N[c]).filter((k) => k.positioning !== 'absolute');
        // Lines = groups of items whose vertical ranges overlap (a thin connector shares its steps' line).
        const lines = [];
        for (const k of [...kids].sort((x, y) => x.box.y - y.box.y)) {
          const l = lines.find((ln) => ln.some((o) => Math.min(o.box.y + o.box.h, k.box.y + k.box.h) > Math.max(o.box.y, k.box.y)));
          if (l) l.push(k);
          else lines.push([k]);
        }
        if (kids.length >= 4 && lines.length >= 2 && lines.every((ln) => ln.length >= 2 || ln === lines.at(-1))) {
          const line0 = lines[0].sort((x, y) => x.box.x - y.box.x);
          const hg = line0.slice(1).map((k, i) => k.box.x - (line0[i].box.x + line0[i].box.w));
          const bottom0 = Math.max(...line0.map((k) => k.box.y + k.box.h));
          const vg = Math.min(...lines[1].map((k) => k.box.y)) - bottom0;
          Object.assign(n.layout, { wrap: true, gap: round(hg.length ? median(hg) : n.layout.gap), counterGap: round(Math.max(0, vg)) });
          for (const k of kids) (k.sizing.w === 'fill' && (k.sizing.w = 'fixed')), (k.grow = 0); // wrap items keep their width
          n.a.notes.push(`wrap restored from child positions (${lines.length} lines)`);
        }
      }
      if (n.a.role === 'container' && !n.layout) {
        const inf = inferLayout(ir, n);
        if (inf) {
          n.a.inferredLayout = inf;
          for (const d of inf.decor) N[d].a.edgeLine = true;
          n.a.notes.push(`layout inferred (${inf.dir}, confidence ${inf.confidence})`);
        }
      }
      if (n.a.role === 'button') {
        // Children keep their own roles (text, svg …) and are flagged as parts of the button.
        const flag = (cid) => ((N[cid].a.inButton = n.id), N[cid].children.forEach(flag));
        n.children.forEach(flag);
      }
      for (const c of n.children) if (!N[c].a.role) visit(c, id);
    };
    const markInside = (id, role) => {
      N[id].a.role = role;
      N[id].children.forEach((c) => markInside(c, role));
    };
    // asset-rendered subtrees: children are baked into the asset
    for (const n of Object.values(N)) {
      if (n.frameId !== f.id) continue;
      if (n.asset && !hasText(ir, n.id) && !keepLive(ir, n)) n.children.forEach((c) => markInside(c, 'asset-part'));
    }
    for (const s of flowKids) visit(s.id, root.id);
    root.children.map((c) => N[c]).filter((c) => c.positioning === 'absolute').forEach((c) => visit(c.id, root.id));

    // ---- heading levels from the type scale (largest distinct sizes of the display font)
    // Headings: only real content text (not decor, counters, button labels) that is display-face
    // or >= 28px. Levels follow the page's distinct heading sizes; the first top-rank one is h1.
    const allTexts = Object.values(N).filter((n) => n.frameId === f.id && n.text);
    const sizeOf = (n) => Math.max(...n.text.runs.map((r) => r.size));
    const isDisplay = (t) => t.text.runs.some((r) => !/helvetica|arial|inter|roboto|sans-serif/i.test(r.family));
    const candidates = allTexts.filter((t) => t.a.role === 'text' && !t.a.inButton && !t.a.decor && !t.a.counter && t.text.content.trim().length > 2 && (sizeOf(t) >= 28 || (isDisplay(t) && sizeOf(t) >= 18)));
    const sizes = [...new Set(candidates.map(sizeOf))].sort((a, b) => b - a);
    let h1Assigned = false;
    for (const t of allTexts.sort((a, b) => a.box.y - b.box.y)) {
      let tag = t.a.counter ? 'span' : 'p';
      if (candidates.includes(t)) {
        const s = sizeOf(t);
        // h1 = first top-of-scale heading; then absolute size bands keep sibling sections consistent.
        if (!h1Assigned && sizes.indexOf(s) <= 1) (tag = 'h1'), (h1Assigned = true);
        else tag = s >= 44 ? 'h2' : s >= 28 ? 'h3' : 'h4';
      }
      if (t.a.inButton) tag = 'span';
      if (t.text.runs.some((r) => r.href) || t.interactions.some((i) => i.url)) t.a.link = true;
      t.a.tag = tag;
    }

    // ---- widget patterns (flag for the planner; compilers render statically unless a native mapping exists)
    for (const n of Object.values(N)) {
      if (n.frameId !== f.id || n.a.role !== 'container') continue;
      const kids = n.children.map((c) => N[c]);
      if (kids.length >= 3 && kids.every((k) => k.interactions.some((i) => i.trigger === 'click'))) n.a.widget = 'accordion';
      if (n.box.w > frameBox.w * 1.5 && kids.length >= 4) n.a.widget = 'carousel-strip';
      // A form holds several fields (one "Email *" label makes a field, not a form); by name only the
      // word "form" counts ("Information" is a contact strip, not a form).
      if (kids.filter((k) => /input|field|first name|message|email|phone/i.test(k.name)).length >= 2 || (n.text == null && /\bform\b|get in touch/i.test(n.name))) n.a.widget = n.a.widget || 'form';
    }
    detectInteractive(ir, f, frameBox);
    promoteHeader(ir, f);
  }
  return ir;
}

// ---- sticky header: the block holding the nav menu becomes the page's first section, so it can stay
// pinned while the page scrolls (position: sticky only sticks inside its parent, and a header nested
// in the hero would scroll away with it). It moves only when it is flush with the top of the first
// section and that section paints no background behind it; the section keeps the rest, starting
// where the header ended. A header that already is the first section is just marked.
function promoteHeader(ir, f) {
  const N = ir.nodes;
  const root = N[f.rootId];
  const panel = Object.values(N).find((n) => n.frameId === f.id && n.a.menuPanel);
  if (!panel) return;
  let h = panel;
  while (h.parent && !['section', 'page'].includes(N[h.parent].a.role)) h = N[h.parent];
  const s = N[h.parent];
  if (!s) return;
  if (s.a.role === 'page') {
    if (h.a.sectionIndex === 0 && h.box.h <= 320) h.a.header = true;
    return;
  }
  if (s.a.sectionIndex === 0 && s.box.h <= 320) return void (s.a.header = true); // the section is the header
  const L = s.layout;
  const flow = s.children.filter((c) => N[c].positioning !== 'absolute');
  const why = s.a.sectionIndex !== 0 ? 'not in the first section'
    : !L || L.dir !== 'column' ? 'its section is not a column'
    : flow[0] !== h.id || flow.length < 2 || h.positioning === 'absolute' ? 'not the first block of its section'
    : L.padding[0] || L.padding[1] || L.padding[3] ? 'its section has padding around it'
    : s.fills.some((x) => x.visible !== false && (x.opacity ?? 1) > 0) && !h.fills.length ? 'it sits on its section\'s background'
    : null;
  if (why) return void s.a.notes.push(`header not made sticky: ${why}`);
  s.children = s.children.filter((c) => c !== h.id);
  root.children.splice(root.children.indexOf(s.id), 0, h.id);
  h.parent = root.id;
  const cut = h.box.y + h.box.h - s.box.y;
  s.box = { ...s.box, y: s.box.y + cut, h: s.box.h - cut };
  if (s.renderBox) s.renderBox = { ...s.renderBox, y: s.renderBox.y + cut, h: s.renderBox.h - cut };
  L.padding = [L.gap, L.padding[1], L.padding[2], L.padding[3]];
  Object.assign(h.a, { role: 'section', header: true, hoistedFrom: s.id });
  // A section never collapses itself: when the bar picked as the panel is the header, the links do.
  if (panel === h) {
    delete h.a.menuPanel;
    const links = Object.values(N).find((n) => n.frameId === f.id && n.a.navLinks);
    if (links) links.a.menuPanel = true;
  }
  h.a.notes.push(`header promoted out of "${s.name}" to its own section (sticky)`);
  s.a.notes.push(`header "${h.name}" moved to its own section above`);
  root.children.map((c) => N[c]).filter((c) => c.a.role === 'section').sort((a, b) => a.box.y - b.box.y || (b.a.header ? 1 : 0) - (a.a.header ? 1 : 0)).forEach((c, i) => (c.a.sectionIndex = i));
}

// ---- interactive components, recognised by structure (layer names are unreliable). Each becomes
// a widget the compilers mark with runtime hooks; the page works without JavaScript in the design's
// resting state, and the bridge's runtime adds the behaviour.
//  - accordion: a column of ≥3 items, each headed by a row of text + a small icon; some items carry
//    content after the heading (open), others not (closed);
//  - slider: a row of ≥2 equal cards with two small absolutely placed controls at its left and right
//    ends (prev / next);
//  - marquee: a clipped single row of ≥3 items running past the clip edge, with no controls;
//  - nav menu: the top-of-page row of ≥3 short link labels (the one beside a call-to-action button
//    wins); its bar collapses behind a menu button on tablets and phones.
function detectInteractive(ir, f, frameBox) {
  const N = ir.nodes;
  const inFrame = Object.values(N).filter((n) => n.frameId === f.id);
  const kidsOf = (n) => n.children.map((c) => N[c]);
  const hasText = (n) => !!n.text || n.children.some((c) => hasText(N[c]));
  const icon = (k) => k && k.box.w <= 48 && k.box.h <= 48 && !hasText(k) && ['svg', 'image', 'container', 'shape'].includes(k.a.role);

  for (const n of inFrame) {
    if (n.a.role !== 'container' || n.a.widget) continue;
    const L = layoutOf(n);
    const kids = kidsOf(n);
    // accordion
    if (L?.dir === 'column' && kids.length >= 3 && kids.every((it) => it.a.role === 'container' && it.children.length)) {
      const heads = kids.map((it) => N[it.children[0]]);
      const headOk = heads.every((h) => layoutOf(h)?.dir === 'row' && kidsOf(h).some((c) => c.text) && kidsOf(h).some(icon));
      const open = kids.filter((it) => it.children.length >= 2);
      if (headOk && open.length >= 1 && open.length < kids.length) {
        n.a.widget = 'accordion';
        kids.forEach((it, i) => {
          it.a.accItem = it.children.length >= 2 ? 'open' : 'closed';
          heads[i].a.accHead = true;
          for (const c of kidsOf(heads[i])) if (icon(c)) c.a.accIcon = true;
          for (const c of it.children.slice(1)) N[c].a.accPanel = true;
        });
        continue;
      }
    }
    // slider
    if (L?.dir === 'row') {
      const flow = kids.filter((k) => k.positioning !== 'absolute');
      const cards = flow.filter((k) => k.box.w >= 200);
      const ctl = kids.filter((k) => k.positioning === 'absolute' && k.box.w <= 100 && k.box.h <= 100);
      const cx = (k) => k.box.x + k.box.w / 2;
      const prev = ctl.find((k) => cx(k) <= n.box.x + n.box.w * 0.15);
      const next = ctl.find((k) => cx(k) >= n.box.x + n.box.w * 0.85);
      const ws = cards.map((k) => k.box.w);
      if (cards.length >= 2 && prev && next && Math.max(...ws) <= Math.min(...ws) * 1.15) {
        n.a.widget = 'slider';
        cards.forEach((k) => (k.a.slide = true));
        Object.assign(prev.a, { sliderControl: 'prev', decor: false });
        Object.assign(next.a, { sliderControl: 'next', decor: false });
        continue;
      }
    }
    // strip: a single row of ≥3 equal cards that runs past its own box on purpose (an ancestor clips
    // the rest) — one row on desktop, a swipeable row on small screens; never a wrapped grid.
    if (L?.dir === 'row' && !L.wrap && !n.clips) {
      const flow = kids.filter((k) => k.positioning !== 'absolute');
      const ws = flow.map((k) => k.box.w);
      const right = Math.max(...flow.map((k) => k.box.x + k.box.w));
      if (flow.length >= 3 && right > n.box.x + n.box.w * 1.1 && Math.max(...ws) <= Math.min(...ws) * 1.15) {
        n.a.strip = true;
        continue;
      }
    }
    // marquee
    if (n.clips && L?.dir === 'row' && kids.length >= 3 && !kids.some((k) => k.positioning === 'absolute' && k.box.w <= 100)) {
      const right = Math.max(...kids.map((k) => k.box.x + k.box.w));
      if (right > n.box.x + n.box.w * 1.2 && kids.every((k) => hasText(k))) n.a.widget = 'marquee';
    }
  }

  // nav menu
  const label = (k) => {
    const t = k.text ? k : kidsOf(k).find((c) => c.text);
    return t && !t.text.content.includes('\n') && t.text.content.trim().length <= 24 && (k.text || k.children.length <= 3);
  };
  let best = null;
  for (const n of inFrame) {
    const L = layoutOf(n);
    if (n.a.role !== 'container' || L?.dir !== 'row' || n.box.y > frameBox.y + 400) continue;
    const kids = kidsOf(n);
    if (kids.length < 3 || !kids.every((k) => label(k) && k.box.w <= 300)) continue;
    const p = N[n.parent];
    // A call-to-action beside the links: a button, or any small labelled box (often a plain frame).
    const cta = p && kidsOf(p).some((s) => s !== n && (s.a.role === 'button' || (hasText(s) && s.box.w <= 400 && s.box.h <= 100)));
    const score = kids.length + (cta ? 3 : 0) + (kids.some((k) => k.a.link || kidsOf(k).some((c) => c.a.link)) ? 2 : 0);
    if (!best || score > best.score) best = { n, score, p, cta };
  }
  if (best) {
    best.n.a.navLinks = true;
    // The bar that collapses: the links' row parent when it holds the call-to-action, else the links.
    const panel = best.p && best.cta && layoutOf(best.p)?.dir === 'row' && best.p.a.role !== 'section' ? best.p : best.n;
    panel.a.menuPanel = true;
  }
}

// The box an asset-rendered node actually occupies. Figma exports assets "as rendered": an SVG
// includes its stroke bleed, a raster is clipped to what is visible. When the asset matches the render
// box better than the layout box, the render box is the truth for size and position.
export function visualBox(n, asset) {
  if (!n.renderBox || !(n.a?.role === 'svg' || n.a?.role === 'image') || !n.asset) return n.box;
  if (n.a.role === 'svg') return n.renderBox;
  if (!asset?.width) return n.box;
  const d = (b) => Math.abs(b.w - asset.width) + Math.abs(b.h - asset.height);
  return d(n.renderBox) + 1 < d(n.box) ? n.renderBox : n.box;
}

// Effective layout for a container: Figma auto-layout first, inferred second.
export const layoutOf = (n) => n.layout || n.a?.inferredLayout || null;
