// Repairs: ordered, validated overrides applied on top of the IR / box tree. Both compilers read
// the patched tree, so a repair can never fix the HTML preview while leaving Divi unchanged.
//
// f2d-repairs/1 entry:
// { id, pass, issues: [issueId], target: <nodeId>, op: 'css' | 'ir' | 'font',
//   bp: a ladder tier — 'wide' (above the design width) | 'base' | 'narrow' (laptop) | 'tabletExtra' |
//       'tablet' | 'mobileExtra' | 'phone' (DEV Connect names widescreen/laptop/tablet_extra/mobile_extra
//       are accepted and normalised), set: {...}, unset: [...], reason, author: 'rule:<name>'|'agent', at }
import { F2DError, readJsonIf, writeJson, sha } from '../util/core.mjs';

export const BPS = ['wide', 'base', 'narrow', 'tabletExtra', 'tablet', 'mobileExtra', 'phone'];
const ALIAS = { widescreen: 'wide', laptop: 'narrow', tablet_extra: 'tabletExtra', mobile_extra: 'mobileExtra', mobile: 'phone', desktop: 'base' };
export const normBp = (bp) => ALIAS[bp] || bp || 'base';

export const EMPTY = { schema: 'f2d-repairs/1', entries: [] };

const FORBIDDEN_VALUE = [/!important/i, /expression\(/i, /javascript:/i, /<\/?script/i];
const VW = /\b\d*\.?\d+vw\b/;

export function validateEntry(e, { os = 'windows', ir } = {}) {
  const errs = [];
  if (!e.target) errs.push('target required');
  if (!['css', 'ir', 'font'].includes(e.op)) errs.push(`unknown op ${e.op}`);
  if (e.op === 'css' && !BPS.includes(normBp(e.bp))) errs.push(`bp must be one of ${BPS.join('|')}`);
  if (!e.reason || e.reason.length < 8) errs.push('reason required (what evidence, what root cause)');
  if (ir && e.op !== 'font' && e.target !== '*' && !ir.nodes[e.target]) errs.push(`target ${e.target} not in IR`);
  for (const [k, v] of Object.entries(e.set || {})) {
    const s = String(v);
    if (FORBIDDEN_VALUE.some((re) => re.test(s))) errs.push(`${k}: forbidden value ${s}`);
    if (e.op === 'css' && os !== 'macos' && VW.test(s) && /width|left|right|margin|padding/.test(k)) errs.push(`${k}: vw units overflow under Windows scrollbars`);
    if (e.op === 'css' && !/^[a-z-]+$/.test(k)) errs.push(`bad css property ${k}`);
  }
  if (e.op === 'ir') {
    for (const k of Object.keys(e.set || {})) if (!/^(a\.[a-zA-Z.]+|text\.(align|autoResize|maxLines)|sizing\.[wh]|positioning|clips|opacity|layout\.(gap|padding|justify|align|wrap|dir))$/.test(k)) errs.push(`ir path ${k} is not repairable`);
  }
  return errs;
}

export function loadRepairs(path) {
  return readJsonIf(path, structuredClone(EMPTY));
}

export function addRepairs(path, newEntries, ctx) {
  const doc = loadRepairs(path);
  const added = [];
  for (const e of newEntries) {
    const errs = validateEntry(e, ctx);
    if (errs.length) throw new F2DError('E_REPAIR_INVALID', `Repair for ${e.target} rejected: ${errs.join('; ')}`, { entry: e, errs });
    const entry = { bp: 'base', set: {}, unset: [], ...e, at: e.at || new Date().toISOString() };
    entry.bp = normBp(entry.bp);
    entry.id = entry.id || 'R' + sha([entry.target, entry.op, entry.bp, entry.set, entry.unset], 8);
    // Same repair twice is a no-op, not a stack of identical overrides.
    if (doc.entries.some((x) => x.id === entry.id && !x.reverted)) continue;
    doc.entries.push(entry);
    added.push(entry);
  }
  writeJson(path, doc);
  return added;
}

export function revertRepair(path, id, reason) {
  const doc = loadRepairs(path);
  const e = doc.entries.find((x) => x.id === id);
  if (!e) throw new F2DError('E_REPAIR', `No repair ${id}`);
  e.reverted = { at: new Date().toISOString(), reason };
  writeJson(path, doc);
  return e;
}

const active = (doc) => doc.entries.filter((e) => !e.reverted);

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let o = obj;
  for (const k of parts.slice(0, -1)) o = o[k] ??= {};
  o[parts.at(-1)] = value;
}

// IR-level overrides (before layout).
export function applyIrRepairs(ir, doc) {
  for (const e of active(doc).filter((x) => x.op === 'ir')) {
    const n = ir.nodes[e.target];
    if (!n) continue;
    for (const [k, v] of Object.entries(e.set)) setPath(n, k, v);
  }
  return ir;
}

// Font substitutions/overrides recorded as repairs.
export function fontRepairs(doc) {
  const out = {};
  for (const e of active(doc).filter((x) => x.op === 'font')) out[e.target] = { ...(out[e.target] || {}), ...e.set };
  return out;
}

// Box-tree CSS overrides (after layout, before both compilers).
export function applyCssRepairs(tree, doc) {
  const byId = new Map();
  const index = (b) => (byId.set(b.id, b), b.children.forEach(index));
  index(tree.root);
  const applied = [];
  for (const e of active(doc).filter((x) => x.op === 'css')) {
    const b = byId.get(e.target);
    if (!b) continue;
    const css = (b.css[normBp(e.bp)] ??= {});
    for (const k of e.unset || []) delete css[k];
    Object.assign(css, e.set);
    applied.push(e.id);
  }
  return applied;
}
