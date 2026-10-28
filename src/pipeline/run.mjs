// End-to-end orchestrator (resumable, state in pages/<slug>/state.json → run). QA is judged by the
// f2d-qa agent, the DEV Connect way — the pipeline builds, deploys and records the objective
// functional checks, then hands over:
//   analyze → plan (validated) → build → deploy → functional check   (status "awaiting-agent-qa")
//   … the f2d-qa agent works section by section: capture vs Figma, diagnose, repair, rebuild +
//     redeploy, recapture, verify, lock; then every width + rotation; writes qa/agent/verdict.json …
//   "f2d run --resume": functional check on the final deployed build + the agent's verdict → report
import path from 'node:path';
import { writeJson, readJsonIf, log, F2DError } from '../util/core.mjs';
import { ws, loadState } from '../workspace.mjs';
import { runAnalyze } from './analyze.mjs';
import { runPlan } from './plan.mjs';
import { compileAll } from './build.mjs';
import { runDeploy } from './deploy.mjs';
import { amendPlan } from '../planner/plan.mjs';
import { functionalCheck, initState, validateState } from '../qa/tools.mjs';
import { writeAgentReport } from '../report/report.mjs';

const save = (w, st) => writeJson(w.state, st);

async function buildAndDeploy(cfg, slug) {
  const b = compileAll(cfg, slug);
  if (!b.manifest.validation.ok) throw new F2DError('E_BUILD_INVALID', `Build ${b.id} failed validation: ${b.manifest.validation.errors.join('; ')}`);
  const d = await runDeploy(cfg, slug, b.id);
  return { buildId: b.id, deploy: { postId: d.postId, ok: d.ok, uploaded: d.uploaded } };
}

const NEXT = 'Launch the f2d-qa agent (slug + project directory). It works section by section with "f2d shot / measure / sweep / check", repairs with "f2d repair --apply", rebuilds and redeploys, locks each section in qa/agent/section-qa-state.json and writes qa/agent/verdict.json. Then run "f2d run --resume".';

export async function runAll(cfg, slug, { skipAnalyze = false, resume = false } = {}) {
  const w = ws(cfg, slug);
  let st = loadState(w);

  if (!resume || !st.run || st.run.status === 'done') {
    st.run = { startedAt: new Date().toISOString(), stage: 'start', status: 'running', history: [] };
    save(w, st);
    if (!skipAnalyze) await runAnalyze(cfg, slug);
    const plan = await runPlan(cfg, slug);
    if (!plan.validation.ok) throw new F2DError('E_PLAN_INVALID', `Plan failed validation: ${plan.validation.errors.join('; ')}`);
    amendPlan(w.plan, { taskStatus: { T01: 'done', T02: 'done' } }, 'orchestrator');
    const bd = await buildAndDeploy(cfg, slug);
    amendPlan(w.plan, { taskStatus: { T03: 'done', T04: 'done' } }, 'orchestrator');
    const chk = await functionalCheck(cfg, slug);
    initState(cfg, slug, { force: true });
    amendPlan(w.plan, { taskStatus: { T05: 'done' }, remainingTasks: chk.failed, rationale: `functional check: ${chk.pass ? 'all hold' : chk.blocking + ' failing'}` }, 'orchestrator');
    st = loadState(w);
    Object.assign(st.run, { buildId: bd.buildId, stage: 'agent-qa', status: 'awaiting-agent-qa' });
    st.run.history.push({ at: new Date().toISOString(), event: 'built + deployed + checked', buildId: bd.buildId, functional: { pass: chk.pass, failed: chk.failed } });
    save(w, st);
    return { ok: true, status: st.run.status, buildId: bd.buildId, functional: { pass: chk.pass, failed: chk.failed, file: chk.file }, state: 'qa/agent/section-qa-state.json', next: NEXT };
  }

  // ---- resume: the agent has finished (or stopped); judge the final deployed build
  const verdictFile = path.join(w.root, 'qa', 'agent', 'verdict.json');
  const verdict = readJsonIf(verdictFile);
  if (!verdict) throw new F2DError('E_NO_VERDICT', `No qa/agent/verdict.json yet. ${NEXT}`);
  const deployed = st.deployed?.at(-1)?.buildId;
  const chk = await functionalCheck(cfg, slug);
  const stateCheck = validateState(cfg, slug);
  const problems = [];
  if (verdict.buildId !== deployed) problems.push(`the verdict is for build ${verdict.buildId}, the deployed build is ${deployed}`);
  if (!chk.pass) problems.push(`${chk.blocking} functional check(s) fail on the final build`);
  if (!stateCheck.ok) problems.push(`section state: ${stateCheck.errors.slice(0, 3).join('; ')}`);
  const passed = verdict.verdict === 'PASS' && !problems.length;
  amendPlan(w.plan, { taskStatus: { T06: 'done', T07: 'done', T08: 'done' }, remainingTasks: problems, rationale: `agent verdict ${verdict.verdict}${problems.length ? '; ' + problems.join('; ') : ''}` }, 'orchestrator');
  const rep = writeAgentReport(cfg, slug, { verdict, check: chk, stateCheck, problems });
  st = loadState(w);
  st.run = { ...(st.run || {}), stage: 'done', status: passed ? 'passed' : verdict.verdict === 'BLOCKED' ? 'blocked' : 'failed', finishedAt: new Date().toISOString(), buildId: deployed };
  st.run.history = [...(st.run.history || []), { at: new Date().toISOString(), event: 'verdict', buildId: deployed, verdict: verdict.verdict, functional: chk.pass, problems }];
  save(w, st);
  log.info(`run finished: ${st.run.status}`);
  return { ok: true, status: st.run.status, finalBuild: deployed, verdict: verdict.verdict, reason: verdict.reason, problems, functional: { pass: chk.pass, failed: chk.failed }, report: rep.file };
}
