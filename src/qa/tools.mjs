// Evidence instruments for the f2d-qa agent (the DEV Connect QA model: the agent judges, these only
// capture and measure). Nothing here decides whether a section is good; every command writes files
// the agent looks at and prints JSON it reads.
//
//   shot     one section (or the drawer) at one width: the built crop, the Figma crop at a design
//            width, a red-highlight diff and a side-by-side (compare_screenshots.py semantics)
//   measure  one section at one width: built boxes + computed styles vs the IR's own numbers
//   sweep    one section at every width and rotation: labelled contact sheets + measured hints
//   check    objective functional checks (render, assets, links, forms, components, sticky header,
//            drawer, overflow) — these may block a verdict; they are facts, not visual judgement
//   state    the agent's section-qa-state.json: init from the build, validate before a verdict
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { readJson, readJsonIf, writeJson, ensureDir, round, F2DError } from '../util/core.mjs';
import { ws, loadState } from '../workspace.mjs';
import { viewportMatrix } from '../planner/plan.mjs';
import { launch, scrollbarWidth, capture, release } from './render.mjs';
import { readPng, writePng, crop, flatten, downscale, sideBySide } from './compare.mjs';
import { buildSpec } from './suite.mjs';
import { responsiveScan, uxScan, stickyScan, componentChecks, structureScan, interactionScan, layoutSnapshot } from './checks.mjs';
import { parseShortcodes } from '../pipeline/build.mjs';
import * as WP from '../wp/client.mjs';

// ---------- context ----------
export function qaContext(cfg, slug) {
  const w = ws(cfg, slug);
  const st = loadState(w);
  if (!st.post?.previewUrl) throw new F2DError('E_NOT_DEPLOYED', 'Nothing deployed yet — run "f2d deploy" first');
  const buildId = st.deployed?.at(-1)?.buildId;
  if (!buildId) throw new F2DError('E_NOT_DEPLOYED', 'No deployed build recorded');
  const ir = readJson(w.ir);
  const layout = readJson(path.join(w.build(buildId), 'layout.json'));
  const spec = buildSpec(ir, layout);
  const sections = Object.values(ir.nodes).filter((n) => n.a.role === 'section').sort((a, b) => a.a.sectionIndex - b.a.sectionIndex)
    .map((n) => ({ index: n.a.sectionIndex, name: n.name, slug: `${String(n.a.sectionIndex).padStart(2, '0')}-${n.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, cls: n.cls, id: n.id, header: !!n.a.header, box: n.box }));
  const frame = ir.frames[0];
  const cssFile = path.join(w.build(buildId), 'divi', 'page.css');
  const css = fs.existsSync(cssFile) ? fs.readFileSync(cssFile, 'utf8') : '';
  const breakpoints = [...new Set([...css.matchAll(/@media \((?:max|min)-width: (\d+)px\)/g)].map((m) => +m[1]))];
  const matrix = viewportMatrix(cfg, ir, { breakpoints });
  const dir = ensureDir(path.join(w.root, 'qa', 'agent', buildId));
  const refDir = ensureDir(path.join(w.root, 'qa', 'reference'));
  return { cfg, w, st, url: st.post.previewUrl, buildId, ir, layout, spec, sections, frame, FW: frame.width, matrix, dir, refDir, mode: matrix.scrollbarModes[0] };
}

const sectionOf = (C, s) => {
  const sec = s === 'page' ? null : C.sections.find((x) => x.index === Number(s));
  if (s !== 'page' && !sec) throw new F2DError('E_NO_SECTION', `No section ${s} (0–${C.sections.length - 1})`);
  return sec;
};
const vpName = (w, h) => `${w}${h ? 'x' + h : ''}`;
const rel = (C, f) => path.relative(C.w.root, f).split(path.sep).join('/');

// ---------- capture ----------
// Open the page at a window width; `match: 'page'` widens the window by the scrollbar so the page
// itself is exactly the design width (Windows classic scrollbars).
async function openPage(C, browser, sb, width, height, design) {
  return capture(browser, C.url, { width, height: height || C.matrix.height, match: design ? 'page' : 'window', scrollbar: sb, collect: false, settleOpts: { assetTimeoutMs: C.cfg.qa.assetTimeoutMs, settleMs: C.cfg.qa.settleMs } });
}

// A document-space region shot at the real viewport size (no full-page resize, which would drop the
// classic scrollbar and re-lay the page 15–17px wider): scroll, shoot the viewport, stitch. The sticky
// header is shot in its place in the flow, so it is not stamped into every section below it.
async function shootRegion(page, y, h) {
  const vp = page.viewportSize();
  const W = await page.evaluate(() => document.documentElement.clientWidth);
  await page.evaluate(() => { for (const e of document.querySelectorAll('body *')) if (getComputedStyle(e).position === 'sticky') (e.dataset.f2dSticky = e.style.position || '-'), (e.style.position = 'relative'); });
  // (clamped to the document: the last section must not be padded with rows past the page end)
  const docH = await page.evaluate(() => document.documentElement.scrollHeight);
  const Y = Math.max(0, Math.round(y)), H = Math.max(1, Math.min(Math.round(h), docH - Y));
  const out = new PNG({ width: W, height: H });
  for (let t = Y; t < Y + H; ) {
    const actual = await page.evaluate((t) => { window.scrollTo(0, t); return Math.round(window.scrollY); }, t);
    await page.waitForTimeout(80);
    const seg = PNG.sync.read(await page.screenshot({ animations: 'disabled', caret: 'hide' }));
    const from = t - actual; // rows of this segment that belong to the region
    const rows = Math.min(vp.height - from, Y + H - t);
    if (rows <= 0) break;
    for (let r = 0; r < rows; r++) seg.data.copy(out.data, (t - Y + r) * W * 4, (from + r) * seg.width * 4, ((from + r) * seg.width + Math.min(W, seg.width)) * 4);
    t += rows;
  }
  await page.evaluate(() => { for (const e of document.querySelectorAll('[data-f2d-sticky]')) (e.style.position = e.dataset.f2dSticky === '-' ? '' : e.dataset.f2dSticky), delete e.dataset.f2dSticky; window.scrollTo(0, 0); });
  return out;
}

// What a section paints: its own box plus anything hanging out of it vertically (a header's logo
// and nav bar overlapping the hero), so the crop shows the whole section as a visitor sees it.
const rectOf = (page, cls) => page.evaluate((c) => {
  const e = document.querySelector('.' + c);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  let y1 = r.top, y2 = r.bottom;
  // (decoration is aria-hidden; what a clipping container hides is not painted)
  const walk = (x) => {
    for (const k of x.children) {
      if (k.getAttribute('aria-hidden') === 'true') continue;
      const cs = getComputedStyle(k);
      if (cs.display === 'none') continue;
      const q = k.getBoundingClientRect();
      if (q.width >= 1 && q.height >= 1 && cs.visibility !== 'hidden') (y1 = Math.min(y1, q.top)), (y2 = Math.max(y2, q.bottom));
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') walk(k);
    }
  };
  walk(e);
  return { x: r.left, y: y1 + scrollY, w: r.width, h: y2 - y1, own: { y: r.top + scrollY, h: r.height } };
}, cls);
// The same extent in the design: the section box plus its descendants' boxes (non-decor, in frame).
const designExtent = (C, sec) => {
  let y1 = sec.box.y, y2 = sec.box.y + sec.box.h;
  const walk = (id) => { for (const k of C.ir.nodes[id].children) { const n = C.ir.nodes[k]; if (!n.a.decor && n.box.h > 0) (y1 = Math.min(y1, n.box.y)), (y2 = Math.max(y2, n.box.y + n.box.h)); walk(k); } };
  walk(sec.id);
  return { y: Math.max(0, y1), h: Math.min(C.frame.height, y2) - Math.max(0, y1) };
};

// ---------- compare (compare_screenshots.py semantics: per-channel difference > 24 = mismatch) ----------
const CHANNEL_DIFF_THRESHOLD = 24;
export function pixelCompare(ref, built, { shift = 0 } = {}) {
  const w = Math.min(ref.width, built.width);
  const h = Math.min(ref.height, built.height - Math.max(0, shift), ref.height + Math.min(0, shift));
  let mismatched = 0;
  const mask = new Uint8Array(Math.max(0, w * h));
  for (let y = 0; y < h; y++) {
    const ry = shift < 0 ? y - shift : y, by = shift > 0 ? y + shift : y;
    for (let x = 0; x < w; x++) {
      const i = (ry * ref.width + x) * 4, j = (by * built.width + x) * 4;
      const d = Math.max(Math.abs(ref.data[i] - built.data[j]), Math.abs(ref.data[i + 1] - built.data[j + 1]), Math.abs(ref.data[i + 2] - built.data[j + 2]));
      if (d > CHANNEL_DIFF_THRESHOLD) (mismatched++, (mask[y * w + x] = 1));
    }
  }
  const total = w * h;
  return { similarity_pct: total ? round(100 * (1 - mismatched / total), 2) : 0, mismatched_pixels: mismatched, total_pixels: total, mask, w, h };
}
function diffImage(ref, m) {
  const img = new PNG({ width: m.w, height: m.h });
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    const i = (y * m.w + x) * 4, j = (y * ref.width + x) * 4;
    if (m.mask[y * m.w + x]) (img.data[i] = 255), (img.data[i + 1] = 0), (img.data[i + 2] = 0);
    else (img.data[i] = ref.data[j]), (img.data[i + 1] = ref.data[j + 1]), (img.data[i + 2] = ref.data[j + 2]);
    img.data[i + 3] = 255;
  }
  return img;
}

// Figma crop of a section at the design width (1×, the frame's own screenshot).
export function referenceCrop(C, sec) {
  const shot = C.frame.screenshot?.path;
  if (!shot || !fs.existsSync(shot)) return null;
  const file = path.join(C.refDir, `${sec ? sec.slug : 'page'}-${C.FW}.png`);
  if (!fs.existsSync(file)) {
    const ref = flatten(readPng(shot));
    const ex = sec && designExtent(C, sec);
    const img = sec ? crop(ref, 0, Math.round(ex.y), ref.width, Math.round(ex.h)) : ref;
    writePng(file, img);
  }
  return file;
}

// ---------- shot ----------
export async function shot(cfg, slug, { section = 'page', width, height = null, openMenu = false } = {}) {
  const C = qaContext(cfg, slug);
  const sec = sectionOf(C, section);
  const W = Number(width || C.FW);
  const design = W === C.FW && !height;
  const browser = await launch(C.mode);
  try {
    const sb = await scrollbarWidth(browser);
    const r = await openPage(C, browser, sb, W, height, design);
    if (r.navError) throw new F2DError('E_RENDER', `Page failed to render: ${r.navError}`);
    const p = r.page;
    const vp = vpName(W, height);
    const base = path.join(ensureDir(path.join(C.dir, 'shots')), `${sec ? sec.slug : 'page'}-${vp}`);
    const metrics = await p.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, docHeight: document.documentElement.scrollHeight }));
    const out = { section: sec ? { index: sec.index, name: sec.name } : 'page', width: W, height: height || C.matrix.height, buildId: C.buildId, overflowX: metrics.scrollWidth - metrics.clientWidth, ...metrics };
    if (openMenu) {
      const t = await p.$('.f2d-menu-toggle');
      const visible = t && (await t.evaluate((e) => getComputedStyle(e).display !== 'none'));
      if (!visible) out.drawer = { error: 'no menu button at this width (the bar is shown)' };
      else {
        await t.click();
        await p.waitForTimeout(300);
        const file = `${base}-drawer-open.png`;
        await p.screenshot({ path: file, animations: 'disabled' });
        out.drawer = { file: rel(C, file), state: await p.evaluate(() => { const h = document.querySelector('.f2d-header'); const pn = document.querySelector('.f2d-menu-panel'); const r = pn?.getBoundingClientRect(); return { expanded: document.querySelector('.f2d-menu-toggle')?.getAttribute('aria-expanded'), panel: r && { top: Math.round(r.top), h: Math.round(r.height) }, header: h && { h: Math.round(h.getBoundingClientRect().height), scrollable: h.scrollHeight > h.clientHeight + 1 } }; }) };
      }
      await release(r);
      return out;
    }
    const rect = sec ? await rectOf(p, sec.cls) : { x: 0, y: 0, w: metrics.clientWidth, h: metrics.docHeight };
    if (!rect) throw new F2DError('E_NO_SECTION', `Section "${sec.name}" (.${sec.cls}) is not on the page`);
    const built = await shootRegion(p, rect.y, rect.h);
    await release(r);
    writePng(`${base}-built.png`, built);
    Object.assign(out, { box: { y: Math.round(rect.y), h: Math.round(rect.h), w: Math.round(rect.w) }, built: rel(C, `${base}-built.png`) });
    if (design) {
      const refFile = referenceCrop(C, sec);
      if (!refFile) out.reference = null;
      else {
        const ref = readPng(refFile);
        const m = pixelCompare(ref, built);
        writePng(`${base}-diff.png`, diffImage(ref, m));
        writePng(`${base}-side.png`, downscale(sideBySide(ref, built), Math.min(1, 1800 / (ref.width + built.width + 8))));
        // A section sitting a few px lower shifts every pixel below it: the best vertical alignment
        // within ±16px is reported too (and which shift it took), as the DEV Connect qa agent does.
        let best = { shift: 0, similarity_pct: m.similarity_pct };
        for (let s = -16; s <= 16; s += 2) if (s) { const k = pixelCompare(ref, built, { shift: s }); if (k.similarity_pct > best.similarity_pct) best = { shift: s, similarity_pct: k.similarity_pct }; }
        Object.assign(out, { reference: rel(C, refFile), diff: rel(C, `${base}-diff.png`), side: rel(C, `${base}-side.png`), similarity_pct: m.similarity_pct, mismatched_pixels: m.mismatched_pixels, total_pixels: m.total_pixels, original_size: [ref.width, ref.height], built_size: [built.width, built.height], size_mismatch: ref.width !== built.width || Math.abs(ref.height - built.height) > 2, best_alignment: best });
      }
    }
    return out;
  } finally {
    await browser.close();
  }
}

// ---------- measure ----------
export async function measure(cfg, slug, { section, width, nodes = null } = {}) {
  const C = qaContext(cfg, slug);
  const sec = sectionOf(C, section);
  if (!sec) throw new F2DError('E_ARGS', 'measure needs --section N');
  const W = Number(width || C.FW);
  const N = C.ir.nodes;
  const want = nodes ? String(nodes).split(',').map((s) => s.trim().toLowerCase()) : null;
  const members = Object.entries(C.spec).filter(([cls, s]) => s.section === sec.cls && cls !== sec.cls && (!want || want.some((q) => cls.includes(q) || (N[s.id]?.name || '').toLowerCase().includes(q) || s.id === q)));
  const browser = await launch(C.mode);
  try {
    const sb = await scrollbarWidth(browser);
    const r = await openPage(C, browser, sb, W, null, W === C.FW);
    const built = await r.page.evaluate(({ secCls, list }) => {
      const s = document.querySelector('.' + secCls).getBoundingClientRect();
      const out = { __section: { w: Math.round(s.width), h: Math.round(s.height), y: Math.round(s.top + scrollY) }, __doc: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth } };
      for (const cls of list) {
        const e = [...document.querySelectorAll('.' + cls)].find((x) => !x.closest('[aria-hidden="true"]')) || document.querySelector('.' + cls);
        if (!e) { out[cls] = null; continue; }
        const r = e.getBoundingClientRect(), c = getComputedStyle(e);
        const t = e.querySelector(':scope > .f2d-tc, :scope .f2d-tc') || e;
        const tc = getComputedStyle(t);
        out[cls] = { x: +(r.left - s.left).toFixed(1), y: +(r.top - s.top).toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), shown: c.display !== 'none' && c.visibility !== 'hidden' && r.width > 0, font: `${tc.fontFamily.split(',')[0].replace(/["']/g, '')} ${tc.fontSize}/${tc.lineHeight} w${tc.fontWeight} ls${tc.letterSpacing}`, color: tc.color, bg: c.backgroundColor !== 'rgba(0, 0, 0, 0)' ? c.backgroundColor : (c.backgroundImage !== 'none' ? 'image/gradient' : null), pad: c.padding, gap: c.gap, radius: c.borderRadius, display: c.display, flex: c.flex, position: c.position, text: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) };
      }
      return out;
    }, { secCls: sec.cls, list: members.map(([c]) => c) });
    await release(r);
    const isDesign = W === C.FW;
    const rows = members.map(([cls, s]) => {
      const n = N[s.id];
      const b = built[cls];
      const d = n && { x: round(n.box.x - sec.box.x, 1), y: round(n.box.y - sec.box.y, 1), w: round(n.box.w, 1), h: round(n.box.h, 1) };
      const run = n?.text?.runs?.[0];
      const design = n && { ...d, ...(run ? { font: `${run.family} ${run.size}px/${run.lineHeight ? round(run.lineHeight, 1) + 'px' : 'auto'} w${run.weight} ls${run.letterSpacing ?? 0}`, color: run.color } : {}), ...(n.layout ? { pad: n.layout.padding.join(' '), gap: n.layout.gap } : {}), ...(n.fills?.[0]?.color ? { fill: n.fills[0].color } : {}), ...(n.radius ? { radius: n.radius } : {}) };
      const delta = isDesign && b && d ? { x: round(b.x - d.x, 1), y: round(b.y - d.y, 1), w: round(b.w - d.w, 1), h: round(b.h - d.h, 1) } : null;
      return { cls, name: n?.name?.slice(0, 50), kind: s.kind, decor: s.decor || undefined, built: b, design: isDesign ? design : { w: d?.w, h: d?.h }, delta };
    }).sort((a, b) => (b.delta ? Math.max(...Object.values(b.delta).map(Math.abs)) : 0) - (a.delta ? Math.max(...Object.values(a.delta).map(Math.abs)) : 0));
    const res = { section: { index: sec.index, name: sec.name, design: { w: sec.box.w, h: sec.box.h }, built: built.__section }, width: W, buildId: C.buildId, overflowX: built.__doc.scrollWidth - built.__doc.clientWidth, note: isDesign ? 'boxes are section-relative; delta = built − design' : 'not a design width: no design deltas (only the built values)', elements: rows };
    const file = path.join(ensureDir(path.join(C.dir, 'measure')), `${sec.slug}-${W}.json`);
    writeJson(file, res);
    return { ...res, file: rel(C, file) };
  } finally {
    await browser.close();
  }
}

// ---------- sweep ----------
// One page load (images settled once), then every width/rotation by resizing: the section is shot at
// each, thumbnails go onto labelled contact sheets, and the measured hints for that section are listed.
export async function sweep(cfg, slug, { section, widths = null } = {}) {
  const C = qaContext(cfg, slug);
  const sec = sectionOf(C, section);
  if (!sec) throw new F2DError('E_ARGS', 'sweep needs --section N');
  let cells = C.matrix.cells.map((c) => ({ width: c.width, height: c.height || null }));
  if (widths) cells = String(widths).split(',').map((v) => { const [a, b] = v.split('x').map(Number); return { width: a, height: b || null }; });
  const outDir = ensureDir(path.join(C.dir, 'sweep', sec.slug));
  const browser = await launch(C.mode);
  const results = [];
  try {
    const sb = await scrollbarWidth(browser);
    const first = cells[0];
    const r = await openPage(C, browser, sb, first.width, first.height, false);
    const p = r.page;
    for (const cell of cells) {
      const vp = vpName(cell.width, cell.height);
      await p.setViewportSize({ width: cell.width, height: cell.height || C.matrix.height });
      await p.waitForTimeout(250);
      await p.evaluate(() => Promise.race([Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((res) => { i.onload = i.onerror = res; }))), new Promise((res) => setTimeout(res, 3000))]));
      const rect = await rectOf(p, sec.cls);
      if (!rect || rect.h < 1) { results.push({ vp, missing: true }); continue; }
      const img = await shootRegion(p, rect.y, rect.h);
      const file = path.join(outDir, `${vp}.png`);
      writePng(file, img);
      // Measured hints for this section only — what the agent should look at, not a verdict.
      const rs = await p.evaluate(responsiveScan, C.spec);
      const ux = await p.evaluate(uxScan, { spec: C.spec, sections: [], frameW: C.FW });
      const mine = (l) => l.filter((x) => (C.spec[x.cls || x.a]?.section || x.section) === sec.cls);
      const hints = {
        overflowX: rs.overflowX,
        overlaps: mine(rs.overlaps).map((o) => `${C.ir.nodes[C.spec[o.a]?.id]?.name} × ${C.ir.nodes[C.spec[o.b]?.id]?.name} (${Math.round(o.frac * 100)}%)`),
        cut: mine(rs.cut).map((c) => `${C.ir.nodes[C.spec[c.cls]?.id]?.name} ${Math.round(c.visible * 100)}% visible`),
        covered: mine(rs.covered).map((c) => `${C.ir.nodes[C.spec[c.cls]?.id]?.name} under ${C.ir.nodes[C.spec[c.by]?.id]?.name}`),
        brokenWords: mine(rs.brokenWords).map((b) => `"${b.word}" ${b.wordW}px in ${b.boxW}px`),
        spill: mine(rs.spill).map((c) => C.ir.nodes[C.spec[c.cls]?.id]?.name),
        tap: mine(ux.tap).map((t) => `${t.text || t.cls} ${t.w}×${t.h}`),
        orphans: mine(ux.orphans).map((o) => `"${o.text}" → "${o.word}"`),
        uneven: mine(ux.uneven).map((u) => u.heights.join('/')),
        lonely: mine(ux.lonely).length,
        distorted: mine(ux.distorted).map((d) => C.ir.nodes[C.spec[d.cls]?.id]?.name),
        zeroHeight: mine(ux.zero).map((z) => C.ir.nodes[C.spec[z.cls]?.id]?.name),
        sectionSpill: ux.spill.filter((x) => x.section === sec.cls).map((x) => `${C.ir.nodes[C.spec[x.cls]?.id]?.name} +${x.by}px`),
        cramped: mine(ux.cramped).length,
      };
      for (const k of Object.keys(hints)) if (Array.isArray(hints[k]) ? !hints[k].length : !hints[k]) delete hints[k];
      if (sec.header && (cell.height || [C.FW, 1024, 768, 390].includes(cell.width))) hints.sticky = await p.evaluate(stickyScan);
      results.push({ vp, file: rel(C, file), h: img.height, hints });
    }
    // Contact sheets: thumbnails with their viewport label, rendered by the browser.
    const shots = results.filter((x) => x.file);
    const sheets = [];
    const per = 8;
    for (let k = 0; k < shots.length; k += per) {
      const group = shots.slice(k, k + per);
      const tiles = group.map((s) => {
        const img = readPng(path.join(C.w.root, s.file));
        const tw = img.width >= 1200 ? 620 : 300; // desktop shots big enough to read
        const t = downscale(img, Math.min(1, tw / img.width));
        const tall = t.height > 1400 ? crop(t, 0, 0, t.width, 1400) : t;
        return { vp: s.vp, tw: t.width, src: 'data:image/png;base64,' + PNG.sync.write(tall).toString('base64'), cut: t.height > 1400, w: img.width, hints: Object.keys(s.hints || {}).filter((h) => h !== 'sticky').join(', ') };
      });
      await p.setViewportSize({ width: 1600, height: 900 });
      await p.setContent(`<html><body style="margin:0;padding:12px;background:#d9dde3;font:13px system-ui;display:flex;gap:12px;align-items:flex-start;align-content:flex-start;flex-wrap:wrap">${tiles.map((t) => `<figure style="margin:0;width:${t.tw}px;background:#fff;padding:6px;box-shadow:0 1px 3px #0003"><figcaption style="font-weight:700;padding-bottom:4px">${t.vp}px <span style="font-weight:400;color:#555">(page ${t.w})</span>${t.hints ? `<div style="color:#b00;font-weight:400">hints: ${t.hints}</div>` : ''}</figcaption><img src="${t.src}" style="display:block;width:100%">${t.cut ? '<div style="color:#555">… cut for the sheet (full shot on disk)</div>' : ''}</figure>`).join('')}</body></html>`);
      const file = path.join(outDir, `sheet-${k / per + 1}.png`);
      await p.screenshot({ path: file, fullPage: true });
      sheets.push(rel(C, file));
    }
    await release(r);
    const res = { section: { index: sec.index, name: sec.name }, buildId: C.buildId, cells: results.length, sheets, results, note: 'hints are measurements to look at, not a verdict' };
    writeJson(path.join(outDir, 'sweep.json'), res);
    return { ...res, file: rel(C, path.join(outDir, 'sweep.json')) };
  } finally {
    await browser.close();
  }
}

// ---------- editor parity ----------
// The Divi Visual Builder renders the same shortcodes with its own wrappers, CSS and wpautop markup.
// Every rendered element must sit where it does on the front end as a visitor sees it: in the
// builder's desktop view at the design width, and in its own tablet and phone views. The builder's
// views are switched with its own toolbar buttons (a narrow window makes it pick a preview by itself).
const BUILDER_VIEWS = [
  { name: 'desktop', tip: null, index: 3 },
  { name: 'tablet', tip: 'Tablet View', index: 4 },
  { name: 'phone', tip: 'Phone View', index: 5 },
];

async function scrollThrough(page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += 700) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    scrollTo(0, 0);
  });
}

function compareLayouts(front, editor) {
  const off = [];
  for (const [k, a] of Object.entries(front.boxes)) {
    const b = editor.boxes[k];
    if (!b) off.push(`${k} missing in the builder`);
    else if (a.some((v, i) => Math.abs(v - b[i]) > 2)) off.push(`${k} [x,y,w,h] ${a.join(',')} → ${b.join(',')}`);
  }
  return off;
}

async function editorParity(C, browser, sb, add) {
  let session;
  try {
    session = await WP.editorSession(C.cfg, C.st.post.id);
  } catch (e) {
    add('editor.parity', false, 'major', `could not open the Visual Builder: ${e.message.slice(0, 200)} (the site needs f2d-bridge ≥ 0.3.1)`);
    return;
  }
  const report = { views: [] };
  const vbCtx = await browser.newContext({ viewport: { width: C.FW + sb, height: C.matrix.height }, reducedMotion: 'reduce' });
  const visitor = await browser.newContext({ viewport: { width: C.FW + sb, height: C.matrix.height }, reducedMotion: 'reduce' });
  try {
    await vbCtx.addCookies(session.cookies.map((c) => ({ name: c.name, value: c.value, domain: session.domain, path: c.path, secure: session.secure, httpOnly: true, expires: session.expires })));
    const vb = await vbCtx.newPage();
    await vb.goto(session.url, { waitUntil: 'networkidle', timeout: 180000 });
    let frame = null;
    for (let i = 0; i < 120 && !frame; i++) {
      frame = vb.frames().find((f) => f.name() === 'et-fb-app-frame') || null;
      if (!frame) await vb.waitForTimeout(500);
    }
    if (!frame) throw new Error('the builder did not open (no et-fb-app-frame)');
    await frame.waitForSelector('.f2d-section', { timeout: 120000 });
    await vb.waitForTimeout(C.cfg.qa.settleMs || 1500);
    const front = await visitor.newPage();
    await front.goto(C.url, { waitUntil: 'networkidle', timeout: 120000 });
    for (const view of BUILDER_VIEWS) {
      if (view.tip) {
        const opened = await vb.$('.et-fb-page-settings-bar__toggle-button.et-fb-button--active');
        if (!opened) await vb.click('.et-fb-page-settings-bar__toggle-button');
        await vb.waitForTimeout(800);
        const btn = (await vb.$(`[class*=page-settings-bar] button[data-tip="${view.tip}"]`)) || (await vb.$$('[class*=page-settings-bar] button.et-fb-button--inverse'))[view.index];
        if (!btn) {
          add(`editor.parity@${view.name}`, false, 'major', 'the builder\'s view buttons were not found');
          continue;
        }
        await btn.click();
        await vb.waitForTimeout(3000);
      }
      // Previews grow the frame and render sections as the outer window scrolls: until stable.
      let n = -1;
      for (let i = 0, stable = 0; i < 40 && stable < 3; i++) {
        await scrollThrough(vb);
        await scrollThrough(frame);
        await vb.waitForTimeout(500);
        const m = await frame.evaluate(() => document.querySelectorAll('.f2d-section').length);
        stable = m === n ? stable + 1 : 0;
        n = m;
      }
      await vb.waitForTimeout(1000);
      const editor = await frame.evaluate(layoutSnapshot);
      // The front end at the same content width (the builder's frame has its own scrollbar or none).
      await front.setViewportSize({ width: editor.width + sb, height: C.matrix.height });
      const cw = await front.evaluate(() => document.documentElement.clientWidth);
      if (cw !== editor.width) await front.setViewportSize({ width: editor.width + sb + editor.width - cw, height: C.matrix.height });
      await scrollThrough(front);
      await front.waitForTimeout(1000);
      const visitorView = await front.evaluate(layoutSnapshot);
      const off = compareLayouts(visitorView, editor);
      const ok = !off.length && editor.sections === visitorView.sections && Math.abs(editor.height - visitorView.height) <= 2;
      const detail = { width: editor.width, elements: Object.keys(visitorView.boxes).length, sections: [visitorView.sections, editor.sections], height: [visitorView.height, editor.height], mismatches: off.length, first: off.slice(0, 8) };
      report.views.push({ view: view.name, ...detail, all: off });
      add(`editor.parity@${view.name}-${editor.width}`, ok, 'major', detail);
    }
  } catch (e) {
    add('editor.parity', false, 'major', `Visual Builder check failed: ${e.message.slice(0, 240)}`);
  } finally {
    writeJson(path.join(C.dir, 'editor-parity.json'), report);
    await vbCtx.close();
    await visitor.close();
  }
}

// ---------- functional check ----------
// Objective facts that hold or not regardless of taste; a failure here blocks a PASS verdict.
export async function functionalCheck(cfg, slug) {
  const C = qaContext(cfg, slug);
  const checks = [];
  const add = (id, ok, severity, detail) => checks.push({ id, ok, severity: ok ? 'ok' : severity, detail });
  // WordPress side: the deployed build, valid Divi structure, builder flag.
  try {
    const out = path.join(C.dir, 'readback.txt');
    const rb = await WP.readback(cfg, { id: C.st.post.id, contentOut: out });
    add('wp.deployed-build', rb.build?.build_id === C.buildId, 'critical', { deployed: rb.build?.build_id, expected: C.buildId });
    const parsed = parseShortcodes(fs.readFileSync(out, 'utf8'));
    add('wp.shortcodes-valid', parsed.ok, 'critical', parsed.ok ? { sections: parsed.counts.et_pb_section } : parsed.errors.slice(0, 3));
    add('wp.section-count', parsed.counts.et_pb_section === C.sections.length, 'major', { divi: parsed.counts.et_pb_section, design: C.sections.length });
    add('wp.builder-on', rb.use_builder === 'on', 'critical', rb.use_builder);
    add('wp.draft', rb.status !== 'publish' || cfg.site.allowPublish, 'critical', rb.status);
  } catch (e) {
    add('wp.readback', false, 'critical', e.message);
  }
  const browser = await launch(C.mode);
  try {
    const sb = await scrollbarWidth(browser);
    const r = await capture(browser, C.url, { width: C.FW, height: C.matrix.height, match: 'page', scrollbar: sb, collect: true, settleOpts: { assetTimeoutMs: cfg.qa.assetTimeoutMs, settleMs: cfg.qa.settleMs } });
    if (r.navError) {
      add('render', false, 'critical', r.navError);
      await release(r);
    } else {
      const p = r.page;
      const errors = r.console.filter((m) => m.type === 'pageerror' || m.type === 'error');
      add('render.console-errors', !errors.length, r.console.some((m) => m.type === 'pageerror') ? 'critical' : 'major', errors.slice(0, 6));
      const same = r.failed.filter((f) => f.url.startsWith(cfg.site.url));
      add('render.failed-requests', !same.length, 'major', same.slice(0, 6));
      add('render.layout-shift', (r.metrics?.cls ?? 0) <= 0.1, 'major', { cls: round(r.metrics?.cls ?? 0, 3) });
      const texts = Object.values(C.ir.nodes).filter((n) => n.text && n.a.role === 'text' && !n.a.decor && !n.a.counter && n.text.content.trim().length > 1).map((n) => ({ cls: n.cls, text: n.text.content }));
      const ss = await p.evaluate(structureScan, { sections: C.sections.map((s) => ({ cls: s.cls, name: s.name })), texts, buildId: C.buildId });
      add('page.sections-present', ss.sections.every((s) => s.present && s.inOrder), 'critical', ss.sections.filter((s) => !s.present || !s.inOrder).map((s) => s.name));
      add('page.text-present', !ss.missingText.length, 'major', ss.missingText.slice(0, 8));
      add('page.images-load', ss.images.every((i) => i.ok || i.w === 0), 'critical', ss.images.filter((i) => !i.ok && i.w > 0).map((i) => i.src).slice(0, 8));
      add('page.no-raw-shortcodes', !ss.rawShortcodes, 'critical', null);
      add('page.no-theme-chrome', !ss.themeChrome.length, 'major', ss.themeChrome);
      add('page.css-current', ss.buildMarker === C.buildId, 'major', { rendered: ss.buildMarker });
      add('page.no-injected-markup', !ss.injected.length, 'major', ss.injected.slice(0, 6));
      const links = await p.evaluate(interactionScan);
      add('links.have-targets', links.every((a) => a.href !== null && a.href !== ''), 'major', links.filter((a) => !a.href).map((a) => a.text));
      add('links.clickable', links.every((a) => !a.covered), 'major', links.filter((a) => a.covered).map((a) => `${a.text} under ${a.coveredBy}`));
      const placeholders = links.filter((a) => a.href === '#').map((a) => a.text);
      if (placeholders.length) checks.push({ id: 'links.placeholders', ok: true, severity: 'info', detail: `${placeholders.length} links go to "#" (no destination in the design): ${[...new Set(placeholders)].slice(0, 6).join(', ')}` });
      // Forms: every form the design has is on the page with its fields (rendered static unless wired).
      const forms = Object.values(C.ir.nodes).filter((n) => n.a.widget === 'form');
      for (const f of forms) {
        const fields = f.children.length;
        const got = await p.evaluate((cls) => { const e = document.querySelector('.' + cls); return e ? { shown: e.getBoundingClientRect().height > 0, inputs: e.querySelectorAll('input, textarea, select').length } : null; }, f.cls);
        add(`forms.${f.name}`, !!got?.shown, 'major', { ...got, designChildren: fields, note: got?.inputs ? 'native inputs present' : 'static (not wired to a form handler — a plan limitation, not a render failure)' });
      }
      const comps = await p.evaluate(componentChecks);
      for (const c of comps) add(`component.${c.c}${c.i != null ? '-' + (c.i + 1) : ''}@${C.FW}`, c.ok, c.c === 'menu' ? 'critical' : 'major', c.detail);
      const sticky = await p.evaluate(stickyScan);
      if (sticky) add(`header.sticky@${C.FW}`, sticky.positions.every((x) => Math.abs(x.top) <= 1 && x.visible && x.onTop), 'major', sticky.positions);
      await release(r);
      // Every width and rotation: horizontal overflow; the components and the header where they change.
      const r2 = await openPage(C, browser, sb, 1440, null, false);
      for (const cell of C.matrix.cells) {
        const vp = vpName(cell.width, cell.height);
        await r2.page.setViewportSize({ width: cell.width + (cell.kind === 'design' ? sb : 0), height: cell.height || C.matrix.height });
        await r2.page.waitForTimeout(200);
        const o = await r2.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        add(`overflow@${vp}`, o.sw - o.cw <= 1, 'major', { overflowX: o.sw - o.cw });
        if ([1024, 768, 390].includes(cell.width) && !cell.height || cell.kind === 'landscape') {
          const comps2 = await r2.page.evaluate(componentChecks);
          for (const c of comps2.filter((x) => x.c === 'menu' || x.c === 'slider')) add(`component.${c.c}@${vp}`, c.ok, c.c === 'menu' ? 'critical' : 'major', c.detail);
          const s2 = await r2.page.evaluate(stickyScan);
          if (s2) {
            add(`header.sticky@${vp}`, s2.positions.every((x) => Math.abs(x.top) <= 1 && x.visible && x.onTop), 'major', s2.positions);
            if (s2.drawer) add(`header.drawer@${vp}`, s2.drawer.opened && s2.drawer.inView && (s2.drawer.fits || s2.drawer.scrollable) && s2.drawer.reclosed, 'major', s2.drawer);
          }
        }
      }
      await release(r2);
      await editorParity(C, browser, sb, add);
    }
  } finally {
    await browser.close();
  }
  const blocking = checks.filter((c) => !c.ok && ['critical', 'major'].includes(c.severity));
  const res = { schema: 'f2d-check/1', slug, buildId: C.buildId, at: new Date().toISOString(), pass: !blocking.length, blocking: blocking.length, checks };
  writeJson(path.join(C.dir, 'check.json'), res);
  return { ...res, file: rel(C, path.join(C.dir, 'check.json')), failed: blocking.map((c) => `${c.severity} ${c.id}: ${JSON.stringify(c.detail).slice(0, 160)}`) };
}

// ---------- section-qa-state.json ----------
export const statePath = (cfg, slug) => path.join(ws(cfg, slug).root, 'qa', 'agent', 'section-qa-state.json');

export function initState(cfg, slug, { force = false } = {}) {
  const C = qaContext(cfg, slug);
  const file = statePath(cfg, slug);
  const prev = readJsonIf(file);
  if (prev && !force) return { ok: true, file: rel(C, file), existing: true, sections: prev.sections.length };
  const responsive = C.matrix.cells.map((c) => vpName(c.width, c.height));
  const state = {
    schema: 'f2d-section-qa/1',
    _readme: [
      'Written by the f2d-qa agent. Every number comes from an `f2d shot` / `f2d measure` run on the build it names — an estimated cell is a lie with a decimal point.',
      'status: pending | in_progress | locked | failed. A section is locked only when the agent has looked at its diff/side images at the design width and its sweep sheets at every width, judged it right, and recorded why. similarity_pct is evidence, not the gate; a section locked below 98% says why in below_98_reason.',
      'Never delete history: append an iteration per capture → fix → recapture cycle.',
    ],
    page: { slug, post_id: C.st.post.id, edit_url: `${cfg.site.url}/wp-admin/post.php?post=${C.st.post.id}&action=edit`, status: 'draft' },
    design_width: C.FW,
    widths: { scored: [C.FW], responsive },
    sections: C.sections.map((s) => ({ index: s.index, name: s.name, slug: s.slug, selector: `.${s.cls}`, node: s.id, header: s.header || undefined, status: 'pending', checks: 0, similarity_by_width: {}, best_alignment: {}, diff_images: {}, iterations: [], responsive: { status: 'pending', widths_checked: [], open: [] }, below_98_reason: null, notes: '' })),
    drawer: { status: 'pending', widths: [], notes: '' },
    page_pass: { status: 'pending', notes: '' },
    ux_deviations: [],
  };
  writeJson(file, state);
  return { ok: true, file: rel(C, file), sections: state.sections.length, widths: responsive.length };
}

export function validateState(cfg, slug) {
  const w = ws(cfg, slug);
  const file = statePath(cfg, slug);
  const s = readJsonIf(file);
  if (!s) throw new F2DError('E_NO_STATE', 'No section-qa-state.json — run "f2d qa-state init"');
  const errs = [], warns = [];
  const exists = (f) => f && fs.existsSync(path.join(w.root, f));
  for (const sec of s.sections) {
    const tag = `section ${sec.index} (${sec.name})`;
    if (sec.status !== 'locked') { warns.push(`${tag}: ${sec.status}`); continue; }
    if (!sec.iterations?.length) errs.push(`${tag}: locked without a recorded iteration`);
    for (const wd of s.widths.scored) {
      if (sec.similarity_by_width?.[wd] == null) errs.push(`${tag}: no similarity recorded at ${wd}`);
      if (!exists(sec.diff_images?.[wd])) errs.push(`${tag}: diff image for ${wd} missing on disk`);
    }
    // Similarity exists only where a Figma frame does; every repair names the cause it addresses.
    const unref = Object.keys(sec.similarity_by_width || {}).filter((k) => !s.widths.scored.map(String).includes(String(k)));
    if (unref.length) errs.push(`${tag}: similarity recorded at ${unref.join(', ')} — no Figma reference exists there`);
    for (const it of sec.iterations || []) if (it.repairs?.length && !it.cause) errs.push(`${tag}: an iteration applied repairs (${it.repairs.join(', ')}) without recording their cause`);
    const low = Object.values(sec.similarity_by_width || {}).some((v) => v < 98);
    if (low && !sec.below_98_reason) errs.push(`${tag}: locked below 98% without below_98_reason`);
    if (sec.responsive?.status !== 'responsive' && sec.responsive?.status !== 'incomplete') errs.push(`${tag}: responsive pass not done`);
    const missing = s.widths.responsive.filter((v) => !sec.responsive?.widths_checked?.includes(v));
    if (sec.responsive?.status === 'responsive' && missing.length) errs.push(`${tag}: responsive marked done but ${missing.length} widths not checked (${missing.slice(0, 5).join(', ')}…)`);
    if (!sec.notes) warns.push(`${tag}: no notes`);
  }
  return { ok: !errs.length, file: path.relative(w.root, file), errors: errs, warnings: warns, locked: s.sections.filter((x) => x.status === 'locked').length, of: s.sections.length };
}
