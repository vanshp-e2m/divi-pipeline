// Persistent issue ledger: stable ids across passes, status transitions, regressions, stuck issues.
//   open -> fixed (not observed in a later full pass) -> regressed (observed again)
//   open for >= 2 passes with >= 2 repairs targeting it -> stuck (its fix family is not re-applied)
import { readJsonIf, writeJson } from '../util/core.mjs';
import { ws } from '../workspace.mjs';

export const EMPTY_LEDGER = { schema: 'f2d-ledger/1', issues: {}, passes: [] };

export function loadLedger(cfg, slug) {
  return readJsonIf(ws(cfg, slug).ledger, structuredClone(EMPTY_LEDGER));
}

// Merge one full QA pass into the ledger. Returns the diff (new / persisting / fixed / regressed).
export function recordPass(cfg, slug, report) {
  const w = ws(cfg, slug);
  const L = loadLedger(cfg, slug);
  const seen = new Set();
  const diff = { new: [], persisting: [], fixed: [], regressed: [] };
  for (const i of report.issues) {
    seen.add(i.id);
    const prev = L.issues[i.id];
    const entry = { pass: report.pass, build: report.buildId, severity: i.severity, measured: i.measured ?? null };
    if (!prev) {
      L.issues[i.id] = { ...pick(i), status: 'open', firstSeen: entry, lastSeen: entry, history: [{ ...entry, status: 'open' }], repairs: [] };
      diff.new.push(i.id);
    } else {
      const was = prev.status;
      Object.assign(prev, pick(i));
      prev.lastSeen = entry;
      prev.status = was === 'fixed' ? 'regressed' : was === 'accepted' ? 'accepted' : was === 'stuck' ? 'stuck' : 'open';
      if (prev.status === 'open' && prev.history.filter((h) => h.status !== 'fixed').length >= 2 && prev.repairs.length >= 2) prev.status = 'stuck';
      prev.history.push({ ...entry, status: prev.status });
      (prev.status === 'regressed' ? diff.regressed : diff.persisting).push(i.id);
    }
  }
  for (const [id, it] of Object.entries(L.issues)) {
    if (seen.has(id) || it.status === 'fixed' || it.status === 'accepted') continue;
    it.status = 'fixed';
    it.history.push({ pass: report.pass, build: report.buildId, status: 'fixed' });
    diff.fixed.push(id);
  }
  L.passes.push({ pass: report.pass, buildId: report.buildId, at: report.at, scores: report.scores, gate: report.gate, counts: report.counts, diff: { new: diff.new.length, persisting: diff.persisting.length, fixed: diff.fixed.length, regressed: diff.regressed.length } });
  writeJson(w.ledger, L);
  return diff;
}

const pick = (i) => ({ id: i.id, rule: i.rule, category: i.category, severity: i.severity, nodeId: i.nodeId ?? null, cls: i.cls ?? null, section: i.section ?? null, viewport: i.viewport ?? null, message: i.message, evidence: i.evidence ?? null });

export function linkRepairs(cfg, slug, issueIds, repairId) {
  const L = loadLedger(cfg, slug);
  for (const id of issueIds) if (L.issues[id] && !L.issues[id].repairs.includes(repairId)) L.issues[id].repairs.push(repairId);
  writeJson(ws(cfg, slug).ledger, L);
}

export function ledgerSummary(cfg, slug) {
  const L = loadLedger(cfg, slug);
  const by = (k) => Object.values(L.issues).reduce((a, i) => ((a[i[k]] = (a[i[k]] || 0) + 1), a), {});
  const open = Object.values(L.issues).filter((i) => ['open', 'regressed', 'stuck'].includes(i.status));
  return {
    passes: L.passes.map((p) => ({ pass: p.pass, build: p.buildId, gate: p.gate?.pass, scores: p.scores, diff: p.diff })),
    status: by('status'),
    openBySeverity: open.reduce((a, i) => ((a[i.severity] = (a[i.severity] || 0) + 1), a), {}),
    openCritical: open.filter((i) => i.severity === 'critical').map((i) => ({ id: i.id, rule: i.rule, viewport: i.viewport, message: i.message })),
  };
}
