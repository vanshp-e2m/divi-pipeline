// In-page measurement functions (serialised into the browser by Playwright). Each returns plain data;
// severity and scoring are decided by the suite, not here.

// Leaf elements we generated, with rects; `spec` maps class -> { kind, decor, designBox, text }.
export function collectLeaves(spec) {
  const out = [];
  for (const el of document.querySelectorAll('[class*="f2d-"]')) {
    const cls = [...el.classList].find((c) => /^f2d-[0-9a-f]{8}$/.test(c));
    const s = cls && spec[cls];
    if (!s || !s.leaf || s.decor) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width < 1 || r.height < 1) continue;
    out.push({ cls, kind: s.kind, x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, section: s.section });
  }
  return out;
}

// Responsive defects at the current width.
export function responsiveScan(spec) {
  // The sticky header keeps its place in the flow; pinned while these checks scroll, it would sit over
  // whatever they look at. It is checked on its own (stickyScan).
  const pinned = [...document.querySelectorAll('.f2d-header')].map((h) => [h, h.style.position]);
  for (const [h] of pinned) h.style.position = 'relative';
  const res = { overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, offenders: [], overlaps: [], clipped: [], tiny: [], offscreen: [], cut: [], brokenWords: [], squeezed: [], gutters: [], covered: [], spill: [] };
  const canvas = document.createElement('canvas').getContext('2d');
  const sectionSpan = {};
  const vw = document.documentElement.clientWidth;
  const leaves = [];
  for (const el of document.querySelectorAll('[class*="f2d-"]')) {
    const cls = [...el.classList].find((c) => /^f2d-[0-9a-f]{8}$/.test(c));
    const s = cls && spec[cls];
    if (!s) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    // Not rendered at all (inside a collapsed menu, a closed accordion item, an inactive slide):
    // nothing a visitor sees, so nothing to judge here.
    if (el.checkVisibility && !el.checkVisibility()) continue;
    // A text box collapsed to (near) zero width with its text spilling out is the worst squeeze,
    // not an unrendered element.
    if (s.kind === 'text' && !s.decor && !s.counter && r.width < 8 && (el.innerText || '').trim().length > 3) {
      res.squeezed.push({ cls, boxW: Math.round(r.width), chars: (el.innerText || '').trim().length });
      continue;
    }
    if (r.width < 1 || r.height < 1) continue;
    // Elements that stick out of the viewport horizontally (unless clipped by an ancestor).
    if (!s.decor && (r.right > vw + 1 || r.left < -1)) {
      let clippedByAncestor = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const pc = getComputedStyle(p);
        if (/hidden|clip|auto|scroll/.test(pc.overflowX)) {
          const pr = p.getBoundingClientRect();
          if (pr.right <= vw + 1 && pr.left >= -1) { clippedByAncestor = true; break; }
        }
      }
      if (!clippedByAncestor) res.offscreen.push({ cls, left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) });
    }
    if (!s.leaf || s.decor) continue;
    // Invisible content (opacity ~0 on itself or an ancestor, e.g. a hover-reveal layer) cannot overlap
    // or be cut off in what a visitor sees.
    let opacity = parseFloat(cs.opacity);
    for (let p = el.parentElement; p && p !== document.body && opacity > 0.05; p = p.parentElement) opacity *= parseFloat(getComputedStyle(p).opacity);
    if (opacity <= 0.05) continue;
    // Visible rect: clipped by every overflow-hidden/clip ancestor (clipped-away content cannot overlap).
    let vx1 = r.left, vy1 = r.top, vx2 = r.right, vy2 = r.bottom;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const pc = getComputedStyle(p);
      // A scroll container does not cut its content off: a visitor scrolls to it.
      if (/auto|scroll/.test(pc.overflowX + pc.overflowY)) break;
      if (/hidden|clip/.test(pc.overflowX + pc.overflowY + pc.overflow)) {
        const pr = p.getBoundingClientRect();
        vx1 = Math.max(vx1, pr.left); vy1 = Math.max(vy1, pr.top); vx2 = Math.min(vx2, pr.right); vy2 = Math.min(vy2, pr.bottom);
      }
    }
    // Content cut off by a clipping ancestor, although it is fully visible in the design.
    const ownArea = r.width * r.height;
    const visArea = Math.max(0, vx2 - vx1) * Math.max(0, vy2 - vy1);
    // Text loses letters long before it loses 10% of its area: a label cut by more than 4px at either
    // end ("IEW ALL SERVICE") counts too.
    const textCut = s.kind === 'text' && r.width - Math.max(0, vx2 - vx1) > 4;
    if (s.designVisible && !s.inWidget && ownArea > 64 && (visArea / ownArea < 0.9 || textCut)) res.cut.push({ cls, kind: s.kind, visible: Math.round((visArea / ownArea) * 100) / 100, hiddenPx: Math.round(r.width - Math.max(0, vx2 - vx1)) });
    if (vx2 - vx1 < 1 || vy2 - vy1 < 1) continue;
    // Text that cannot hold its longest word (mid-word breaks) or is squeezed into a sliver.
    if (s.kind === 'text' && !s.counter) {
      const t = el.querySelector(':scope > .f2d-tc, :scope .f2d-t') || el;
      const tcs = getComputedStyle(t);
      canvas.font = `${tcs.fontStyle} ${tcs.fontWeight} ${tcs.fontSize} ${tcs.fontFamily}`;
      const text = (el.innerText || '').trim();
      const words = text.split(/\s+/).filter(Boolean);
      const ls = parseFloat(tcs.letterSpacing) || 0;
      const up = tcs.textTransform === 'uppercase';
      let longest = 0, word = '';
      // E-mail addresses and URLs are not words: wrapping them anywhere is the expected small-screen
      // behaviour (the compiler allows it), not a broken word.
      for (const w0 of words) {
        if (/@|:\/\/|^www\.|\.(com|net|org|io|co|au|uk)/i.test(w0)) continue;
        const w1 = up ? w0.toUpperCase() : w0;
        const wd = canvas.measureText(w1).width + ls * w1.length;
        if (wd > longest) (longest = wd), (word = w1);
      }
      const contentW = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      if (words.length && longest > contentW + 2 && cs.whiteSpace !== 'nowrap' && cs.whiteSpace !== 'pre') res.brokenWords.push({ cls, word: word.slice(0, 30), wordW: Math.round(longest), boxW: Math.round(contentW), heading: !!s.heading });
      if (text.length > 15 && contentW < Math.min(120, vw * 0.3)) res.squeezed.push({ cls, boxW: Math.round(contentW), chars: text.length });
    }
    if (s.section && !s.inWidget) {
      // The space the content is laid out in (its parent's content box), not its ink: a centred stack
      // of small icons in full-width steps is fine, a heading boxed in by desktop padding is not.
      const pe = el.parentElement;
      const pr = pe.getBoundingClientRect();
      const pcs = getComputedStyle(pe);
      const sp = (sectionSpan[s.section] ??= { x1: Infinity, x2: -Infinity, n: 0 });
      sp.x1 = Math.min(sp.x1, vx1, pr.left + (parseFloat(pcs.borderLeftWidth) || 0) + (parseFloat(pcs.paddingLeft) || 0));
      sp.x2 = Math.max(sp.x2, vx2, pr.right - (parseFloat(pcs.borderRightWidth) || 0) - (parseFloat(pcs.paddingRight) || 0));
      sp.n++;
    }
    const box = { cls, el, kind: s.kind, x: vx1 + scrollX, y: vy1 + scrollY, w: vx2 - vx1, h: vy2 - vy1, section: s.section };
    leaves.push(box);
    if (s.kind === 'text' && el.scrollHeight > el.clientHeight + 2 && /hidden|clip/.test(cs.overflow + cs.overflowY) && !s.counter) res.clipped.push({ cls, scrollH: el.scrollHeight, clientH: el.clientHeight });
    // Text spilling out of its own box by (part of) a line — a squeezed box with overflow visible: it paints over whatever
    // follows, although no two boxes overlap.
    else if (s.kind === 'text' && !s.counter && el.clientHeight > 0 && el.scrollHeight - el.clientHeight >= Math.max(8, 0.6 * (parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2))) res.spill.push({ cls, scrollH: el.scrollHeight, clientH: el.clientHeight });
    if ((s.kind === 'button' || s.link) && (r.width < 24 || r.height < 24)) res.tiny.push({ cls, w: Math.round(r.width), h: Math.round(r.height) });
  }
  // Overlap of leaves that do not overlap in the design (a design overlap is intentional).
  const candidates = [];
  const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i], b = leaves[j];
      if (Math.abs(a.y - b.y) > 2000) continue;
      const ov = inter(a, b);
      if (ov < 16) continue;
      if (spec[a.cls].overlapsInDesign?.includes(b.cls) || spec[b.cls].overlapsInDesign?.includes(a.cls)) continue;
      if (spec[a.cls].ancestors?.includes(b.cls) || spec[b.cls].ancestors?.includes(a.cls)) continue;
      const frac = ov / Math.min(a.w * a.h, b.w * b.h);
      if (frac > 0.05) candidates.push({ a, b, frac });
    }
  }
  // Paint check: at the centre of the overlap both elements must be visible — no opaque layer
  // (e.g. a later section's background) between the upper and the lower one.
  const opaque = (e) => {
    const c = getComputedStyle(e);
    const m = c.backgroundColor.match(/rgba?\(([^)]+)\)/);
    const alpha = m ? (m[1].split(',')[3] === undefined ? 1 : parseFloat(m[1].split(',')[3])) : 0;
    return alpha > 0.9 || (c.backgroundImage !== 'none' && !e.matches('img'));
  };
  for (const { a, b, frac } of candidates) {
    const cx = (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2, cy = (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2;
    window.scrollTo(0, Math.max(0, cy - innerHeight / 2));
    const stack = document.elementsFromPoint(cx - scrollX, cy - scrollY);
    const ia = stack.findIndex((e) => e === a.el || a.el.contains(e));
    const ib = stack.findIndex((e) => e === b.el || b.el.contains(e));
    if (ia < 0 || ib < 0) continue;
    const [top, low] = ia < ib ? [ia, ib] : [ib, ia];
    const lowEl = stack[low];
    const between = stack.slice(top + 1, low).filter((e) => !e.contains(lowEl));
    if (between.some(opaque)) continue;
    res.overlaps.push({ a: a.cls, b: b.cls, kinds: `${a.kind}/${b.kind}`, frac: Math.round(frac * 100) / 100 });
  }
  // Text painted over by other content (a nav link under the call button): what a visitor sees at the
  // text's centre is another content element that does not overlap it in the design. (Backgrounds of
  // later sections are not content; the overlap check above already handles those.)
  const specOf = (e) => {
    for (let p = e; p && p !== document.body; p = p.parentElement) {
      const c = [...p.classList].find((k) => /^f2d-[0-9a-f]{8}$/.test(k));
      if (c && spec[c]) return { el: p, cls: c };
    }
    return null;
  };
  const texts = leaves.filter((l) => l.kind === 'text' && spec[l.cls].designVisible !== false && !spec[l.cls].decor && l.w >= 4 && l.h >= 4).sort((x, y) => x.y - y.y);
  let viewTop = -Infinity;
  for (const t of texts) {
    const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    if (cy < viewTop + 20 || cy > viewTop + innerHeight - 20) {
      window.scrollTo(0, Math.max(0, cy - innerHeight / 2));
      viewTop = scrollY;
    }
    // Topmost element a visitor actually sees there: transparent layers (hover reveals) are hit-tested
    // by the browser but paint nothing.
    const seen = (e) => {
      let o = 1;
      for (let p = e; p && p !== document.body && o > 0.05; p = p.parentElement) {
        const c = getComputedStyle(p);
        if (c.visibility === 'hidden') return false;
        o *= parseFloat(c.opacity);
      }
      return o > 0.05;
    };
    const top = document.elementsFromPoint(cx - scrollX, cy - scrollY).find(seen);
    if (!top || top === t.el || t.el.contains(top) || top.contains(t.el)) continue;
    const owner = specOf(top);
    if (!owner || owner.el.contains(t.el)) continue;
    const os = spec[owner.cls];
    if (os.decor || !['button', 'image', 'text', 'svg'].includes(os.kind)) continue;
    if (spec[t.cls].overlapsInDesign?.includes(owner.cls) || os.overlapsInDesign?.includes(t.cls)) continue;
    if (spec[t.cls].ancestors?.includes(owner.cls) || os.ancestors?.includes(t.cls)) continue;
    res.covered.push({ cls: t.cls, by: owner.cls, byKind: os.kind });
  }
  window.scrollTo(0, 0);
  // Sections whose content uses less than half the width on tablet/phone (dead side gutters).
  if (vw <= 980) for (const [sec, sp] of Object.entries(sectionSpan)) if (sp.n >= 2 && sp.x2 - sp.x1 < vw * 0.5) res.gutters.push({ section: sec, used: Math.round(sp.x2 - sp.x1), of: vw });
  // What causes horizontal overflow: the widest non-clipped elements.
  if (res.overflowX > 1) {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width > 0) {
        const cls = [...el.classList].find((c) => /^f2d-[0-9a-f]{8}$/.test(c)) || el.className?.toString().slice(0, 60);
        res.offenders.push({ cls, right: Math.round(r.right) });
        if (res.offenders.length > 8) break;
      }
    }
  }
  for (const [h, v] of pinned) h.style.position = v;
  return res;
}

// The DEV Connect "looks intentional" checks, per viewport: tap targets, orphaned heading words,
// uneven card heights, a lonely last grid item, distorted images, content collapsed to zero height,
// content spilling into the next section, cramped edges at 360 and below, and (from 1920 up) 4K
// containment per section. `sections`: [{ cls, lD, rD }] with each section's content gaps in the design.
export function uxScan({ spec, sections, frameW = 1920 }) {
  const vw = document.documentElement.clientWidth;
  const win = innerWidth; // media queries (and so the tiers) use the window width, scrollbar included
  const out = { tap: [], orphans: [], uneven: [], lonely: [], distorted: [], zero: [], spill: [], cramped: [], contain: [] };
  const clsOf = (el) => [...el.classList].find((c) => /^f2d-[0-9a-f]{8}$/.test(c));
  const shown = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && (!el.checkVisibility || el.checkVisibility()); };
  const inMarquee = (el) => !!el.closest('.f2d-marquee');
  // Tap targets (phones): everything a visitor taps is at least 44×44.
  if (win <= 767) {
    for (const el of document.querySelectorAll('a[href], button, [role="button"], .f2d-acc-head, .f2d-slider-prev, .f2d-slider-next')) {
      if (!shown(el) || inMarquee(el) || el.closest('[aria-hidden="true"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const own = el.closest('[class*="f2d-"]');
      if (r.width < 43.5 || r.height < 43.5) out.tap.push({ cls: (own && clsOf(own)) || el.tagName, w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30) });
    }
  }
  for (const el of document.querySelectorAll('[class*="f2d-"]')) {
    const cls = clsOf(el);
    const s = cls && spec[cls];
    if (!s || !shown(el)) continue;
    const r = el.getBoundingClientRect();
    // Orphans: a heading whose last line holds one word under a line of two or more (below the design
    // width: at and above it the design's own line breaks apply). One word per line is not an orphan.
    if (s.heading && r.width > 0 && win < frameW) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const words = [];
      for (let t = walker.nextNode(); t; t = walker.nextNode()) for (const m of t.data.matchAll(/\S+/g)) words.push([t, m.index, m.index + m[0].length]);
      if (words.length >= 3) {
        const rect = ([t, a, b]) => { const rg = document.createRange(); rg.setStart(t, a); rg.setEnd(t, b); const rr = rg.getClientRects(); return rr.length ? rr[rr.length - 1] : null; };
        const lines = [];
        for (const w of words) {
          const q = rect(w);
          if (!q) continue;
          const l = lines.at(-1);
          if (l && Math.abs(l.y - q.top) <= 2) (l.n++, (l.x1 = Math.min(l.x1, q.left)), (l.x2 = Math.max(l.x2, q.right)));
          else lines.push({ y: q.top, n: 1, x1: q.left, x2: q.right });
        }
        // …and visibly short: a lone word much narrower than the line above it.
        const [p, last] = lines.slice(-2);
        if (lines.length >= 2 && last.n === 1 && p.n >= 2 && last.x2 - last.x1 < 0.4 * (p.x2 - p.x1)) out.orphans.push({ cls, word: el.textContent.trim().split(/\s+/).at(-1).slice(0, 20), text: el.textContent.trim().slice(0, 40) });
      }
    }
    if (s.leaf && !s.decor && s.designVisible && !s.inWidget) {
      // Collapsed: shown, but with no height (a parent squeezed it to nothing).
      if (r.width >= 1 && r.height < 1 && (s.kind !== 'text' || (el.textContent || '').trim())) out.zero.push({ cls, kind: s.kind });
      // Distorted: a stretched (object-fit: fill) image whose shape differs from the design's.
      if (s.kind === 'image' && s.box && r.width > 8 && r.height > 8) {
        const img = el.matches('img') ? el : el.querySelector('img');
        if (img && getComputedStyle(img).objectFit === 'fill') {
          const ir = img.getBoundingClientRect(), a0 = s.box.w / s.box.h, a1 = ir.width / ir.height;
          if (ir.width > 8 && ir.height > 8 && Math.abs(a1 / a0 - 1) > 0.06) out.distorted.push({ cls, design: Math.round(a0 * 100) / 100, got: Math.round(a1 * 100) / 100 });
        }
      }
      // Cramped (≤360): text or a button touching the screen edge (cards of a swipeable strip run
      // past it on purpose).
      const inScroller = () => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowX)) return true; return false; };
      if (win <= 360 && ['text', 'button'].includes(s.kind) && r.width > 0 && !inMarquee(el) && r.right > 0 && r.left < vw && (r.left < 12 || r.right > vw - 12) && !inScroller()) out.cramped.push({ cls, left: Math.round(r.left), right: Math.round(vw - r.right) });
    }
  }
  // Cards: siblings with their own paint (background, border or shadow) on one line.
  const painted = (el) => { const c = getComputedStyle(el); const m = c.backgroundColor.match(/[\d.]+/g); return (m && (m[3] === undefined || +m[3] > 0.05)) || c.backgroundImage !== 'none' || parseFloat(c.borderTopWidth) > 0 || c.boxShadow !== 'none'; };
  const parents = new Set();
  for (const el of document.querySelectorAll('[class*="f2d-"]')) { const s = spec[clsOf(el)]; if (s && !s.leaf && !s.decor && s.kind !== 'section' && el.parentElement) parents.add(el.parentElement); }
  for (const p of parents) {
    const kids = [...p.children].filter((k) => { const s = spec[clsOf(k)]; return s && !s.leaf && !s.decor && shown(k) && !inMarquee(k) && painted(k) && k.getBoundingClientRect().width >= 120; });
    if (kids.length < 2) continue;
    const rows = [];
    for (const k of kids) {
      const r = k.getBoundingClientRect();
      const row = rows.find((x) => Math.abs(x.top - r.top) < 3);
      if (row) row.items.push({ k, r }); else rows.push({ top: r.top, items: [{ k, r }] });
    }
    for (const row of rows) {
      const hs = row.items.map((i) => i.r.height), ws = row.items.map((i) => i.r.width);
      if (row.items.length >= 2 && Math.max(...ws) <= Math.min(...ws) * 1.2 && Math.max(...hs) - Math.min(...hs) > 8) out.uneven.push({ cls: clsOf(row.items[0].k), heights: hs.map(Math.round) });
    }
    // Lonely last item: a grid of 2+ per line ending in one item that does not fill its line.
    const pr = p.getBoundingClientRect();
    if (rows.length >= 2 && rows.slice(0, -1).every((x) => x.items.length >= 2) && rows.at(-1).items.length === 1 && rows.at(-1).items[0].r.width < pr.width * 0.75) out.lonely.push({ cls: clsOf(rows.at(-1).items[0].k), perLine: rows[0].items.length });
  }
  // Section spill: content running past the bottom of its section (into the next one), unless the
  // design hangs it over on purpose.
  const secEl = {};
  for (const e of document.querySelectorAll('.f2d-section')) secEl[clsOf(e)] = e;
  for (const [cls, s] of Object.entries(spec)) {
    if (!s.leaf || s.decor || !s.section || !s.designVisible || s.inWidget || !secEl[s.section]) continue;
    const el = document.querySelector('.' + cls);
    if (!el || !shown(el)) continue;
    const r = el.getBoundingClientRect(), sr = secEl[s.section].getBoundingClientRect(), sd = spec[s.section]?.box;
    if (r.height < 1 || r.width < 1) continue;
    if (sd && s.box && s.box.y + s.box.h > sd.y + sd.h + 2) continue;
    if (r.bottom > sr.bottom + 4) out.spill.push({ cls, section: s.section, by: Math.round(r.bottom - sr.bottom) });
  }
  // 4K containment: full-bleed background, content at most 1920 wide and centred as in the design.
  // Measured on what is visible: a swipeable strip's off-screen cards are not content width.
  const visX = (el) => {
    const r = el.getBoundingClientRect();
    let x1 = r.left, x2 = r.right;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflowX === 'visible') continue;
      const pr = p.getBoundingClientRect();
      x1 = Math.max(x1, pr.left); x2 = Math.min(x2, pr.right);
    }
    return [x1, x2];
  };
  if (vw >= 1920) {
    for (const sec of sections) {
      const e = secEl[sec.cls];
      if (!e) continue;
      const sr = e.getBoundingClientRect();
      let x1 = Infinity, x2 = -Infinity;
      for (const [cls, s] of Object.entries(spec)) {
        if (s.section !== sec.cls || !s.leaf || s.decor || !['text', 'image', 'button', 'svg'].includes(s.kind)) continue;
        const el = document.querySelector('.' + cls);
        if (!el || !shown(el) || inMarquee(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const [a, b] = visX(el);
        if (b - a < 1) continue;
        x1 = Math.min(x1, a); x2 = Math.max(x2, b);
      }
      if (x1 === Infinity) continue;
      const l = x1 - sr.left, rg = sr.right - x2;
      out.contain.push({ cls: sec.cls, fullBleed: sr.left <= 1 && sr.right >= vw - 1, span: Math.round(x2 - x1), offCentre: Math.round(Math.abs(l - rg - (sec.lD - sec.rD))), height: Math.round(sr.height) });
    }
  }
  return out;
}

// The header stays pinned at the top while the page scrolls (to 50% and to the bottom), above the
// content and slim on small screens; its drawer opens from there, fits or scrolls, and closes again.
export async function stickyScan() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const h = document.querySelector('.f2d-header');
  if (!h) return null;
  const adminTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--wp-admin--admin-bar--height')) || 0;
  const res = { positions: [], compact: false };
  const max = document.documentElement.scrollHeight - innerHeight;
  for (const f of [0.5, 1]) {
    window.scrollTo(0, max * f);
    await wait(120);
    const r = h.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.min(innerWidth - 2, r.left + r.width / 2), Math.max(0, r.top) + Math.min(r.height, 40) / 2);
    res.positions.push({ at: f, top: Math.round(r.top - adminTop), visible: r.height > 0 && r.bottom > 0, onTop: !!hit && h.contains(hit) });
  }
  res.height = Math.round(h.getBoundingClientRect().height);
  res.viewportH = innerHeight;
  const t = document.querySelector('.f2d-menu-toggle');
  if (t && getComputedStyle(t).display !== 'none') {
    res.compact = true;
    const tr = t.getBoundingClientRect();
    res.toggle = { w: Math.round(tr.width), h: Math.round(tr.height) };
    t.click();
    await wait(250);
    const p = document.querySelector('.f2d-menu-panel');
    const pr = p.getBoundingClientRect(), hr = h.getBoundingClientRect();
    res.drawer = { opened: t.getAttribute('aria-expanded') === 'true' && pr.height > 0, inView: pr.left >= -1 && pr.right <= document.documentElement.clientWidth + 1 && pr.top >= -1, fits: hr.bottom <= innerHeight + 1, scrollable: h.scrollHeight > h.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(h).overflowY), height: Math.round(hr.height) };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wait(150);
    res.drawer.reclosed = t.getAttribute('aria-expanded') === 'false';
  }
  window.scrollTo(0, 0);
  await wait(80);
  return res;
}

// Computed style vs expected (catches theme / builder CSS winning over the design).
export function styleConflicts(expect) {
  const out = [];
  const norm = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return String(c).toLowerCase();
    const [r, g, b, a = 1] = m[1].split(',').map((x) => parseFloat(x));
    return `${r},${g},${b},${Math.round(a * 100) / 100}`;
  };
  const hex = (h) => {
    if (!h || !h.startsWith('#')) return norm(h);
    const n = h.slice(1);
    return `${parseInt(n.slice(0, 2), 16)},${parseInt(n.slice(2, 4), 16)},${parseInt(n.slice(4, 6), 16)},1`;
  };
  for (const [cls, e] of Object.entries(expect)) {
    const el = document.querySelector('.' + cls);
    if (!el) continue;
    const target = el.querySelector(':scope > .f2d-tc, :scope > .f2d-para') || el;
    const cs = getComputedStyle(target);
    const csEl = getComputedStyle(el);
    if (e.color && hex(e.color) !== norm(cs.color)) out.push({ cls, prop: 'color', expected: e.color, actual: cs.color });
    if (e.fontSize && Math.abs(parseFloat(csEl.fontSize) - parseFloat(e.fontSize)) > 0.5) out.push({ cls, prop: 'font-size', expected: e.fontSize, actual: csEl.fontSize });
    if (e.family) {
      const first = csEl.fontFamily.split(',')[0].replace(/["']/g, '').trim().toLowerCase();
      if (first !== e.family.toLowerCase()) out.push({ cls, prop: 'font-family', expected: e.family, actual: csEl.fontFamily.slice(0, 60) });
    }
    if (e.lineHeight && e.lineHeight !== 'normal' && Math.abs(parseFloat(csEl.lineHeight) - parseFloat(e.lineHeight)) > 0.5) out.push({ cls, prop: 'line-height', expected: e.lineHeight, actual: csEl.lineHeight });
  }
  return out;
}

// Structural facts from the DOM.
export function structureScan({ sections, texts, buildId }) {
  const out = { sections: [], missingText: [], alteredText: [], duplicates: [], rawShortcodes: false, themeChrome: [], buildMarker: null, bodyClass: document.body.className };
  let lastY = -1;
  for (const s of sections) {
    const el = document.querySelector('.' + s.cls);
    const r = el?.getBoundingClientRect();
    out.sections.push({ cls: s.cls, name: s.name, present: !!el, y: r ? r.top + scrollY : null, h: r ? r.height : null, inOrder: r ? r.top + scrollY >= lastY - 1 : false });
    if (r) lastY = r.top + scrollY;
  }
  // innerText keeps <br> as a line break; quotes are compared by shape-independent form.
  const norm = (t) => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
  const exact = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const t of texts) {
    const el = document.querySelector('.' + t.cls);
    if (!el) out.missingText.push({ cls: t.cls, text: t.text.slice(0, 60), reason: 'element missing' });
    else if (!norm(el.innerText).includes(norm(t.text).slice(0, 40))) out.missingText.push({ cls: t.cls, text: t.text.slice(0, 60), got: el.innerText.trim().slice(0, 60), reason: 'text differs' });
    else if (!exact(el.innerText).includes(exact(t.text).slice(0, 40))) out.alteredText.push({ cls: t.cls, text: t.text.slice(0, 60), got: el.innerText.trim().slice(0, 60) });
  }
  const seen = {};
  // (aria-hidden copies are deliberate: a ticker's looping copy, an accordion's closed-state icon)
  for (const el of document.querySelectorAll('[class*="f2d-"]')) if (!el.closest('[aria-hidden="true"]')) for (const c of el.classList) if (/^f2d-[0-9a-f]{8}$/.test(c)) seen[c] = (seen[c] || 0) + 1;
  out.duplicates = Object.entries(seen).filter(([, n]) => n > 1).map(([c, n]) => ({ cls: c, n }));
  out.rawShortcodes = /\[\/?et_pb_[a-z_]+/.test(document.body.innerText);
  // Markup the CMS injected into generated content (wpautop & co): empty <p>, stray <br> between blocks.
  const injected = [];
  for (const host of document.querySelectorAll('.f2d-frag-host, .et_pb_text.f2d-el')) {
    for (const p of host.querySelectorAll('p:not([class])')) if (!p.textContent.trim()) injected.push('empty <p> in ' + (p.parentElement?.className || '').toString().slice(0, 40));
    for (const br of host.querySelectorAll('br')) if (!br.closest('[class*="f2d-tc"], .f2d-para')) injected.push('<br> outside text in ' + (br.parentElement?.className || '').toString().slice(0, 40));
  }
  out.injected = injected;
  for (const sel of ['header.wp-block-template-part', 'footer.wp-block-template-part', '.wp-site-blocks > header', '.wp-site-blocks > footer']) if (document.querySelector(sel)) out.themeChrome.push(sel);
  out.buildMarker = getComputedStyle(document.body).getPropertyValue('--f2d-build').replace(/["'\s]/g, '') || null;
  out.images = [...document.images].map((im) => {
    const r = im.getBoundingClientRect();
    const raster = !/\.svg(\?|$)/i.test(im.currentSrc);
    // Upscale factor: how far the bitmap is stretched beyond its natural pixels (object-fit cover
    // crops, so use the larger of the two axis ratios).
    const up = raster && im.naturalWidth ? Math.max(r.width / im.naturalWidth, r.height / im.naturalHeight) : 0;
    return { cls: [...im.classList].find((c) => /^f2d-/.test(c)) || null, ok: im.complete && im.naturalWidth > 0, src: im.currentSrc.slice(-60), w: Math.round(r.width), upscale: Math.round(up * 100) / 100 };
  });
  return out;
}

// Every rendered element we generated, as a box relative to the page frame (Divi's content wrapper),
// so the front end and the Visual Builder (which adds its own wrappers and chrome) compare directly.
// Elements without a box of their own (display: contents, not rendered) report no position.
export function layoutSnapshot() {
  const root = document.querySelector('.et_builder_inner_content');
  if (!root) return null;
  const R = root.getBoundingClientRect();
  const boxes = {};
  const seen = {};
  for (const el of document.querySelectorAll('[class*="f2d-"]')) {
    const m = el.className.toString().match(/\bf2d-[0-9a-f]{8}(?:-[a-z]+(?:-[a-z]+)?)?\b/);
    if (!m) continue;
    if (getComputedStyle(el).display === 'contents' || !el.getClientRects().length) continue;
    seen[m[0]] = (seen[m[0]] || 0) + 1;
    const r = el.getBoundingClientRect();
    boxes[seen[m[0]] > 1 ? `${m[0]}#${seen[m[0]]}` : m[0]] = [Math.round(r.left - R.left), Math.round(r.top - R.top), Math.round(r.width), Math.round(r.height)];
  }
  return { boxes, height: Math.round(R.height), sections: document.querySelectorAll('.f2d-section').length, width: document.documentElement.clientWidth };
}

// Interactive elements: links/buttons resolvable, not covered, focusable.
export function interactionScan() {
  const out = [];
  for (const a of document.querySelectorAll('a[class*="f2d-"], a.et_pb_button')) {
    const r = a.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cls = [...a.classList].find((c) => /^f2d-[0-9a-f]{8}$/.test(c));
    a.scrollIntoView({ block: 'center' });
    const r2 = a.getBoundingClientRect();
    const hit = document.elementFromPoint(r2.left + r2.width / 2, r2.top + r2.height / 2);
    const covered = !(hit && (hit === a || a.contains(hit)));
    out.push({ cls, href: a.getAttribute('href'), covered, coveredBy: covered && hit ? (hit.className?.toString() || hit.tagName).slice(0, 60) : null, tabIndex: a.tabIndex, text: a.textContent.trim().slice(0, 40) });
  }
  window.scrollTo(0, 0);
  return out;
}

// Runtime components (menu, accordion, slider, ticker) operated like a visitor: click, look, restore.
// Runs in the page. Each component's mode comes from the page itself: the menu is compact where its
// button shows (a breakpoint computed per design), the slider pages at the tablet breakpoint.
export async function componentChecks() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => !!el && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
  const out = [];
  const t = document.querySelector('.f2d-menu-toggle');
  const p = document.querySelector('.f2d-menu-panel');
  const compact = !!t && vis(t);
  if (p) {
    if (compact) {
      const closed = !vis(p) && vis(t);
      t.click();
      await wait(250);
      const opened = vis(p) && t.getAttribute('aria-expanded') === 'true';
      const r = p.getBoundingClientRect();
      const inView = r.left >= -1 && r.right <= document.documentElement.clientWidth + 1;
      const links = [...p.querySelectorAll('.f2d-menu-links > *')].filter(vis).length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await wait(150);
      const reclosed = !vis(p) && t.getAttribute('aria-expanded') === 'false';
      out.push({ c: 'menu', ok: closed && opened && inView && links > 0 && reclosed, detail: { closed, opened, inView, links, reclosed } });
    } else if (!window.matchMedia('(max-width: 980px)').matches) out.push({ c: 'menu', ok: vis(p), detail: { barVisible: vis(p) } });
    else out.push({ c: 'menu', ok: false, detail: { toggle: 'no menu button below the tablet breakpoint' } });
  }
  [...document.querySelectorAll('.f2d-acc-item')].forEach((item, i) => item.dataset.f2dI = i);
  for (const item of document.querySelectorAll('.f2d-acc-item')) {
    const head = item.querySelector('.f2d-acc-head');
    const panel = item.querySelector('.f2d-acc-panel');
    if (!head || !panel) continue;
    head.scrollIntoView({ block: 'center' });
    const before = vis(panel) && head.getAttribute('aria-expanded') === 'true';
    head.click();
    await wait(120);
    const closed = !vis(panel) && head.getAttribute('aria-expanded') === 'false';
    head.click();
    await wait(120);
    const back = vis(panel);
    out.push({ c: 'accordion', i: +item.dataset.f2dI, ok: before && closed && back, detail: { before, closed, back } });
  }
  for (const s of document.querySelectorAll('.f2d-slider')) {
    const slides = [...s.querySelectorAll('.f2d-slide')];
    const next = s.querySelector('.f2d-slider-next');
    const prev = s.querySelector('.f2d-slider-prev');
    if (window.matchMedia('(max-width: 980px)').matches) {
      const v0 = slides.map(vis);
      next?.click();
      await wait(120);
      const v1 = slides.map(vis);
      prev?.click();
      await wait(120);
      const v2 = slides.map(vis);
      const ok = v0[0] && v0.filter(Boolean).length === 1 && v1[1] && !v1[0] && v2[0] && vis(next) && vis(prev);
      out.push({ c: 'slider', ok, detail: { start: v0, afterNext: v1, afterPrev: v2, controls: vis(next) && vis(prev) } });
    } else out.push({ c: 'slider', ok: slides.every(vis), detail: { allVisible: slides.every(vis) } });
  }
  for (const m of document.querySelectorAll('.f2d-marquee')) {
    const r = m.getBoundingClientRect();
    out.push({ c: 'marquee', ok: r.height > 0 && r.height < 400 && m.scrollWidth > m.clientWidth, detail: { height: Math.round(r.height), oneRow: r.height < 400 } });
  }
  window.scrollTo(0, 0);
  return out;
}
