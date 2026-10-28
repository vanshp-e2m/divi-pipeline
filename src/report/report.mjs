// Final report: what was built, how every pass measured, what is still wrong (with evidence),
// what was approximated, and how to reproduce. Numbers come only from recorded QA reports.
import path from 'node:path';
import { readJson, readJsonIf, writeJson, writeText, F2DError } from '../util/core.mjs';
import { ws, loadState } from '../workspace.mjs';
import { loadLedger } from '../qa/ledger.mjs';
import { loadRepairs } from '../repair/repairs.mjs';

export function writeReport(cfg, slug) {
  const w = ws(cfg, slug);
  const L = loadLedger(cfg, slug);
  if (!L.passes.length) throw new F2DError('E_NO_PASS', 'No recorded QA passes to report on');
  const st = loadState(w);
  const last = L.passes.at(-1);
  const final = readJson(path.join(w.qa(last.buildId, last.pass), 'report.json'));
  const manifest = readJson(path.join(w.build(last.buildId), 'manifest.json'));
  const plan = readJsonIf(w.plan);
  const input = readJsonIf(w.inputManifest);
  const repairs = loadRepairs(w.repairs);
  const open = Object.values(L.issues).filter((i) => ['open', 'regressed', 'stuck'].includes(i.status));
  const bySev = (s) => open.filter((i) => i.severity === s);
  const fmt = (v) => (v === null || v === undefined ? 'n/a' : typeof v === 'number' ? v.toFixed(3) : v);
  const rel = (p) => path.relative(w.root, p).split(path.sep).join('/');
  const s = final.scores;

  const md = [
    `# figma2divi report: ${slug}`,
    '',
    `Final build \`${last.buildId}\` (pass ${last.pass}), Divi page id ${st.post?.id ?? '?'} (${manifest.target?.adapter}, ${plan?.target?.divi ?? '?'}), target OS ${cfg.target.os}. Generated ${new Date().toISOString()}.`,
    '',
    `## Result: ${final.gate.pass ? 'PASSED' : 'NOT PASSED'}`,
    '',
    final.gate.pass ? 'All acceptance gates met with zero open critical issues.' : `Gate failures: ${final.gate.failures.join('; ')}.`,
    '',
    '| Metric | Final | Threshold |',
    '|---|---|---|',
    `| Visual similarity, full page @${final.matrix.find((c) => c.kind === 'design')?.width}px | ${fmt(s.visual.page)} | ${cfg.qa.thresholds.visual} |`,
    `| Visual similarity, weakest section | ${fmt(s.visual.minSection)} | ${cfg.qa.thresholds.visualSectionFloor} |`,
    `| Geometry (elements within ±${cfg.qa.geometryTolerance.px}px / ${cfg.qa.geometryTolerance.ratio * 100}%) | ${fmt(s.geometry)} | ${cfg.qa.thresholds.geometry} |`,
    `| Structure | ${fmt(s.structure)} | ${cfg.qa.thresholds.structure} |`,
    `| Responsive (cells without critical/major defects) | ${fmt(s.responsive)} | ${cfg.qa.thresholds.responsive} |`,
    `| Edge / runtime | ${fmt(s.edge)} | ${cfg.qa.thresholds.runtime} |`,
    `| Interaction | ${fmt(s.interaction)} | ${cfg.qa.thresholds.interaction} |`,
    `| Open issues | ${open.length} (${bySev('critical').length} critical, ${bySev('major').length} major, ${bySev('minor').length} minor, ${bySev('info').length} info) | 0 critical |`,
    '',
    `Visual similarity = (${cfg.qa.weights.ssim}·SSIM + ${cfg.qa.weights.pixel}·(1 − pixel mismatch) + ${cfg.qa.weights.edge}·edge F1 + ${cfg.qa.weights.color}·colour-histogram intersection) × height ratio, against the Figma PNG at the frame width with the page width matched to the frame (scrollbar compensated). Weights and SSIM k1 were selected by calibration; see \`docs/SCORING.md\` for the validation and its limits.`,
    '',
    '## Passes',
    '',
    '| Pass | Build | Gate | Visual | Weakest section | Geometry | Responsive | Critical | Major | New | Fixed | Regressed |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...L.passes.map((p) => `| ${p.pass} | \`${p.buildId}\` | ${p.gate.pass ? 'pass' : 'fail'} | ${fmt(p.scores.visual.page)} | ${fmt(p.scores.visual.minSection)} | ${fmt(p.scores.geometry)} | ${fmt(p.scores.responsive)} | ${p.counts.critical} | ${p.counts.major} | ${p.diff.new} | ${p.diff.fixed} | ${p.diff.regressed} |`),
    '',
    '## Sections (final pass)',
    '',
    '| # | Section | Visual | SSIM | Pixel | Edge |',
    '|---|---|---|---|---|---|',
    ...(final.visual[0]?.sections || []).map((x) => `| ${x.index} | ${x.name} | ${fmt(x.score)} | ${fmt(x.ssim)} | ${fmt(x.pixel)} | ${fmt(x.edge)} |`),
    '',
    ...(final.sectionVerdicts?.length ? [
      '## Responsive verdict per section (final pass)',
      '',
      `Each section checked at ${final.matrix.length} viewports (${final.matrix.filter((c) => !c.height).map((c) => c.width).join(', ')}; rotated ${final.matrix.filter((c) => c.height).map((c) => `${c.width}×${c.height}`).join(', ')}) — overflow, cut / covered / overlapping / collapsed content, spill into the next section, broken words, tap targets, orphan words, uneven cards, lonely last card, distorted images, cramped edges, 4K containment, sticky header + drawer. Detail: \`${rel(path.join(w.qa(last.buildId, last.pass), 'responsive-sweep.json'))}\`.`,
      '',
      '| # | Section | Verdict | Open (critical/major) | Minor |',
      '|---|---|---|---|---|',
      ...final.sectionVerdicts.map((v) => `| ${v.index} | ${v.name} | ${v.status} | ${v.open.length ? v.open.slice(0, 4).map((o) => `${o.width}: ${o.rule.replace('responsive.', '')}`).join('; ') + (v.open.length > 4 ? ` … +${v.open.length - 4}` : '') : '—'} | ${v.minor} |`),
      '',
    ] : []),
    '## Outstanding issues (critical and major)',
    '',
    ...(open.filter((i) => i.severity !== 'minor' && i.severity !== 'info').map((i) => `- **${i.severity}** \`${i.id}\` ${i.rule} ${i.viewport || ''} — ${i.message}${i.status === 'stuck' ? ' _(stuck: survived 2 repairs)_' : ''}`)),
    open.filter((i) => i.severity === 'critical' || i.severity === 'major').length ? '' : '_None._',
    '',
    `Minor: ${bySev('minor').length} (see \`ledger.json\`).`,
    '',
    '## Repairs',
    '',
    `${repairs.entries.length} repairs recorded, ${repairs.entries.filter((e) => e.reverted).length} reverted.`,
    '',
    ...repairs.entries.map((e) => `- \`${e.id}\` pass ${e.pass} ${e.author} → ${e.op}${e.bp && e.op === 'css' ? '@' + e.bp : ''} on \`${e.target}\` ${JSON.stringify(e.set)}${e.reverted ? ` — **reverted** (${e.reverted.reason})` : ''}: ${e.reason}`),
    '',
    '## Divi mapping',
    '',
    `Sections ${manifest.divi.sections}, rows ${manifest.divi.rows}, modules: ${Object.entries(manifest.divi.counts).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
    '',
    `Fallbacks (${manifest.divi.fallbacks.length}): ${summarise(manifest.divi.fallbacks.map((f) => f.reason))}`,
    '',
    `Unsupported (${manifest.divi.unsupported.length}): ${manifest.divi.unsupported.map((u) => u.reason).join('; ') || 'none'}.`,
    '',
    '## Limitations and assumptions',
    '',
    ...(plan?.risks || []).filter((r) => r.severity !== 'info' && !['resolved', 'dismissed'].includes(r.status)).map((r) => `- ${r.severity}: ${r.description} _Mitigation:_ ${r.mitigation}`),
    ...(plan?.responsive?.assumptions || []).map((a) => `- assumption: ${a}`),
    ...(plan?.questions || []).map((q) => `- open question: ${q}`),
    '',
    ...((plan?.risks || []).some((r) => r.status === 'resolved') ? ['## Resolved risks', '', ...plan.risks.filter((r) => r.status === 'resolved').map((r) => `- ${r.kind}: ${r.resolution || r.mitigation}`), ''] : []),
    '## Artifacts',
    '',
    `- Input manifest: \`${rel(w.inputManifest)}\` (${input?.nodes} nodes, ${input?.assets?.referenced} assets)`,
    `- Plan: \`${rel(w.plan)}\` (v${plan?.version})`,
    `- Final build: \`${rel(w.build(last.buildId))}\` — preview, Divi layout, scoped CSS, manifest`,
    `- QA reports + evidence: \`${rel(path.join(w.root, 'qa'))}\``,
    `- Ledger: \`${rel(w.ledger)}\`, repairs: \`${rel(w.repairs)}\``,
    '',
    '## Reproduce',
    '',
    '```',
    `f2d run ${slug}              # analyze → plan → build → deploy → 3 QA/repair passes → final validation → report`,
    `f2d rollback ${slug} --build <id>   # restore any previous build`,
    '```',
    '',
  ].join('\n');
  const file = writeText(path.join(w.reports, 'final-report.md'), md);
  const json = { schema: 'f2d-report/1', slug, finalBuild: last.buildId, pass: last.pass, gate: final.gate, scores: final.scores, passes: L.passes, open: open.map((i) => ({ id: i.id, severity: i.severity, rule: i.rule, viewport: i.viewport, message: i.message })) };
  writeJson(path.join(w.reports, 'final-report.json'), json);
  return { ok: true, file, gate: final.gate, scores: final.scores, open: { critical: bySev('critical').length, major: bySev('major').length, minor: bySev('minor').length } };
}

function summarise(reasons) {
  const c = {};
  for (const r of reasons) c[r] = (c[r] || 0) + 1;
  return Object.entries(c).map(([r, n]) => `${n}× ${r}`).join('; ') || 'none.';
}

// Final report for the agent-judged QA (the DEV Connect model): the verdict is the f2d-qa agent's,
// backed by the evidence it recorded per section; the functional check is the objective part.
export function writeAgentReport(cfg, slug, { verdict, check, stateCheck, problems = [] } = {}) {
  const w = ws(cfg, slug);
  const st = loadState(w);
  const state = readJsonIf(path.join(w.root, 'qa', 'agent', 'section-qa-state.json')) || { sections: [] };
  verdict ??= readJsonIf(path.join(w.root, 'qa', 'agent', 'verdict.json'));
  if (!verdict) throw new F2DError('E_NO_VERDICT', 'No qa/agent/verdict.json — the f2d-qa agent has not finished');
  const buildId = st.deployed?.at(-1)?.buildId;
  const plan = readJsonIf(w.plan);
  const repairs = loadRepairs(w.repairs);
  const active = repairs.entries.filter((e) => !e.reverted);
  const rel = (p) => path.relative(w.root, p).split(path.sep).join('/');
  const passed = verdict.verdict === 'PASS' && !problems.length;
  const cell = (v) => (v === null || v === undefined ? '—' : v);
  const md = [
    `# figma2divi report: ${slug}`,
    '',
    `Final build \`${buildId}\`, Divi page id ${st.post?.id ?? '?'} (draft), target OS ${cfg.target.os}. Generated ${new Date().toISOString()}.`,
    '',
    `## Result: ${passed ? 'PASSED' : verdict.verdict === 'BLOCKED' ? 'BLOCKED' : 'NOT PASSED'}`,
    '',
    `Verdict of the f2d-qa agent: **${verdict.verdict}**${verdict.reason ? ` (${verdict.reason})` : ''}. QA is judged by the agent section by section against the Figma design (DEV Connect model); similarity figures below are evidence it recorded, not a gate.`,
    ...(problems.length ? ['', `Not accepted by the pipeline: ${problems.join('; ')}.`] : []),
    '',
    '## Functional checks (objective)',
    '',
    `${check?.checks?.length ?? '?'} checks on the final build — ${check?.pass ? 'all hold' : `${check?.blocking} failing`}. Detail: \`${check?.file || 'qa/agent/<build>/check.json'}\`.`,
    ...(check?.failed?.length ? ['', ...check.failed.map((f) => `- ${f}`)] : []),
    '',
    '## Sections (agent verdict)',
    '',
    `| # | Section | Status | Similarity @${state.design_width || '?'} (evidence) | Iterations | Responsive | Open | Notes |`,
    '|---|---|---|---|---|---|---|---|',
    ...state.sections.map((s) => `| ${s.index} | ${s.name} | ${s.status} | ${cell(s.similarity_by_width?.[state.design_width])}${s.below_98_reason ? ' ¹' : ''} | ${s.iterations?.length || 0} | ${s.responsive?.status || '—'} (${s.responsive?.widths_checked?.length || 0} widths) | ${(s.responsive?.open || []).map((o) => `${o.width}: ${o.issue}`).join('; ').replace(/\|/g, '/') || '—'} | ${(s.notes || '').replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 160)} |`),
    '',
    ...state.sections.filter((s) => s.below_98_reason).map((s) => `¹ ${s.name}: ${s.below_98_reason}`),
    '',
    '## Header and drawer',
    '',
    `${state.drawer?.status || '—'} — ${state.drawer?.notes || ''} ${verdict.drawer ? JSON.stringify(verdict.drawer) : ''}`,
    '',
    '## Deviations from Figma (deliberate, for UX)',
    '',
    ...((state.ux_deviations || verdict.ux_deviations || []).length ? (state.ux_deviations || verdict.ux_deviations).map((d) => `- ${typeof d === 'string' ? d : JSON.stringify(d)}`) : ['_None recorded._']),
    '',
    '## Compiler findings (systemic causes for the compiler, from the agent)',
    '',
    ...((state.compiler_findings || verdict.compiler_findings || []).length ? (state.compiler_findings || verdict.compiler_findings).map((d) => `- ${typeof d === 'string' ? d : JSON.stringify(d)}`) : ['_None._']),
    '',
    `## Repairs (${active.length} active)`,
    '',
    ...active.map((e) => `- \`${e.id}\` ${e.op} ${e.target}${e.bp && e.bp !== 'base' ? ' @' + e.bp : ''}: ${e.reason}`),
    '',
    ...(verdict.questions?.length ? ['## Questions for you', '', ...verdict.questions.map((q) => `- ${q}`), ''] : []),
    '## Limitations and assumptions',
    '',
    ...(plan?.limitations || []).map((l) => `- ${l}`),
    ...(plan?.risks || []).filter((r) => r.status !== 'resolved' && ['critical', 'major'].includes(r.severity)).map((r) => `- ${r.kind}: ${r.description}`),
    '',
    '## Agent notes',
    '',
    verdict.notes || '_None._',
    ...(stateCheck && !stateCheck.ok ? ['', `State file problems: ${stateCheck.errors.join('; ')}`] : []),
    '',
    '## Artifacts',
    '',
    `- Section state: \`qa/agent/section-qa-state.json\`; verdict: \`qa/agent/verdict.json\``,
    `- Evidence (shots, diffs, side-by-sides, sweeps, measurements): \`qa/agent/${buildId}/\``,
    `- Plan: \`${rel(w.plan)}\`; repairs: \`${rel(w.repairs)}\``,
    '',
  ].join('\n');
  const file = writeText(path.join(w.reports, 'final-report.md'), md);
  writeJson(path.join(w.reports, 'final-report.json'), { schema: 'f2d-report/2', slug, finalBuild: buildId, verdict: verdict.verdict, accepted: passed, problems, functional: { pass: check?.pass, failed: check?.failed }, sections: state.sections.map((s) => ({ index: s.index, name: s.name, status: s.status, similarity: s.similarity_by_width?.[state.design_width], responsive: s.responsive?.status, open: s.responsive?.open })) });
  return { ok: true, file, verdict: verdict.verdict, accepted: passed };
}
