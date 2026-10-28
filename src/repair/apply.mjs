// Applying repairs: deterministic rules for well-understood defects, agent patch files, reverts.
// Every repair is validated, linked to the ledger issues it targets, and only takes effect through
// a rebuild (both compilers) + redeploy + a recorded QA pass that measures it.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, readJsonIf, writeJson, F2DError } from '../util/core.mjs';
import { ws } from '../workspace.mjs';
import { addRepairs, revertRepair, loadRepairs } from './repairs.mjs';
import { linkRepairs, loadLedger } from '../qa/ledger.mjs';
import { latestPass } from './context.mjs';
import { tierOf } from '../layout/engine.mjs';

const ctxFor = (cfg, slug) => ({ os: cfg.target.os, ir: readJson(ws(cfg, slug).ir) });
// Design-width cells repair the base CSS; any other width the ladder tier covering it, so a fix at
// 1024px never moves the design width and a laptop fix never lands on a phone tier.
const bpFor = (vp, frameW = 1920) => {
  const w = Number((String(vp).match(/^[dw](\d+)/) || [])[1]);
  return String(vp).startsWith('d') ? 'base' : w > frameW ? 'wide' : tierOf(w);
};

function record(cfg, slug, entries) {
  const w = ws(cfg, slug);
  const added = addRepairs(w.repairs, entries, ctxFor(cfg, slug));
  for (const e of added) linkRepairs(cfg, slug, e.issues || [], e.id);
  return added;
}

export function applyFile(cfg, slug, file) {
  const doc = readJson(path.resolve(file));
  const entries = (doc.repairs || doc).map((e) => ({ author: 'agent', pass: latestPass(cfg, slug).last.pass, ...e }));
  const added = record(cfg, slug, entries);
  return { ok: true, added: added.map((e) => ({ id: e.id, target: e.target, op: e.op, bp: e.bp, issues: e.issues })), skippedDuplicates: entries.length - added.length };
}

export function revert(cfg, slug, id, reason) {
  return { ok: true, reverted: revertRepair(ws(cfg, slug).repairs, id, reason) };
}

// ---------- deterministic rules ----------
// Each rule: (issue, ctx) -> repair entries | []. Rules never touch a group the ledger marks stuck.
const RULES = [
  {
    // A text-free vector/image wider than most of the frame that collides with content at a narrow
    // width is a decorative layer (mask/curve), not content: mark it decor so it stays a clipped
    // background layer instead of joining the stacked flow.
    name: 'decor-wide-vector',
    match: (i) => i.rule === 'responsive.overlap',
    make: (i, { ir }) => {
      const out = [];
      for (const cls of String(i.key || '').split('|')) {
        const n = Object.values(ir.nodes).find((x) => x.cls === cls);
        if (!n || n.text || n.a.decor) continue;
        const frameW = ir.frames[0].width;
        if (['svg', 'shape'].includes(n.a.role) && n.box.w >= frameW * 0.8 && !n.interactions.length) {
          out.push({ target: n.id, op: 'ir', set: { 'a.decor': true }, reason: `"${n.name}" is a ${Math.round(n.box.w)}px text-free vector that overlaps content at ${i.viewport}: treat as a decorative layer (stays absolute + clipped)`, issues: [i.id] });
        }
      }
      return out;
    },
  },
  {
    // Horizontal overflow caused by a fixed-width element at a narrow width: let it shrink.
    name: 'shrink-overflowing-fixed-width',
    match: (i) => ['responsive.overflow-x', 'responsive.offscreen'].includes(i.rule) && bpFor(i.viewport) !== 'base',
    make: (i, { ir }) => {
      const out = [];
      const list = i.evidence?.offenders || i.evidence?.elements || [];
      for (const o of list.slice(0, 6)) {
        const n = Object.values(ir.nodes).find((x) => x.cls === o.cls);
        if (!n || n.a.decor) continue;
        out.push({ target: n.id, op: 'css', bp: bpFor(i.viewport), set: { 'max-width': '100%', 'min-width': '0' }, reason: `"${n.name}" extends past the viewport at ${i.viewport} (right edge ${o.right}px): allow it to shrink to its container`, issues: [i.id] });
      }
      return out;
    },
  },
  {
    // Text clipped at a narrow width because a fixed height was kept: let the block grow.
    name: 'unclip-text-height',
    match: (i) => i.rule === 'responsive.text-clipped' && bpFor(i.viewport) !== 'base',
    make: (i) => (i.nodeId ? [{ target: i.nodeId, op: 'css', bp: bpFor(i.viewport), set: { height: 'auto', overflow: 'visible' }, reason: `Text clipped at ${i.viewport}: fixed height from the desktop design does not fit the wrapped text`, issues: [i.id] }] : []),
  },
];

export async function autoRepair(cfg, slug) {
  const { report, last } = latestPass(cfg, slug);
  const L = loadLedger(cfg, slug);
  const ctx = ctxFor(cfg, slug);
  const proposals = [];
  for (const i of report.issues) {
    if (['stuck', 'accepted'].includes(L.issues[i.id]?.status)) continue;
    for (const r of RULES) if (r.match(i)) for (const e of r.make(i, ctx)) proposals.push({ ...e, author: `rule:${r.name}`, pass: last.pass });
  }
  // Merge duplicates (same target/op/bp/set) and their issue lists.
  const merged = new Map();
  for (const p of proposals) {
    const k = JSON.stringify([p.target, p.op, p.bp || 'base', p.set]);
    if (merged.has(k)) merged.get(k).issues.push(...p.issues);
    else merged.set(k, { ...p, issues: [...p.issues] });
  }
  const added = merged.size ? record(cfg, slug, [...merged.values()]) : [];
  return { ok: true, pass: last.pass, proposed: merged.size, added: added.map((e) => ({ id: e.id, rule: e.author, target: e.target, op: e.op, bp: e.bp, set: e.set, issues: e.issues.length })) };
}
