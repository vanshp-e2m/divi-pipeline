// fix-context: the latest recorded pass, grouped by root cause, with everything a repairer needs
// (evidence paths, node facts, current CSS per breakpoint, repairs already tried, stuck flags).
import path from 'node:path';
import { readJson, readJsonIf, F2DError } from '../util/core.mjs';
import { ws } from '../workspace.mjs';
import { loadLedger } from '../qa/ledger.mjs';
import { loadRepairs } from './repairs.mjs';

export function latestPass(cfg, slug) {
  const w = ws(cfg, slug);
  const L = loadLedger(cfg, slug);
  const last = L.passes.at(-1);
  if (!last) throw new F2DError('E_NO_PASS', 'No recorded QA pass yet — run "f2d qa"');
  return { L, last, report: readJson(path.join(w.qa(last.buildId, last.pass), 'report.json')), dir: w.qa(last.buildId, last.pass) };
}

export function fixContext(cfg, slug, { limit = 40 } = {}) {
  const w = ws(cfg, slug);
  const { L, last, report, dir } = latestPass(cfg, slug);
  const ir = readJson(w.ir);
  const layout = readJsonIf(path.join(w.build(last.buildId), 'layout.json'));
  const repairs = loadRepairs(w.repairs);
  const boxById = new Map();
  if (layout) {
    const idx = (b) => (boxById.set(b.id, b), b.children.forEach(idx));
    idx(layout.root);
  }
  const N = ir.nodes;
  const node = (id) => {
    const n = N[id];
    if (!n) return null;
    const b = boxById.get(id);
    return { id, cls: n.cls, name: n.name, role: n.a.role, decor: !!n.a.decor, box: n.box, layout: n.layout || n.a.inferredLayout || null, parent: n.parent && { id: n.parent, name: N[n.parent]?.name, role: N[n.parent]?.a.role }, css: b?.css || null };
  };
  // Group: same rule on the same element (or section) across viewports is one cause.
  const groups = new Map();
  for (const i of report.issues) {
    if (i.severity === 'info') continue;
    const led = L.issues[i.id];
    if (led?.status === 'accepted') continue;
    const key = `${i.rule}|${i.nodeId || i.cls || i.section || i.key || 'page'}`;
    if (!groups.has(key)) groups.set(key, { key, rule: i.rule, category: i.category, severity: i.severity, nodeId: i.nodeId || null, issues: [], viewports: [], status: new Set(), tried: new Set() });
    const g = groups.get(key);
    g.issues.push(i.id);
    if (i.viewport) g.viewports.push(i.viewport);
    if (['critical', 'major', 'minor'].indexOf(i.severity) < ['critical', 'major', 'minor'].indexOf(g.severity)) g.severity = i.severity;
    g.message ??= i.message;
    g.evidence ??= i.evidence;
    g.measured ??= i.measured;
    if (led) g.status.add(led.status), led.repairs.forEach((r) => g.tried.add(r));
  }
  const rank = { critical: 0, major: 1, minor: 2 };
  const list = [...groups.values()]
    .map((g) => ({
      ...g,
      status: [...g.status],
      stuck: g.status.has('stuck'),
      regression: g.status.has('regressed'),
      tried: [...g.tried].map((id) => repairs.entries.find((e) => e.id === id)).filter(Boolean).map((e) => ({ id: e.id, target: e.target, op: e.op, bp: e.bp, set: e.set, reason: e.reason, reverted: !!e.reverted })),
      node: g.nodeId ? node(g.nodeId) : null,
    }))
    .sort((a, b) => (b.regression - a.regression) || rank[a.severity] - rank[b.severity] || b.viewports.length - a.viewports.length);
  return {
    slug,
    pass: last.pass,
    buildId: last.buildId,
    reportDir: dir,
    gate: report.gate,
    scores: report.scores,
    sections: report.visual[0]?.sections.map((s) => ({ index: s.index, name: s.name, id: s.id, score: s.score, evidence: s.evidence || null })),
    // Screenshot of every section at every major viewport (relative to reportDir). Review them all.
    sectionShots: Object.fromEntries(Object.entries(report.sectionShots || {}).map(([vp, list]) => [vp, list.map((x) => ({ index: x.index, name: x.name, file: x.file }))])),
    groups: list.slice(0, limit),
    totalGroups: list.length,
    rules: {
      howToRepair: 'Write {"repairs":[{target, op:"css"|"ir"|"font", bp, set, unset, reason, issues:[ids]}]} and run "f2d repair --apply FILE". CSS repairs target IR node ids and apply to BOTH compilers. No !important, no vw widths (Windows), no fixed pixel offsets without a measured cause. Prefer fixing the layout rule (flex/size/wrap) over moving elements.',
      doNotRetry: list.filter((g) => g.stuck).map((g) => g.key),
    },
  };
}
