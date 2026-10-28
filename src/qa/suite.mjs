// The complete QA suite. EVERY pass runs all six categories (structure, geometry, visual,
// responsive, edge/runtime, interaction) across the plan's viewport matrix and scrollbar modes.
// A category is "not applicable" only with a written reason in the report.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, readJsonIf, writeJson, writeText, sha, round, ensureDir, F2DError, log } from '../util/core.mjs';
import { ws, loadState } from '../workspace.mjs';
import { viewportMatrix } from '../planner/plan.mjs';
import { launch, scrollbarWidth, capture, release } from './render.mjs';
import { readPng, flatten, crop, compareImages, overlay, sideBySide, downscale, writePng } from './compare.mjs';
import { compareGeometry, rootCauses } from './geometry.mjs';
import { collectLeaves, responsiveScan, styleConflicts, structureScan, interactionScan, componentChecks, uxScan, stickyScan } from './checks.mjs';
import { recordPass, loadLedger } from './ledger.mjs';
import { parseShortcodes } from '../pipeline/build.mjs';
import { rgba } from '../layout/engine.mjs';
import { visualBox } from '../ir/analyze.mjs';
import * as WP from '../wp/client.mjs';

const SEV = ['critical', 'major', 'minor', 'info'];

// ---------- spec: what every generated class is supposed to be ----------
export function buildSpec(ir, layout) {
  const N = ir.nodes;
  const byCls = {};
  const sectionOf = (id) => {
    for (let p = id; p; p = N[p]?.parent) if (N[p]?.a.role === 'section') return N[p].cls;
    return null;
  };
  const walk = (b, anc) => {
    const n = N[b.id];
    const leaf = !b.children.length || b.kind === 'button' || b.kind === 'text' || b.tag === 'img';
    // Visible in the design = not cut by a clipping ancestor there. Inside widgets (carousel strips,
    // counters) clipping is the design's intent.
    let designVisible = true, inWidget = !!n?.a.counter;
    for (let p = n?.parent; p; p = N[p]?.parent) {
      const a = N[p];
      if (a?.a?.widget) inWidget = true;
      if (a?.clips && n) {
        const bx = n.box, c = a.box;
        const ix = Math.max(0, Math.min(bx.x + bx.w, c.x + c.w) - Math.max(bx.x, c.x));
        const iy = Math.max(0, Math.min(bx.y + bx.h, c.y + c.h) - Math.max(bx.y, c.y));
        if (ix * iy < 0.9 * bx.w * Math.max(bx.h, 1)) designVisible = false;
      }
    }
    byCls[b.cls] = { id: b.id, kind: b.kind, leaf, decor: !!n?.a.decor, counter: !!n?.a.counter, link: b.kind === 'button', section: sectionOf(b.id), ancestors: anc, designVisible, inWidget, heading: /^h[1-6]$/.test(b.tag || ''), box: n ? visualBox(n, ir.assets?.[n.asset]) : null };
    if (b.kind === 'button') return; // children are part of the button unit
    for (const c of b.children) walk(c, [...anc, b.cls]);
  };
  walk(layout.root, []);
  // Leaves that overlap in the design itself are allowed to overlap when rendered.
  const leaves = Object.entries(byCls).filter(([, s]) => s.leaf && !s.decor && s.box);
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const [ca, a] = leaves[i], [cb, b] = leaves[j];
      const ox = Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x);
      const oy = Math.min(a.box.y + a.box.h, b.box.y + b.box.h) - Math.max(a.box.y, b.box.y);
      if (ox > 1 && oy > 1) {
        (a.overlapsInDesign ??= []).push(cb);
        (b.overlapsInDesign ??= []).push(ca);
      }
    }
  }
  return byCls;
}

function expectedStyles(layout) {
  const out = {};
  const walk = (b) => {
    if (b.kind === 'text') {
      const c = b.css.base;
      out[b.cls] = {
        color: c.color && c.color !== 'transparent' && /^#|^rgb/.test(c.color) ? c.color : null,
        fontSize: c['font-size'] || null,
        family: (c['font-family'] || '').split(',').map((f) => f.replace(/['"]/g, '').trim()).find((f) => f) || null,
        lineHeight: c['line-height'] || null,
      };
    }
    b.children.forEach(walk);
  };
  walk(layout.root);
  return out;
}

// ---------- main ----------
// Likely cause and the pipeline rule that repairs it, per responsive failure (reported per section × viewport).
const CAUSES = {
  'responsive.overflow-x': ['an element wider than the viewport (fixed width, 100vw, unscaled desktop gap)', 'let it shrink: fluid gutters, max-width 100%, flex-shrink on narrow desktops, tightened gaps'],
  'responsive.offscreen': ['fixed size or offset kept from the desktop geometry', 'anchor to the content (centre/right) or drop bleeding decoration below the content width'],
  'responsive.overlap': ['absolute placement or a fixed height kept from the desktop geometry', 'flow conversion / proportional placement of the composition, heights relaxed, rows wrap'],
  'responsive.content-covered': ['a row that cannot wrap pushes its last item under a neighbour, or decoration paints over content', 'rows of links/buttons wrap with tightened gaps; bleeding decoration hidden where the content column shrinks'],
  'responsive.content-cut': ['a fixed height or a clipping container smaller than its content at this width', 'height auto below the design width; flex-basis at least the content minimum'],
  'responsive.text-spills': ['a text box squeezed by a fixed or filling height while its text needs more lines', 'height auto / flex 1 0 auto for filling text below the design width'],
  'responsive.text-clipped': ['a text box with a fixed height', 'height auto for text that can reflow'],
  'responsive.word-broken': ['the font size is too large for the column', 'stepped font size per ladder tier, capped by the longest word at the tier\'s narrowest width'],
  'responsive.tap-target': ['a control kept its small desktop size', 'min 44×44 on phones (buttons, controls, whole-text links)'],
  'responsive.orphan-word': ['the heading wraps one word onto its last line', 'text-wrap: balance on headings, or a stepped size on the tier where it breaks'],
  'responsive.uneven-cards': ['cards in one line size to their own content', 'align-items: stretch on the grid row (equal heights)'],
  'responsive.lonely-item': ['an odd number of cards in a two-up grid', 'the last card spans the line (flex 1 1 100%)'],
  'responsive.image-distorted': ['an image stretched to a box of another shape (object-fit: fill)', 'object-fit: cover, or an aspect-ratio with height auto'],
  'responsive.zero-height': ['a parent squeezed its content to nothing (fixed height, flex-basis 0)', 'height auto / flex 0 0 auto on the tier where it collapses'],
  'responsive.section-spill': ['a fixed section height kept below the design width', 'height auto (min-height = design height) on the tier where it spills'],
  'responsive.cramped-edge': ['no side gutter at the narrowest phones', 'phone gutter (20px) on the section'],
  'responsive.4k-not-full-bleed': ['a section narrower than the screen above the design width', 'section width 100%; content contained by padding calc(50% − 960px + gutter)'],
  'responsive.4k-content-wide': ['content stretching with the screen above 1920', '4K containment: padding calc(50% − 960px + gutter) on the box that carries the background'],
  'responsive.4k-off-centre': ['placed content anchored to one screen edge', 'offsets measured from the centred 1920 column (left/right: calc(50% − 960px + x))'],
  'responsive.4k-height-grows': ['a full-bleed image or aspect-ratio box scales with the screen width', 'fixed design height with object-fit: cover above the design width'],
  'responsive.header-tall': ['the compact header keeps desktop sizes', 'logo sized by height and side bars moved into the drawer at the menu breakpoint'],
  'responsive.text-squeezed': ['a flex item with basis 0 beside a fixed-width sibling', 'basis = max(half the design width, content minimum); the row wraps or becomes a two-up grid'],
  'responsive.dead-gutter': ['desktop side padding was not made fluid', 'fluid gutters on full-width containers (max(gutter, (100% − content) / 2))'],
};

// `section`: check one section (its index) at every width and rotation, the DEV Connect way — fix it,
// re-check it (at most 3 times), lock it, then move on; results go to qa/section-state.json.
export async function runQa(cfg, slug, buildId, { pass = null, quick = false, record = true, allSections = false, section = null } = {}) {
  const only = section != null;
  if (only) (quick = false), (record = false);
  const w = ws(cfg, slug);
  const ir = readJson(w.ir);
  const bdir = w.build(buildId);
  const manifest = readJsonIf(path.join(bdir, 'manifest.json'));
  if (!manifest) throw new F2DError('E_NO_BUILD', `Build ${buildId} not found`);
  const layout = readJson(path.join(bdir, 'layout.json'));
  const st = loadState(w);
  if (!st.post?.previewUrl) throw new F2DError('E_NOT_DEPLOYED', 'Nothing deployed yet — run "f2d deploy" first');
  const ledger = loadLedger(cfg, slug);
  const passNo = pass ?? (ledger.passes.length ? Math.max(...ledger.passes.map((p) => p.pass)) + 1 : 1);
  const qdir = ensureDir(quick ? path.join(w.root, 'qa', buildId, 'quick') : only ? path.join(w.root, 'qa', buildId, `section-${section}`) : w.qa(buildId, passNo));
  const ev = ensureDir(path.join(qdir, 'evidence'));
  const relEv = (f) => path.relative(qdir, f).split(path.sep).join('/');
  const t0 = Date.now();

  const issues = [];
  const checks = { structure: { pass: 0, total: 0 }, edge: { pass: 0, total: 0 }, interaction: { pass: 0, total: 0 } };
  const tally = (cat, ok) => { checks[cat].total++; if (ok) checks[cat].pass++; };
  const issue = (rule, category, severity, o = {}) => {
    const key = [rule, o.nodeId || o.cls || o.key || '', o.viewport || ''];
    issues.push({ id: 'Q' + sha(key, 10), rule, category, severity, ...o, ...(CAUSES[rule] && !o.cause ? { cause: CAUSES[rule][0], repair: CAUSES[rule][1] } : {}) });
  };
  const spec = buildSpec(ir, layout);
  const clsToId = Object.fromEntries(Object.entries(spec).map(([c, s]) => [c, s.id]));
  const nodeName = (cls) => ir.nodes[clsToId[cls]]?.name || cls;
  const sections = Object.values(ir.nodes).filter((n) => n.a.role === 'section').sort((a, b) => a.a.sectionIndex - b.a.sectionIndex);
  const target = only ? sections.find((s) => s.a.sectionIndex === Number(section)) : null;
  if (only && !target) throw new F2DError('E_NO_SECTION', `No section ${section} (0–${sections.length - 1})`);
  // Each section's content gaps in the design (left / right of its content), for the 4K centring check.
  const FW = ir.frames[0].width;
  const gapsOf = Object.fromEntries(sections.map((s) => {
    const xs = Object.values(spec).filter((x) => x.section === s.cls && x.leaf && !x.decor && x.box && ['text', 'image', 'button', 'svg'].includes(x.kind));
    // (clipped to the frame: cards of a strip run past its edge on purpose)
    return [s.cls, { cls: s.cls, lD: xs.length ? Math.max(0, Math.min(...xs.map((x) => x.box.x))) : 0, rD: xs.length ? Math.max(0, FW - Math.max(...xs.map((x) => x.box.x + x.box.w))) : 0 }];
  }));
  const texts = Object.values(ir.nodes).filter((n) => n.text && n.a.role === 'text' && !n.a.decor && !n.a.counter && n.text.content.trim().length > 1).map((n) => ({ cls: n.cls, text: n.text.content }));

  // ---- A. structure (WordPress side): deployed build + saved layout validity
  let rb = null;
  try {
    rb = await WP.readback(cfg, { id: st.post.id, contentOut: path.join(qdir, 'readback.txt') });
  } catch (e) {
    issue('structure.readback', 'structure', 'critical', { message: `Could not read the page back: ${e.message}` });
  }
  if (rb) {
    tally('structure', rb.build?.build_id === buildId);
    if (rb.build?.build_id !== buildId) issue('structure.deployed-build', 'structure', 'critical', { message: `Deployed build is ${rb.build?.build_id}, QA was asked for ${buildId}` });
    const parsed = parseShortcodes(fs.readFileSync(path.join(qdir, 'readback.txt'), 'utf8'));
    tally('structure', parsed.ok);
    if (!parsed.ok) issue('structure.shortcode-parse', 'structure', 'critical', { message: `Saved layout is not valid Divi shortcode structure: ${parsed.errors.slice(0, 3).join('; ')}` });
    tally('structure', parsed.counts.et_pb_section === sections.length);
    tally('structure', rb.use_builder === 'on');
    if (rb.use_builder !== 'on') issue('structure.builder-flag', 'structure', 'critical', { message: '_et_pb_use_builder is not "on" — Divi will not render the layout' });
    tally('structure', rb.status !== 'publish' || cfg.site.allowPublish);
  }

  // The build's own breakpoints (Divi's, the narrow-desktop tier, per-row grids) are tested on both sides.
  const cssFile = path.join(bdir, 'divi', 'page.css');
  const builtCss = fs.existsSync(cssFile) ? fs.readFileSync(cssFile, 'utf8') : '';
  const breakpoints = [...new Set([...builtCss.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => +m[1]))];
  const matrix = viewportMatrix(cfg, ir, { breakpoints });
  const QUICK = [2560, 1440, 1366, 1200, 1024, 880, 768, 390, 360];
  const cells = quick ? matrix.cells.filter((c) => c.kind === 'design' || (c.kind === 'landscape' ? c.width === 844 : QUICK.includes(c.width))) : matrix.cells;
  const contain = {}; // section cls -> { [width]: height } above the design width
  const ref = flatten(readPng(ir.frames[0].screenshot.path));
  const result = { cells: [], visual: [], geometry: [], styleConflicts: [], interaction: [] };

  for (const mode of matrix.scrollbarModes) {
    const browser = await launch(mode);
    try {
      const sb = await scrollbarWidth(browser);
      for (const cell of cells) {
        const vp = `${cell.kind === 'design' ? 'd' : 'w'}${cell.width}${cell.height ? 'x' + cell.height : ''}${matrix.scrollbarModes.length > 1 ? '-' + mode : ''}`;
        const shot = path.join(ev, `${vp}.png`);
        const r = await capture(browser, st.post.previewUrl, { width: cell.width, height: cell.height || matrix.height, match: cell.match, scrollbar: sb, screenshot: shot, settleOpts: { assetTimeoutMs: cfg.qa.assetTimeoutMs, settleMs: cfg.qa.settleMs } });
        const cellRec = { vp, width: cell.width, kind: cell.kind, match: cell.match, mode, scrollbar: sb, metrics: r.metrics && { ...r.metrics, fonts: r.metrics.fonts.filter((f) => f.status === 'loaded').map((f) => f.family) }, settle: r.settle };
        if (r.navError || !r.metrics) {
          issue('structure.render', 'structure', 'critical', { viewport: vp, message: `Page failed to render: ${r.navError || 'no metrics'}` });
          tally('structure', false);
          await release(r);
          result.cells.push(cellRec);
          continue;
        }
        // Viewport + section boundaries of every cell, so every screenshot traces to its page and section.
        const geoAll = Object.fromEntries(r.geometry.map((g) => [g.cls, g]));
        cellRec.viewport = { window: r.metrics.innerWidth ?? null, client: r.metrics.clientWidth, height: cell.height || matrix.height, docHeight: r.metrics.docHeight, scrollbar: sb, deviceScaleFactor: 1 };
        cellRec.sections = sections.map((s) => geoAll[s.cls] && { index: s.a.sectionIndex, name: s.name, cls: s.cls, y: Math.round(geoAll[s.cls].y), h: Math.round(geoAll[s.cls].h) }).filter(Boolean);
        // ---- per-section screenshots: every viewport on the baseline and final passes (allSections),
        // the design frames + major widths on the passes in between; the repair agent reviews them all.
        if (cell.kind === 'design' || allSections || only || (cfg.viewports.sectionShots || []).includes(cell.width)) {
          const full = readPng(shot);
          const geoBy = Object.fromEntries(r.geometry.map((g) => [g.cls, g]));
          const shots = [];
          for (const s of only ? [target] : sections) {
            const g = geoBy[s.cls];
            if (!g || g.h < 2) continue;
            const crp = crop(full, 0, g.y, full.width, Math.min(g.h, full.height - g.y));
            const file = path.join(ev, 'sections', `${vp}-s${String(s.a.sectionIndex).padStart(2, '0')}.png`);
            let img = downscale(crp, Math.min(1, 960 / crp.width));
            if (cell.kind === 'design') {
              const refCrop = crop(ref, 0, s.box.y, ref.width, s.box.h);
              img = downscale(sideBySide(refCrop, crp), Math.min(1, 1600 / (refCrop.width + crp.width + 8)));
            }
            writePng(file, img);
            shots.push({ index: s.a.sectionIndex, name: s.name, cls: s.cls, file: relEv(file), y: Math.round(g.y), h: Math.round(g.h) });
          }
          (result.sectionShots ??= {})[vp] = shots;
        }
        // ---- responsive scan (every cell, design widths included)
        const rs = await r.page.evaluate(responsiveScan, spec);
        cellRec.responsive = { overflowX: rs.overflowX, overlaps: rs.overlaps.length, clipped: rs.clipped.length, offscreen: rs.offscreen.length, tiny: rs.tiny.length, cut: rs.cut.length, brokenWords: rs.brokenWords.length, squeezed: rs.squeezed.length, gutters: rs.gutters.length, covered: rs.covered.length, spill: rs.spill.length };
        if (rs.overflowX > 1) issue('responsive.overflow-x', 'responsive', rs.overflowX > 20 ? 'critical' : 'major', { viewport: vp, measured: rs.overflowX, section: rs.offenders.map((o) => spec[o.cls]?.section).find(Boolean), message: `Horizontal overflow of ${rs.overflowX}px at ${cell.width}px`, evidence: { offenders: rs.offenders, screenshot: relEv(shot) } });
        if (rs.offscreen.length) issue('responsive.offscreen', 'responsive', 'major', { viewport: vp, measured: rs.offscreen.length, message: `${rs.offscreen.length} elements extend past the viewport at ${cell.width}px`, evidence: { elements: rs.offscreen.slice(0, 10).map((o) => ({ ...o, name: nodeName(o.cls) })) } });
        for (const o of rs.overlaps) {
          const severe = /text/.test(o.kinds) && o.frac > 0.3;
          issue('responsive.overlap', 'responsive', severe ? 'critical' : 'major', { viewport: vp, key: `${o.a}|${o.b}`, cls: o.a, nodeId: clsToId[o.a], section: spec[o.a]?.section, measured: o.frac, message: `"${nodeName(o.a)}" overlaps "${nodeName(o.b)}" (${Math.round(o.frac * 100)}% of the smaller) at ${cell.width}px — not overlapping in the design`, evidence: { screenshot: relEv(shot) } });
        }
        for (const c of rs.spill) issue('responsive.text-spills', 'responsive', 'major', { viewport: vp, cls: c.cls, nodeId: clsToId[c.cls], section: spec[c.cls]?.section, measured: c.scrollH - c.clientH, message: `Text "${nodeName(c.cls)}" spills ${c.scrollH - c.clientH}px out of its box at ${cell.width}px (paints over what follows)` });
        for (const c of rs.clipped) issue('responsive.text-clipped', 'responsive', 'major', { viewport: vp, cls: c.cls, nodeId: clsToId[c.cls], message: `Text "${nodeName(c.cls)}" is clipped (${c.scrollH}px content in ${c.clientH}px) at ${cell.width}px` });
        for (const c of rs.cut) issue('responsive.content-cut', 'responsive', (c.kind === 'text' || c.kind === 'button') && c.visible < 0.5 ? 'critical' : 'major', { viewport: vp, cls: c.cls, nodeId: clsToId[c.cls], section: spec[c.cls]?.section, measured: c.visible, message: `"${nodeName(c.cls)}" is cut off at ${cell.width}px (${Math.round(c.visible * 100)}% visible) — fully visible in the design`, evidence: { screenshot: relEv(shot) } });
        // (below 360px long words may wrap — the DEV Connect 320 rule: nothing overflows or clips — so a
        // break there is reported, not a defect)
        for (const bw of rs.brokenWords) issue('responsive.word-broken', 'responsive', (cellRec.viewport?.window ?? cell.width) < 360 ? 'minor' : bw.heading || bw.boxW < 120 ? 'critical' : 'major', { viewport: vp, cls: bw.cls, nodeId: clsToId[bw.cls], section: spec[bw.cls]?.section, measured: bw, message: `"${nodeName(bw.cls)}" breaks the word "${bw.word}" (${bw.wordW}px) inside a ${bw.boxW}px box at ${cell.width}px` });
        for (const sq of rs.squeezed) issue('responsive.text-squeezed', 'responsive', 'critical', { viewport: vp, cls: sq.cls, nodeId: clsToId[sq.cls], section: spec[sq.cls]?.section, measured: sq.boxW, message: `"${nodeName(sq.cls)}" (${sq.chars} characters) is squeezed into ${sq.boxW}px at ${cell.width}px` });
        for (const cv of rs.covered) issue('responsive.content-covered', 'responsive', 'critical', { viewport: vp, key: `${cv.cls}|${cv.by}`, cls: cv.cls, nodeId: clsToId[cv.cls], section: spec[cv.cls]?.section, message: `"${nodeName(cv.cls)}" is hidden under "${nodeName(cv.by)}" (${cv.byKind}) at ${cell.width}px — they do not overlap in the design`, evidence: { screenshot: relEv(shot) } });
        for (const g of rs.gutters) issue('responsive.dead-gutter', 'responsive', 'major', { viewport: vp, cls: g.section, nodeId: clsToId[g.section], measured: g.used, message: `Section "${nodeName(g.section)}" uses only ${g.used}px of ${g.of}px at ${cell.width}px` });
        // ---- "looks intentional" + 4K containment (DEV Connect responsive pass)
        const ux = await r.page.evaluate(uxScan, { spec, sections: Object.values(gapsOf), frameW: FW });
        Object.assign(cellRec.responsive, { tap: ux.tap.length, orphans: ux.orphans.length, uneven: ux.uneven.length, lonely: ux.lonely.length, distorted: ux.distorted.length, zero: ux.zero.length, spill: (cellRec.responsive.spill || 0), sectionSpill: ux.spill.length, cramped: ux.cramped.length });
        const at = `at ${cell.width}${cell.height ? '×' + cell.height : ''}px`;
        for (const t of ux.tap.slice(0, 12)) issue('responsive.tap-target', 'responsive', 'major', { viewport: vp, cls: t.cls, nodeId: clsToId[t.cls], section: spec[t.cls]?.section, measured: { w: t.w, h: t.h }, message: `"${t.text || nodeName(t.cls)}" is a ${t.w}×${t.h}px tap target ${at} (minimum 44×44)` });
        for (const o of ux.orphans) issue('responsive.orphan-word', 'responsive', 'minor', { viewport: vp, cls: o.cls, nodeId: clsToId[o.cls], section: spec[o.cls]?.section, message: `Heading "${o.text || nodeName(o.cls)}" leaves "${o.word}" alone on its last line ${at}` });
        for (const u of ux.uneven) issue('responsive.uneven-cards', 'responsive', 'minor', { viewport: vp, cls: u.cls, nodeId: clsToId[u.cls], section: spec[u.cls]?.section, measured: u.heights, message: `Cards beside "${nodeName(u.cls)}" have uneven heights (${u.heights.join(' / ')}px) ${at}` });
        for (const l of ux.lonely) issue('responsive.lonely-item', 'responsive', 'minor', { viewport: vp, cls: l.cls, nodeId: clsToId[l.cls], section: spec[l.cls]?.section, message: `"${nodeName(l.cls)}" is alone on the last line of a ${l.perLine}-up grid ${at}` });
        for (const d of ux.distorted) issue('responsive.image-distorted', 'responsive', 'major', { viewport: vp, cls: d.cls, nodeId: clsToId[d.cls], section: spec[d.cls]?.section, measured: d, message: `Image "${nodeName(d.cls)}" is distorted ${at} (aspect ${d.got}, design ${d.design})` });
        for (const z of ux.zero) issue('responsive.zero-height', 'responsive', 'major', { viewport: vp, cls: z.cls, nodeId: clsToId[z.cls], section: spec[z.cls]?.section, message: `"${nodeName(z.cls)}" (${z.kind}) collapsed to 0px height ${at}` });
        const spillBySec = {};
        for (const sp of ux.spill) (spillBySec[sp.section] ??= []).push(sp);
        for (const [sec, list] of Object.entries(spillBySec)) issue('responsive.section-spill', 'responsive', 'major', { viewport: vp, key: sec, cls: sec, nodeId: clsToId[sec], section: sec, measured: Math.max(...list.map((x) => x.by)), message: `Section "${nodeName(sec)}" spills into the next section ${at}: ${list.slice(0, 3).map((x) => `"${nodeName(x.cls)}" by ${x.by}px`).join(', ')}` });
        const crampBySec = {};
        for (const c of ux.cramped) (crampBySec[spec[c.cls]?.section || ''] ??= []).push(c);
        for (const [sec, list] of Object.entries(crampBySec)) issue('responsive.cramped-edge', 'responsive', 'minor', { viewport: vp, key: sec, cls: sec || undefined, section: sec || undefined, message: `${list.length} elements of "${nodeName(sec) || 'the page'}" touch the screen edge ${at} (< 12px gutter)` });
        for (const c of ux.contain) {
          (contain[c.cls] ??= {})[cell.width] = c.height;
          const base = { viewport: vp, key: c.cls, cls: c.cls, nodeId: clsToId[c.cls], section: c.cls, measured: c };
          if (!c.fullBleed) issue('responsive.4k-not-full-bleed', 'responsive', 'critical', { ...base, message: `Section "${nodeName(c.cls)}" does not span the screen ${at} (background not full-bleed)` });
          if (c.span > 1922) issue('responsive.4k-content-wide', 'responsive', 'critical', { ...base, message: `Section "${nodeName(c.cls)}" content spans ${c.span}px ${at} (4K containment: at most 1920)` });
          else if (c.offCentre > 4) issue('responsive.4k-off-centre', 'responsive', 'major', { ...base, message: `Section "${nodeName(c.cls)}" content is ${c.offCentre}px off the design's centring ${at}` });
        }
        // ---- sticky header + drawer: desktop, tablet, phone and every rotated view
        if (cell.kind === 'design' || cell.kind === 'landscape' || [1024, 768, 390].includes(cell.width)) {
          const sticky = await r.page.evaluate(stickyScan);
          if (sticky) {
            cellRec.sticky = sticky;
            const hdr = sections.find((s) => s.a.header);
            const hb = { viewport: vp, cls: hdr?.cls, nodeId: hdr?.id, section: hdr?.cls };
            const bad = sticky.positions.filter((p) => Math.abs(p.top) > 1 || !p.visible || !p.onTop);
            tally('interaction', !bad.length);
            if (bad.length) issue('interaction.sticky-header', 'interaction', 'major', { ...hb, measured: bad, message: `The header is not pinned ${at} (scrolled to ${bad.map((p) => `${p.at * 100}%: top ${p.top}px${p.onTop ? '' : ', covered'}`).join('; ')})` });
            if (sticky.compact && sticky.height > Math.max(0.22 * sticky.viewportH, 72)) issue('responsive.header-tall', 'responsive', 'major', { ...hb, measured: sticky.height, message: `The compact header takes ${sticky.height}px of a ${sticky.viewportH}px-tall screen ${at} (keep it ≤ ~20%)` });
            const d = sticky.drawer;
            if (d) {
              const ok = d.opened && d.inView && (d.fits || d.scrollable) && d.reclosed;
              tally('interaction', ok);
              if (!ok) issue('interaction.drawer', 'interaction', 'major', { ...hb, measured: d, message: `The menu drawer ${!d.opened ? 'does not open' : !d.inView ? 'opens off-screen' : !(d.fits || d.scrollable) ? `is ${d.height}px tall and cannot scroll` : 'does not close'} from a scrolled page ${at}` });
            }
          }
        }

        // ---- runtime (every cell)
        const pageErrors = r.console.filter((m) => m.type === 'pageerror' || m.type === 'error');
        tally('edge', !pageErrors.length);
        if (pageErrors.length) issue('edge.console-errors', 'edge', r.console.some((m) => m.type === 'pageerror') ? 'critical' : 'major', { viewport: vp, measured: pageErrors.length, message: `${pageErrors.length} console errors`, evidence: { console: pageErrors.slice(0, 10) } });
        const sameOrigin = r.failed.filter((f) => f.url.startsWith(cfg.site.url));
        tally('edge', !sameOrigin.length);
        if (sameOrigin.length) issue('edge.failed-requests', 'edge', 'major', { viewport: vp, measured: sameOrigin.length, message: `${sameOrigin.length} failed same-origin requests`, evidence: { failed: sameOrigin.slice(0, 10) } });
        if (r.failed.length > sameOrigin.length) issue('edge.failed-third-party', 'edge', 'minor', { viewport: vp, message: `${r.failed.length - sameOrigin.length} failed third-party requests`, evidence: { failed: r.failed.filter((f) => !sameOrigin.includes(f)).slice(0, 5) } });
        tally('edge', r.metrics.cls <= 0.1);
        if (r.metrics.cls > 0.1) issue('edge.layout-shift', 'edge', 'major', { viewport: vp, measured: round(r.metrics.cls, 3), message: `Cumulative layout shift ${round(r.metrics.cls, 3)} (> 0.1) while loading` });
        tally('edge', !r.settle.problems.length);
        if (r.settle.problems.length) issue('edge.asset-timeout', 'edge', 'major', { viewport: vp, message: r.settle.problems.join('; ') });

        if (cell.kind === 'design') {
          // ---- structure (DOM)
          const ss = await r.page.evaluate(structureScan, { sections: sections.map((s) => ({ cls: s.cls, name: s.name })), texts, buildId });
          cellRec.structure = { bodyClass: ss.bodyClass, buildMarker: ss.buildMarker, themeChrome: ss.themeChrome };
          for (const s of ss.sections) {
            tally('structure', s.present && s.inOrder);
            if (!s.present) issue('structure.section-missing', 'structure', 'critical', { viewport: vp, cls: s.cls, nodeId: clsToId[s.cls], message: `Section "${s.name}" is missing from the rendered page` });
            else if (!s.inOrder) issue('structure.section-order', 'structure', 'major', { viewport: vp, cls: s.cls, nodeId: clsToId[s.cls], message: `Section "${s.name}" is out of order` });
          }
          for (const t of texts) tally('structure', !ss.missingText.some((m) => m.cls === t.cls));
          for (const m of ss.missingText) issue('structure.text-missing', 'structure', 'major', { viewport: vp, cls: m.cls, nodeId: clsToId[m.cls], section: spec[m.cls]?.section, message: `Text "${m.text}" ${m.reason}${m.got ? ` (got "${m.got}")` : ''}` });
          for (const m of ss.alteredText) issue('structure.text-altered', 'structure', 'minor', { viewport: vp, cls: m.cls, nodeId: clsToId[m.cls], message: `Text "${m.text}" rendered with altered characters ("${m.got}") — e.g. smart quotes` });
          tally('structure', !ss.duplicates.length);
          if (ss.duplicates.length) issue('structure.duplicate-element', 'structure', 'minor', { viewport: vp, measured: ss.duplicates.length, message: `${ss.duplicates.length} generated classes appear more than once`, evidence: { duplicates: ss.duplicates.slice(0, 10) } });
          tally('structure', !ss.injected.length);
          if (ss.injected.length) issue('structure.content-mangled', 'structure', 'major', { viewport: vp, measured: ss.injected.length, message: `${ss.injected.length} elements injected into generated content by WordPress/Divi (e.g. wpautop) — each becomes an extra flex item`, evidence: { examples: ss.injected.slice(0, 10) } });
          tally('structure', !ss.rawShortcodes);
          if (ss.rawShortcodes) issue('structure.raw-shortcode', 'structure', 'critical', { viewport: vp, message: 'Raw [et_pb_…] shortcode text is visible — Divi did not render part of the layout' });
          tally('structure', !ss.themeChrome.length);
          if (ss.themeChrome.length) issue('structure.theme-chrome', 'structure', 'major', { viewport: vp, message: `Theme header/footer rendered around the generated page: ${ss.themeChrome.join(', ')}` });
          tally('structure', ss.buildMarker === buildId);
          if (ss.buildMarker !== buildId) issue('edge.stale-css', 'edge', 'major', { viewport: vp, message: `Rendered CSS belongs to build ${ss.buildMarker || '(none)'}, expected ${buildId} — stale Divi cache`, measured: ss.buildMarker });
          for (const im of ss.images) {
            tally('structure', im.ok);
            if (im.ok && im.upscale > 1.25 && im.w >= 100) issue('structure.image-upscaled', 'structure', im.upscale > 2 ? 'major' : 'minor', { viewport: vp, cls: im.cls, nodeId: clsToId[im.cls], measured: im.upscale, message: `Image "${nodeName(im.cls)}" is stretched ${im.upscale}× beyond its natural resolution (blurry)` });
            if (!im.ok && im.w > 0) issue('structure.image-broken', 'structure', im.w >= 100 ? 'critical' : 'major', { viewport: vp, cls: im.cls, nodeId: clsToId[im.cls], section: spec[im.cls]?.section, message: `Image "${nodeName(im.cls)}" did not load (${im.src})` });
          }

          // ---- C. visual (full page + every section)
          const out = readPng(shot);
          const weights = cfg.qa.weights;
          const full = compareImages(ref, out, { weights, diffPath: path.join(ev, `${vp}-diff.png`) });
          const small = (img) => downscale(img, Math.min(1, 960 / img.width));
          writePng(path.join(ev, `${vp}-overlay.png`), small(overlay(ref, out)));
          const geoByCls = Object.fromEntries(r.geometry.map((g) => [g.cls, g]));
          const secScores = [];
          for (const s of sections) {
            const g = geoByCls[s.cls];
            if (!g) continue;
            const rc = crop(ref, 0, s.box.y, ref.width, s.box.h);
            const oc = crop(out, 0, g.y, out.width, g.h);
            const m = compareImages(rc, oc, { weights });
            const rec = { id: s.id, cls: s.cls, name: s.name, index: s.a.sectionIndex, ...m };
            if (m.score < 0.9) {
              writePng(path.join(ev, `${vp}-s${s.a.sectionIndex}-side.png`), small(sideBySide(rc, oc)));
              compareImages(rc, oc, { weights, diffPath: path.join(ev, `${vp}-s${s.a.sectionIndex}-diff.png`) });
              rec.evidence = { side: relEv(path.join(ev, `${vp}-s${s.a.sectionIndex}-side.png`)), diff: relEv(path.join(ev, `${vp}-s${s.a.sectionIndex}-diff.png`)) };
            }
            secScores.push(rec);
            if (m.score < cfg.qa.thresholds.visualSectionFloor) issue('visual.section-below-floor', 'visual', 'major', { viewport: vp, nodeId: s.id, cls: s.cls, section: s.cls, measured: m.score, message: `Section "${s.name}" visual score ${m.score} < floor ${cfg.qa.thresholds.visualSectionFloor}`, evidence: rec.evidence });
          }
          if (full.score < cfg.qa.thresholds.visual) issue('visual.page-below-threshold', 'visual', 'major', { viewport: vp, measured: full.score, message: `Page visual score ${full.score} < ${cfg.qa.thresholds.visual}`, evidence: { diff: relEv(path.join(ev, `${vp}-diff.png`)), overlay: relEv(path.join(ev, `${vp}-overlay.png`)) } });
          result.visual.push({ vp, frame: ir.frames[0].id, full, sections: secScores });

          // ---- B. geometry
          const geo = compareGeometry(ir, ir.frames[0], r.geometry, { tolPx: cfg.qa.geometryTolerance.px, tolRatio: cfg.qa.geometryTolerance.ratio });
          const causes = rootCauses(ir, geo, 30);
          result.geometry.push({ vp, score: geo.score, inTolerance: geo.inTolerance, elements: geo.elements, causes: causes.map((c) => ({ id: c.id, name: c.name, role: c.role, exp: c.exp, got: c.got, introduced: c.introduced })) });
          for (const c of causes) {
            const mag = Math.max(Math.abs(c.introduced.x), Math.abs(c.introduced.y), Math.abs(c.d.w), Math.abs(c.d.h));
            const rel = Math.max(Math.abs(c.d.w) / Math.max(c.exp.w, 1), Math.abs(c.d.h) / Math.max(c.exp.h, 1));
            issue('geometry.offset', 'geometry', mag > 40 || rel > 0.25 ? 'major' : 'minor', { viewport: vp, nodeId: c.id, cls: c.cls, section: spec[c.cls]?.section, measured: { introduced: c.introduced, size: c.d }, message: `"${c.name}" (${c.role}) is off by x${c.introduced.x} y${c.introduced.y} w${c.d.w} h${c.d.h}px`, evidence: { expected: c.exp, got: c.got } });
          }

          // ---- E. computed-style conflicts (theme/builder CSS beating the design)
          const conflicts = await r.page.evaluate(styleConflicts, expectedStyles(layout));
          result.styleConflicts.push({ vp, count: conflicts.length });
          const byProp = {};
          for (const c of conflicts) (byProp[c.prop] ??= []).push(c);
          for (const t of Object.keys(expectedStyles(layout))) tally('edge', !conflicts.some((c) => c.cls === t));
          for (const [prop, list] of Object.entries(byProp)) issue('edge.style-conflict', 'edge', 'major', { viewport: vp, key: prop, measured: list.length, message: `${list.length} text elements render a different ${prop} than designed (builder/theme CSS winning)`, evidence: { examples: list.slice(0, 8).map((c) => ({ ...c, name: nodeName(c.cls) })) } });

          // ---- F. interaction
          const inter = await r.page.evaluate(interactionScan);
          result.interaction.push({ vp, links: inter.length });
          for (const a of inter) {
            tally('interaction', !a.covered && a.href !== null && a.href !== '');
            if (a.covered) issue('interaction.covered', 'interaction', 'major', { viewport: vp, cls: a.cls, nodeId: clsToId[a.cls], message: `"${a.text}" is covered by ${a.coveredBy} — clicks will not reach it` });
            if (a.href === null || a.href === '') issue('interaction.no-href', 'interaction', 'major', { viewport: vp, cls: a.cls, nodeId: clsToId[a.cls], message: `"${a.text}" has no link target` });
            else if (a.href === '#') issue('interaction.placeholder-link', 'interaction', 'info', { viewport: vp, cls: a.cls, nodeId: clsToId[a.cls], message: `"${a.text}" links to "#": the design has no destination (unverified)` });
          }
          // Hover states from IR `states.hover`.
          for (const n of Object.values(ir.nodes).filter((x) => x.states?.hover)) {
            const want = n.states.hover.fills.find((f) => f.type === 'solid');
            if (!want) continue;
            const loc = r.page.locator('.' + n.cls).first();
            if (!(await loc.count())) continue;
            try {
              await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
              await loc.hover({ timeout: 3000, force: true });
              await r.page.waitForTimeout((n.interactions.find((i) => i.trigger === 'hover')?.durationMs || 300) + 100);
              const got = await loc.evaluate((el) => getComputedStyle(el).backgroundColor);
              const exp = rgba(want.color, want.opacity);
              const norm = (c) => (c || '').replace(/\s/g, '').replace(/^rgb\((\d+),(\d+),(\d+)\)$/, 'rgba($1,$2,$3,1)');
              const hexTo = (h) => (h.startsWith('#') ? `rgba(${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)},1)` : norm(h));
              const ok = norm(got) === hexTo(exp);
              tally('interaction', ok);
              if (!ok) issue('interaction.hover-state', 'interaction', 'minor', { viewport: vp, nodeId: n.id, cls: n.cls, message: `Hover on "${n.name}": background ${got}, design ${exp}`, measured: got });
            } catch (e) {
              tally('interaction', false);
              issue('interaction.hover-state', 'interaction', 'minor', { viewport: vp, nodeId: n.id, cls: n.cls, message: `Hover on "${n.name}" could not be exercised: ${e.message.split('\n')[0]}` });
            }
          }
          // Keyboard: Tab through the page like a keyboard user; every generated link must be reached
          // and show a focus indicator (:focus-visible only applies to keyboard focus).
          await r.page.mouse.move(0, 0);
          await r.page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
          const linkCount = await r.page.evaluate(() => [...document.querySelectorAll('a[class*="f2d-"]')].filter((a) => a.getBoundingClientRect().width > 0).length);
          const reached = new Set();
          let visible = 0;
          for (let k = 0; k < linkCount + 40 && reached.size < linkCount; k++) {
            await r.page.keyboard.press('Tab');
            const f = await r.page.evaluate(() => {
              const a = document.activeElement;
              if (!a || a.tagName !== 'A' || !/f2d-/.test(a.className)) return null;
              const cs = getComputedStyle(a);
              return { cls: a.className, visible: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none' };
            });
            if (f && !reached.has(f.cls + k)) (reached.add(f.cls + k), f.visible && visible++);
          }
          const focus = { links: linkCount, focusable: Math.min(reached.size, linkCount), visible };
          tally('interaction', focus.focusable === focus.links);
          tally('interaction', focus.visible === focus.links);
          if (focus.visible < focus.links) issue('interaction.focus-visible', 'interaction', 'minor', { viewport: vp, measured: focus, message: `${focus.links - focus.visible}/${focus.links} links show no visible focus indicator` });
          for (const n of Object.values(ir.nodes).filter((x) => x.a.widget && !['counter-digit', 'accordion', 'slider', 'marquee'].includes(x.a.widget))) issue('interaction.unverified', 'interaction', 'info', { viewport: vp, nodeId: n.id, message: `"${n.name}" (${n.a.widget}) renders statically; interaction fidelity cannot be verified from the export` });
        }
        // ---- F. interactive components, operated like a visitor would (design width + tablet + phone)
        if (cell.kind === 'design' || [768, 390].includes(cell.width)) {
          const comps = await r.page.evaluate(componentChecks);
          cellRec.components = comps;
          for (const c of comps) {
            tally('interaction', c.ok);
            if (!c.ok) issue('interaction.component', 'interaction', c.c === 'menu' ? 'critical' : 'major', { viewport: vp, key: c.c + (c.i ?? ''), measured: c.detail, message: `${c.c}${c.i != null ? ' ' + (c.i + 1) : ''} does not work at ${cell.width}px: ${JSON.stringify(c.detail)}` });
          }
        }
        result.cells.push(cellRec);
        await release(r);
      }

      // ---- E. edge cases (stress) at the first design width and the narrowest width
      if (!quick && !only) {
        const design = matrix.cells.find((c) => c.kind === 'design');
        const narrow = [...matrix.cells].sort((a, b) => a.width - b.width)[0];
        for (const cell of [design, narrow]) {
          const vp = `${cell.kind === 'design' ? 'd' : 'w'}${cell.width}${matrix.scrollbarModes.length > 1 ? '-' + mode : ''}`;
          // Long content: every text tripled.
          const rl = await capture(browser, st.post.previewUrl, { width: cell.width, match: cell.match, scrollbar: sb, collect: false, settleOpts: { settleMs: 200 } });
          const long = await rl.page.evaluate((spec) => {
            for (const el of document.querySelectorAll('.f2d-tc')) el.textContent = (el.textContent + ' ').repeat(3).trim();
            return null;
          }, spec);
          await rl.page.waitForTimeout(200);
          const rsl = await rl.page.evaluate(responsiveScan, spec);
          await release(rl);
          tally('edge', rsl.overflowX <= 1);
          if (rsl.overflowX > 1) issue('edge.long-text-overflow', 'edge', 'major', { viewport: vp, measured: rsl.overflowX, message: `With 3× longer text the page overflows horizontally by ${rsl.overflowX}px`, evidence: { offenders: rsl.offenders } });
          tally('edge', rsl.clipped.length === 0);
          if (rsl.clipped.length) issue('edge.long-text-clipped', 'edge', 'minor', { viewport: vp, measured: rsl.clipped.length, message: `With 3× longer text ${rsl.clipped.length} text blocks are clipped` });
          // Missing assets: images blocked.
          const base = result.cells.find((c) => c.vp === vp)?.metrics?.docHeight;
          const ri = await capture(browser, st.post.previewUrl, { width: cell.width, match: cell.match, scrollbar: sb, collect: false, settleOpts: { settleMs: 200 }, routes: (p) => p.route(/\.(png|jpe?g|webp|svg|gif)(\?|$)/i, (rt) => rt.abort()) });
          const rsi = await ri.page.evaluate(responsiveScan, spec);
          const hImg = ri.metrics?.docHeight;
          await release(ri);
          const collapsed = base && hImg < base * 0.6;
          tally('edge', !collapsed && rsi.overflowX <= 1);
          if (collapsed) issue('edge.missing-assets-collapse', 'edge', 'major', { viewport: vp, measured: { base, blocked: hImg }, message: `With images blocked the page collapses from ${base}px to ${hImg}px tall` });
          if (rsi.overflowX > 1) issue('edge.missing-assets-overflow', 'edge', 'major', { viewport: vp, measured: rsi.overflowX, message: `With images blocked the page overflows horizontally by ${rsi.overflowX}px` });
          // Font loading failure: web fonts blocked.
          const rf = await capture(browser, st.post.previewUrl, { width: cell.width, match: cell.match, scrollbar: sb, collect: false, settleOpts: { settleMs: 200 }, routes: (p) => p.route(/fonts\.googleapis|fonts\.gstatic|\.(woff2?|ttf|otf)(\?|$)/i, (rt) => rt.abort()) });
          const rsf = await rf.page.evaluate(responsiveScan, spec);
          await release(rf);
          tally('edge', rsf.overflowX <= 1 && rsf.clipped.length === 0);
          if (rsf.overflowX > 1) issue('edge.font-failure-overflow', 'edge', 'major', { viewport: vp, measured: rsf.overflowX, message: `With web fonts blocked the page overflows horizontally by ${rsf.overflowX}px` });
          if (rsf.clipped.length) issue('edge.font-failure-clipped', 'edge', 'minor', { viewport: vp, measured: rsf.clipped.length, message: `With web fonts blocked ${rsf.clipped.length} text blocks are clipped` });
        }
      }
    } finally {
      await browser.close();
    }
  }

  // 4K: a section is as tall on the widest screen as at the design width (nothing scales with the width).
  for (const [cls, hs] of Object.entries(contain)) {
    const ws = Object.keys(hs).map(Number).sort((a, b) => a - b);
    const h0 = hs[ws[0]], h1 = hs[ws.at(-1)];
    if (ws.length >= 2 && Math.abs(h1 - h0) > Math.max(8, h0 * 0.03)) issue('responsive.4k-height-grows', 'responsive', 'major', { viewport: `w${ws.at(-1)}`, key: cls, cls, nodeId: clsToId[cls], section: cls, measured: hs, message: `Section "${nodeName(cls)}" is ${h1}px tall at ${ws.at(-1)}px but ${h0}px at ${ws[0]}px` });
  }
  // One section only: keep what belongs to it (and page-level overflow it causes).
  if (only) {
    const keep = issues.filter((i) => i.section === target.cls || (i.cls && spec[i.cls]?.section === target.cls) || (i.cls === target.cls));
    issues.length = 0;
    issues.push(...keep);
  }
  // Per-section verdicts (responsive | incomplete) and the sweep (section × viewport) the repair loop
  // works through one section at a time.
  const sweep = {};
  const verdicts = [];
  for (const s of only ? [target] : sections) {
    const own = issues.filter((i) => i.section === s.cls && (i.category === 'responsive' || /sticky|drawer/.test(i.rule)));
    const row = (sweep[`${s.a.sectionIndex} ${s.name}`] = {});
    for (const c of result.cells.filter((x) => x.responsive)) {
      const list = own.filter((i) => i.viewport === c.vp);
      row[c.vp] = { overflow: c.responsive.overflowX, issues: list.map((i) => `${i.severity} ${i.rule}: ${i.message}`) };
    }
    const open = own.filter((i) => ['critical', 'major'].includes(i.severity));
    verdicts.push({ index: s.a.sectionIndex, name: s.name, cls: s.cls, status: open.length ? 'incomplete' : 'responsive', open: open.map((i) => ({ width: i.viewport, rule: i.rule, issue: i.message })), minor: own.length - open.length });
  }
  writeJson(path.join(qdir, 'responsive-sweep.json'), sweep);
  if (only) {
    // Section state across re-checks: locked when clean, incomplete after the third failing check.
    const sf = path.join(w.root, 'qa', 'section-state.json');
    const state = readJsonIf(sf) || { sections: {} };
    const v = verdicts[0];
    const prev = state.sections[v.index] || { checks: 0, history: [] };
    const checks = prev.checks + 1;
    const status = v.status === 'responsive' ? 'locked' : checks >= 3 ? 'incomplete' : 'open';
    state.sections[v.index] = { name: v.name, status, checks, buildId, open: v.open, history: [...prev.history, { buildId, at: new Date().toISOString(), open: v.open.length }] };
    writeJson(sf, state);
    verdicts[0].lock = status;
  }

  // ---------- scoring + gate ----------
  const frac = (c) => (c.total ? round(c.pass / c.total, 4) : null);
  const respCells = result.cells.filter((c) => c.responsive);
  const badCells = new Set(issues.filter((i) => i.category === 'responsive' && ['critical', 'major'].includes(i.severity)).map((i) => i.viewport));
  const visualPage = result.visual.length ? Math.min(...result.visual.map((v) => v.full.score)) : null;
  const visualMinSection = result.visual.length ? Math.min(...result.visual.flatMap((v) => v.sections.map((s) => s.score))) : null;
  const scores = {
    structure: frac(checks.structure),
    geometry: result.geometry.length ? Math.min(...result.geometry.map((g) => g.score)) : null,
    visual: { page: visualPage, minSection: visualMinSection },
    responsive: respCells.length ? round((respCells.length - badCells.size) / respCells.length, 4) : null,
    edge: frac(checks.edge),
    interaction: frac(checks.interaction),
  };
  const T = cfg.qa.thresholds;
  const counts = Object.fromEntries(SEV.map((s) => [s, issues.filter((i) => i.severity === s).length]));
  const failures = [];
  if (counts.critical) failures.push(`${counts.critical} critical issue(s) open`);
  if (scores.visual.page !== null && scores.visual.page < T.visual) failures.push(`visual ${scores.visual.page} < ${T.visual}`);
  if (scores.visual.minSection !== null && scores.visual.minSection < T.visualSectionFloor) failures.push(`weakest section ${scores.visual.minSection} < ${T.visualSectionFloor}`);
  if (scores.geometry !== null && scores.geometry < T.geometry) failures.push(`geometry ${scores.geometry} < ${T.geometry}`);
  if (scores.structure !== null && scores.structure < T.structure) failures.push(`structure ${scores.structure} < ${T.structure}`);
  if (scores.responsive !== null && scores.responsive < T.responsive) failures.push(`responsive ${scores.responsive} < ${T.responsive}`);
  if (scores.interaction !== null && scores.interaction < T.interaction) failures.push(`interaction ${scores.interaction} < ${T.interaction}`);
  if (scores.edge !== null && scores.edge < T.runtime) failures.push(`edge/runtime ${scores.edge} < ${T.runtime}`);
  // One section: the gate is that section's verdict; page-wide results stay informative (the full pass
  // judges them).
  const pageLevel = only ? failures.splice(0, failures.length) : [];
  if (only && verdicts[0].open.length) failures.push(`${verdicts[0].open.length} critical/major issue(s) open in section ${target.a.sectionIndex}`);

  const report = {
    schema: 'f2d-qa/1',
    slug,
    buildId,
    pass: quick || only ? null : passNo,
    quick,
    section: only ? { index: target.a.sectionIndex, name: target.name } : null,
    sectionVerdicts: verdicts,
    at: new Date().toISOString(),
    durationMs: Date.now() - t0,
    target: { os: cfg.target.os, scrollbarModes: matrix.scrollbarModes, url: '[preview url in state.json]' },
    categoriesRun: ['structure', 'geometry', 'visual', 'responsive', 'edge', 'interaction'],
    notApplicable: quick ? { edge: 'quick mode skips stress tests (long text / blocked assets / blocked fonts)' } : {},
    matrix: cells.map((c) => ({ width: c.width, ...(c.height ? { height: c.height } : {}), kind: c.kind, match: c.match })),
    scores,
    thresholds: T,
    checks,
    gate: { pass: failures.length === 0, failures, ...(only ? { pageLevel } : {}) },
    counts,
    cells: result.cells,
    visual: result.visual,
    geometry: result.geometry,
    styleConflicts: result.styleConflicts,
    sectionShots: result.sectionShots || {},
    issues: issues.map((i) => (i.section ? { ...i, sectionName: nodeName(i.section) } : i)).sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity)),
  };
  writeJson(path.join(ev, 'sections', 'manifest.json'), Object.fromEntries(result.cells.map((c) => [c.vp, { viewport: c.viewport, sections: (c.sections || []).map((x) => ({ ...x, file: (result.sectionShots?.[c.vp] || []).find((f) => f.index === x.index)?.file || null })) }])));
  writeJson(path.join(qdir, 'report.json'), report);
  writeText(path.join(qdir, 'report.md'), reportMd(report));
  let diff = null;
  if (record && !quick) diff = recordPass(cfg, slug, report);
  log.info(`QA ${quick ? 'quick' : only ? `section ${section} (${verdicts[0].lock})` : 'pass ' + passNo} on ${buildId}: gate ${report.gate.pass ? 'PASS' : 'FAIL'} in ${Math.round(report.durationMs / 1000)}s`);
  return {
    report,
    dir: qdir,
    summary: { ok: true, pass: report.pass, buildId, ...(only ? { section: verdicts[0] } : {}), gate: report.gate, scores, counts, diff: diff && { new: diff.new.length, persisting: diff.persisting.length, fixed: diff.fixed.length, regressed: diff.regressed.length }, report: path.join(qdir, 'report.md'), top: report.issues.filter((i) => i.severity !== 'info').slice(0, 15).map((i) => `${i.severity} ${i.rule} ${i.viewport || ''}: ${i.message}`) },
  };
}

function reportMd(r) {
  const s = r.scores;
  const lines = [
    `# QA ${r.quick ? 'quick check' : r.section ? `section ${r.section.index} (${r.section.name})` : 'pass ' + r.pass} — ${r.slug} — build ${r.buildId}`,
    '',
    `Gate: **${r.gate.pass ? 'PASS' : 'FAIL'}**${r.gate.failures.length ? ' — ' + r.gate.failures.join('; ') : ''}`,
    '',
    '| Category | Score | Threshold |',
    '|---|---|---|',
    `| Structure | ${s.structure} | ${r.thresholds.structure} |`,
    `| Geometry | ${s.geometry} | ${r.thresholds.geometry} |`,
    `| Visual (page / weakest section) | ${s.visual.page} / ${s.visual.minSection} | ${r.thresholds.visual} / ${r.thresholds.visualSectionFloor} |`,
    `| Responsive | ${s.responsive} | ${r.thresholds.responsive} |`,
    `| Edge / runtime | ${s.edge} | ${r.thresholds.runtime} |`,
    `| Interaction | ${s.interaction} | ${r.thresholds.interaction} |`,
    '',
    `Issues: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ')}. Matrix: ${r.matrix.map((c) => c.width).join(', ')} (${r.target.scrollbarModes.join('+')} scrollbars).`,
    '',
    '## Sections (visual)',
    '',
    '| # | Section | Score | SSIM | Pixel | Edge |',
    '|---|---|---|---|---|---|',
    ...(r.visual[0]?.sections || []).map((x) => `| ${x.index} | ${x.name} | ${x.score} | ${x.ssim} | ${x.pixel} | ${x.edge} |`),
    '',
    '## Responsive verdict per section',
    '',
    'Every section is checked at every width and rotation (3840 → 320, landscape phones and tablets); detail per viewport in `responsive-sweep.json`.',
    '',
    '| # | Section | Verdict | Open (critical/major) | Minor |',
    '|---|---|---|---|---|',
    ...(r.sectionVerdicts || []).map((v) => `| ${v.index} | ${v.name} | ${v.status}${v.lock ? ` (${v.lock})` : ''} | ${v.open.length ? v.open.slice(0, 4).map((o) => `${o.width}: ${o.rule.replace('responsive.', '')}`).join('; ') + (v.open.length > 4 ? ` … +${v.open.length - 4}` : '') : '—'} | ${v.minor} |`),
    '',
    '## Responsive results per viewport',
    '',
    '| Viewport | Client width | Overflow | Overlaps | Covered | Cut | Broken words | Squeezed | Dead gutters | Section shots |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...r.cells.filter((c) => c.responsive).map((c) => `| ${c.vp} | ${c.viewport?.client ?? ''} | ${c.responsive.overflowX} | ${c.responsive.overlaps} | ${c.responsive.covered ?? 0} | ${c.responsive.cut} | ${c.responsive.brokenWords} | ${c.responsive.squeezed} | ${c.responsive.gutters} | ${(r.sectionShots[c.vp] || []).length} |`),
    '',
    '## Responsive failures by section',
    '',
    '| Section | Viewport | Severity | Failure | Likely cause | Proposed repair |',
    '|---|---|---|---|---|---|',
    ...r.issues.filter((i) => i.category === 'responsive' && ['critical', 'major'].includes(i.severity)).sort((a, b) => String(a.sectionName || '').localeCompare(String(b.sectionName || '')) || String(a.viewport).localeCompare(String(b.viewport))).map((i) => `| ${i.sectionName || '(page)'} | ${i.viewport || ''} | ${i.severity} | ${i.message.replace(/\|/g, '/')} | ${i.cause || ''} | ${i.repair || ''} |`),
    '',
    '## Issues (critical / major)',
    '',
    ...r.issues.filter((i) => ['critical', 'major'].includes(i.severity)).map((i) => `- **${i.severity}** \`${i.id}\` ${i.rule} ${i.viewport || ''} — ${i.message}`),
    '',
  ];
  return lines.join('\n');
}
