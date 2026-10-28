// Stage "plan": run the Planner over the analysed input. Uses a dry compile (no files written) so the
// element map reflects what the compiler really emits.
import { writeJson, readJsonIf, F2DError } from '../util/core.mjs';
import { buildBoxTree } from '../layout/engine.mjs';
import { compileDivi } from '../compile/divi/v4.mjs';
import { buildPlan, validatePlan } from '../planner/plan.mjs';
import { responsivePlan } from '../planner/responsive.mjs';
import { loadRepairs, applyIrRepairs, fontRepairs } from '../repair/repairs.mjs';
import { loadAnalysis, resolveFonts } from './analyze.mjs';
import * as WP from '../wp/client.mjs';

export async function runPlan(cfg, slug, { offline = false } = {}) {
  const { ir: baseIr, tokens, assets, manifest, w } = loadAnalysis(cfg, slug);
  const repairs = loadRepairs(w.repairs);
  const ir = applyIrRepairs(structuredClone(baseIr), repairs);
  const fonts = resolveFonts(cfg, ir, fontRepairs(repairs));
  let diviVersion = cfg.divi.version;
  if (!offline && (diviVersion === 'auto' || !diviVersion)) {
    const st = await WP.status(cfg);
    if (!st.divi_active) throw new F2DError('E_NO_DIVI', 'Divi is not active on the target site');
    diviVersion = st.divi;
  }
  const ctx = { fonts: { substitutions: fonts.substitutions }, assetMeta: (k) => assets[k], assetUrl: (k) => (assets[k]?.exists ? `f2d-asset://${k}` : null), videoStill: (n) => (n.videoStill ? { url: 'f2d-asset://still', ...n.videoStill.background } : null) };
  const tree = buildBoxTree(ir, ir.frames[0].id, ctx);
  const diviDry = compileDivi(tree, ir, { tokens, fonts });
  const prev = readJsonIf(w.plan);
  const plan = buildPlan({ cfg, slug, ir, tokens, assets, manifest, fonts, diviDry, diviVersion });
  // Per-section desktop / tablet / phone strategy, read back from the compiler's own decisions.
  plan.responsive.sections = responsivePlan(tree, ir, { breakpoints: cfg.divi.breakpoints }).sections;
  if (prev) {
    // Re-planning keeps the history and any agent amendments that still apply.
    plan.version = prev.version + 1;
    plan.history = [...prev.history, { at: plan.createdAt, by: 'planner:deterministic', change: 're-plan' }];
    for (const r of prev.risks) if (!plan.risks.some((x) => x.id === r.id) && r.by) plan.risks.push(r);
    plan.notes = prev.notes;
    for (const t of plan.tasks) t.status = prev.tasks.find((x) => x.id === t.id)?.status || t.status;
    // Replay agent amendments (risks they added are already carried over above).
    plan.agentAmendments = prev.agentAmendments || [];
    for (const { amendment: a } of plan.agentAmendments) {
      for (const pre of a.retire || []) {
        plan.responsive.assumptions = plan.responsive.assumptions.filter((v) => !String(v).startsWith(pre));
        if (plan.limitations) plan.limitations = plan.limitations.filter((v) => !String(v).startsWith(pre));
      }
      for (const key of ['limitations', 'questions']) for (const v of a[key] || []) if (!(plan[key] ??= []).includes(v)) plan[key].push(v);
      for (const v of a.assumptions || []) if (!plan.responsive.assumptions.includes(v)) plan.responsive.assumptions.push(v);
      for (const [id, upd] of Object.entries(a.riskStatus || {})) Object.assign(plan.risks.find((r) => r.id === id) || {}, upd);
    }
  }
  plan.validation = validatePlan(plan);
  writeJson(w.plan, plan);
  return plan;
}
