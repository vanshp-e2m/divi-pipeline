// Planner (deterministic core). Produces build-plan.json before any compilation is kept.
// The element map comes from a dry-run of the real compilers, so the plan cannot claim a mapping
// the compiler does not implement. AI review/amendments are layered on with `amendPlan`.
import fs from 'node:fs';
import path from 'node:path';
import { writeJson, readJsonIf, sha, F2DError } from '../util/core.mjs';
import { capabilities } from '../compile/divi/capabilities.mjs';

export const PLAN_SCHEMA = 'f2d-plan/1';

export function viewportMatrix(cfg, ir, { breakpoints = [] } = {}) {
  const design = ir.frames.map((f) => ({ width: f.width, kind: 'design', frame: f.id, viewport: f.viewport, match: 'page', compare: true }));
  const extra = (cfg.viewports.extra || []).filter((w) => !design.some((d) => d.width === w)).map((w) => ({ width: w, kind: w > 1920 ? 'wide' : w > 980 ? 'desktop-extra' : w > 767 ? 'tablet-extra' : 'phone-extra', match: 'window', compare: false }));
  // Both sides of every breakpoint the build emits (window width = media-query width).
  for (const b of breakpoints) for (const w of [b, b + 1]) if (w >= 320 && ![...design, ...extra].some((c) => c.width === w)) extra.push({ width: w, kind: 'breakpoint', match: 'window', compare: false });
  // Intermediate widths between supplied designs are part of `extra` (3840…320 by default), plus rotated views.
  const modes = cfg.target.os === 'both' ? ['classic', 'overlay'] : [cfg.target.os === 'windows' ? 'classic' : 'overlay'];
  const landscape = (cfg.viewports.landscape || []).map(([width, height]) => ({ width, height, kind: 'landscape', match: 'window', compare: false }));
  return { scrollbarModes: modes, cells: [...design, ...extra, ...landscape].sort((a, b) => b.width - a.width || (a.height || 0) - (b.height || 0)), height: cfg.viewports.viewportHeight };
}

function risks(ir, manifest, fonts, diviMap) {
  const out = [];
  const add = (kind, severity, nodeIds, description, mitigation) => out.push({ id: 'K' + sha([kind, nodeIds], 6), kind, severity, nodeIds, description, mitigation, status: 'open' });
  for (const f of fonts.report) {
    if (f.status === 'MISSING') add('font-missing', 'critical', [], `Font "${f.family}" (${f.runs} runs) is not available and has no substitute.`, 'Provide font files (fonts.substitutions.<family>.files) or a measured substitute (f2d fonts probe).');
    if (f.status === 'substituted') add('font-substituted', 'major', [], `Font "${f.family}" is substituted by "${f.substitute}" — glyph widths and wrapping differ from the design.`, 'Replace with the real font files when available; QA reports typography deltas as caused by substitution.');
  }
  for (const i of ir.issues.filter((x) => x.code === 'VIDEO_FILL_STILL')) add('video-fill', 'minor', [i.nodeId], 'Video background rendered as its Figma poster frame (no video asset in the export).', 'Supply the video file to use Divi background_video_mp4.');
  for (const i of ir.issues.filter((x) => x.code === 'VIDEO_FILL')) add('video-fill', 'major', [i.nodeId], 'Video background without poster frame.', 'Fetch the Figma image fill (Figma REST) or provide a still.');
  const N = ir.nodes;
  const bgText = Object.values(N).filter((n) => n.a.role === 'section' && n.fills.some((f) => ['image', 'video'].includes(f.type)));
  for (const s of bgText) add('bg-image-text', 'major', [s.id], `Section "${s.name}" places text over a background image/video; crop and focal point must hold across widths.`, 'Background size/position from the Figma image transform; QA compares the section crop at every design width.');
  const absContent = Object.values(N).filter((n) => n.a.role === 'container' && !n.layout && !n.a.inferredLayout && n.children.length >= 2 && !n.a.decor && !n.a.widget);
  if (absContent.length) add('absolute-layout', 'major', absContent.map((n) => n.id), `${absContent.length} containers have no auto-layout and overlapping children — rendered with exact positions at desktop and a stacked flow on phones.`, 'Responsive QA checks overlap/overflow at every width; repair converts specific ones to flow when they fail.');
  const bleeds = Object.values(N).filter((n) => n.a.bleeds && n.a.decor);
  if (bleeds.length) add('bleeding-decoration', 'minor', bleeds.slice(0, 20).map((n) => n.id), `${bleeds.length} decorative elements extend outside their parent (watermark text, rings, vectors).`, 'Page root clips horizontally (overflow-x: clip); decoration rows are pointer-events:none.');
  for (const n of Object.values(N).filter((x) => x.a.widget)) {
    const w = n.a.widget;
    if (w === 'counter-digit') continue;
    // Components the bridge runtime drives are interactive (and operated by QA); the rest render static.
    const runtime = { accordion: 'items with content toggle open/closed (closed look taken from the closed items of the design)', slider: 'one card at a time with working prev/next below the tablet breakpoint; all cards shown above it', marquee: 'continuous ticker, paused on hover/focus, static for reduced motion' };
    if (runtime[w]) add(`widget-${w}`, 'info', [n.id], `"${n.name}" is a ${w}: interactive via the f2d runtime — ${runtime[w]}.`, 'QA operates it at the design width, 768 and 390 (interaction.component); without JavaScript it shows the resting state of the design.');
    else add(`widget-${w}`, w === 'form' ? 'major' : 'minor', [n.id], `"${n.name}" looks like a ${w}; Divi 4 rendering is static unless a native module is mapped.`, w === 'form' ? 'Static form markup; wire et_pb_contact_form or a form plugin before launch (report as unverified interaction).' : 'Static strip clipped like the design; motion is not in the export.');
  }
  for (const n of Object.values(N).filter((x) => x.a.menuPanel)) add('nav-menu', 'info', [n.id], `"${n.name}" collapses behind a menu button below a header breakpoint computed from the header's content.`, 'QA opens and closes it at 768 and 390 (critical if it fails).');
  const counters = Object.values(N).filter((x) => x.a.widget === 'counter-digit');
  if (counters.length) add('widget-counter', 'minor', counters.map((n) => n.id), `${counters.length} rolling-digit counters (clipped digit strips) — rendered statically at the design's resting digit.`, 'Animation is not in the export; reported as unverified interaction.');
  if (manifest.missingViewports.length) add('missing-viewports', 'major', [], `No Figma frames for: ${manifest.missingViewports.join(', ')} — responsive behaviour is inferred.`, 'Inferred rules (stacking, type scale, gutters) are documented under responsive.assumptions and tested at every extra width.');
  const frags = diviMap.filter((m) => m.strategy === 'fragment');
  if (frags.length) add('divi-fragments', 'minor', frags.map((m) => m.nodeId), `${frags.length} nested structures become HTML fragments inside Text modules (Divi 4 has no containers below columns).`, 'Fragments stay editable as HTML; listed in the build manifest with reasons.');
  return out;
}

function interactions(ir) {
  const N = ir.nodes;
  const out = [];
  for (const n of Object.values(N)) {
    if (n.states?.hover) out.push({ nodeId: n.id, name: n.name, kind: 'hover-state', expected: 'style change per IR states.hover', durationMs: n.interactions.find((i) => i.trigger === 'hover')?.durationMs ?? null, verifiable: true });
    for (const it of n.interactions.filter((i) => i.trigger === 'click')) out.push({ nodeId: n.id, name: n.name, kind: 'click', expected: it.url ? `navigates to ${it.url}` : `state change (${it.action})`, verifiable: !!it.url });
    if (n.a.role === 'button') out.push({ nodeId: n.id, name: n.name, kind: 'link', expected: 'focusable, visible focus, not covered', verifiable: true });
  }
  return out;
}

export function buildPlan({ cfg, slug, ir, tokens, assets, manifest, fonts, diviDry, diviVersion }) {
  const N = ir.nodes;
  const sections = Object.values(N).filter((n) => n.a.role === 'section').sort((a, b) => a.a.sectionIndex - b.a.sectionIndex);
  const diviMap = diviDry.manifest.modules.map((m) => ({ nodeId: m.id, name: N[m.id]?.name, strategy: m.fragment ? 'fragment' : 'native', module: m.module, note: m.note || null }));
  const fbById = new Map(diviDry.manifest.fallbacks.map((f) => [f.id, f]));
  for (const m of diviMap) if (fbById.has(m.nodeId)) m.reason = fbById.get(m.nodeId).reason;
  const inSection = (sec, id) => {
    for (let p = id; p; p = N[p]?.parent) if (p === sec.id) return true;
    return false;
  };
  const plan = {
    schema: PLAN_SCHEMA,
    version: 1,
    slug,
    createdAt: new Date().toISOString(),
    target: { os: cfg.target.os, site: cfg.site.url, divi: diviVersion, adapter: 'divi-v4', publish: cfg.publish.status },
    input: {
      adapter: manifest.adapter,
      inputHash: manifest.inputHash,
      frames: manifest.frames,
      validation: {
        ok: !manifest.assets.missing.length && !fonts.report.some((f) => f.status === 'MISSING'),
        missingAssets: manifest.assets.missing,
        fonts: fonts.report,
        issues: manifest.issues.filter((i) => i.severity !== 'info'),
      },
    },
    sections: sections.map((s) => ({
      id: s.id,
      name: s.name,
      index: s.a.sectionIndex,
      box: s.box,
      layout: s.layout ? `${s.layout.dir} gap ${s.layout.gap}` : 'absolute',
      background: s.fills.map((f) => f.type),
      strategy: {
        divi: 'et_pb_section + one et_pb_row per flow child (columns for horizontal card rows) + decoration row for out-of-flow layers',
        modules: diviMap.filter((m) => inSection(s, m.nodeId)).reduce((acc, m) => ((acc[m.strategy === 'fragment' ? 'fragment' : m.module] = (acc[m.strategy === 'fragment' ? 'fragment' : m.module] || 0) + 1), acc), {}),
      },
      widgets: Object.values(N).filter((n) => n.a.widget && inSection(s, n.id)).map((n) => n.a.widget),
    })),
    elementMap: diviMap,
    assets: { total: Object.keys(assets).length, images: Object.values(assets).filter((a) => a.kind === 'image').length, svg: Object.values(assets).filter((a) => a.kind === 'svg').length, missing: manifest.assets.missing },
    tokens: { colors: tokens.colors.filter((c) => c.id).map((c) => ({ id: c.id, value: c.value, uses: c.uses })), typeStyles: tokens.type.filter((t) => t.id).length, spacing: tokens.spacing.filter((s) => s.id).map((s) => s.value), radii: tokens.radii.filter((r) => r.id).map((r) => r.value), diviGlobalColors: 'gcid-f2d-<hash> for promoted colours (namespaced, merged)' },
    fonts: fonts.report,
    responsive: {
      frames: ir.frames.map((f) => ({ id: f.id, viewport: f.viewport, width: f.width })),
      breakpoints: { tablet: cfg.divi.breakpoints.tablet, phone: cfg.divi.breakpoints.phone },
      inferred: manifest.missingViewports.length > 0,
      // General rules; the per-section result of applying them is in responsive.sections.
      assumptions: [
        'Breakpoints are the responsive ladder (DEV Connect rules with Divi 4 edges): widescreen above the design width (4K containment), desktop base, laptop ≤1366 (or the content column + gutters when wider), tablet-extra ≤1200, tablet ≤980 (Divi), mobile-extra ≤880, phone ≤767 (Divi). A break is fixed on the tier covering it, never a narrower one; everything is checked from 3840 down to 320 and in landscape.',
        'Full-width containers keep the design content width centred with fluid gutters (≥24px desktop, 32px tablet, 20px phone); large inner paddings shrink below desktop. Above 1920 every section keeps its background full-bleed and its content in the column it has at 1920 (no stretching, no taller sections). No vw units (Windows scrollbars).',
        'Rows: content blocks shrink proportionally to half their design width (or their content minimum), then wrap. 3–4 column grids go two-up by tablet-extra (equal card heights, an odd last card spans the line). Rows of ≥2 content blocks stack from mobile-extra (≤880) in reading order, text before the picture; one block + small controls stays a row if the block keeps a readable width; rows of small items wrap.',
        'Typography: explicit stepped sizes per tier (no clamp/vw), each capped so the longest word fits the tier\'s narrowest width — no mid-word breaks; headings balance their lines (no orphan words). Line height and tracking scale in em. Centred headings stay centred when they wrap.',
        'Header: always sticky (desktop to 320 and in landscape); below the menu breakpoint it is a slim bar (logo + menu button) and its other bars move into the drawer, which scrolls inside the screen when taller. Every button has hover/focus (derived from its colour when the design has none); tap targets are at least 44×44 on phones.',
        'Layout-less compositions with text become a vertical flow in reading order (visual lines, then left to right) where they cannot fit (tablet if wider than 900px, phone if wider than 500px); invisible hover-reveal layers stay out of the flow; small fixed items keep their size.',
        'Decoration: full-width layers stretch and keep their aspect ratio; bottom-edge layers stay pinned to the bottom; large bleeds outside their section are dropped below desktop; badges straddling an edge move inside and the content makes room.',
        'Carousels stay single clipped rows: text slides fill the slider, image slides keep their aspect ratio at ~85% width. Timeline connectors turn vertical when steps stack and are hidden when steps wrap two-up.',
        'Buttons never wrap apart; fixed heights become content-based below desktop; nothing in flow may exceed its parent.',
      ],
    },
    interactions: interactions(ir),
    risks: risks(ir, manifest, fonts, diviMap),
    qa: { matrix: viewportMatrix(cfg, ir), suite: ['structure', 'geometry', 'visual', 'responsive', 'edge', 'interaction'], everyPass: true },
    acceptance: {
      thresholds: cfg.qa.thresholds,
      weights: cfg.qa.weights,
      critical: ['missing major section', 'broken/missing critical asset', 'severe text/image overlap', 'horizontal overflow at any tested width', 'layout collapse', 'broken primary nav/CTA', 'page fails to render', 'unintended destructive change'],
      // The verdict is the f2d-qa agent's judgement on evidence it looked at (the DEV Connect model);
      // functional checks are objective and block. Pixel similarity is recorded as evidence, never a gate.
      verdict: 'f2d-qa agent: every section judged at the design width (Figma crop, diff, side-by-side, measurements) and at every width + rotation (contact sheets), fixed, recaptured and locked; PASS also needs every functional check on the final build',
      evidence: 'similarity_pct per section (per-channel difference > 24 = mismatch, compare_screenshots.py semantics) with best vertical alignment; measured deltas vs the IR',
    },
    budget: { passes: cfg.qa.passes, maxPasses: cfg.qa.maxPasses },
    tasks: [],
    limitations: [],
    questions: [],
    history: [{ at: new Date().toISOString(), by: 'planner:deterministic', change: 'initial plan' }],
  };
  plan.tasks = tasksFor(plan);
  plan.limitations = [
    ...plan.risks.filter((r) => r.kind.startsWith('widget-')).map((r) => r.description),
    ...(manifest.missingViewports.length ? [`Tablet/phone fidelity cannot be scored against a design (no frames): responsive results are robustness checks only.`] : []),
  ];
  plan.questions = plan.input.validation.fonts.filter((f) => f.status === 'substituted' || f.status === 'MISSING').map((f) => `Can you provide the "${f.family}" font files (woff2/ttf) and confirm the web licence?`);
  plan.validation = validatePlan(plan);
  return plan;
}

function tasksFor(plan) {
  const t = (id, title, deps, outputs, validation) => ({ id, title, deps, outputs, validation, status: 'pending' });
  return [
    t('T01', 'Validate inputs (IR schema, assets, fonts, frames)', [], ['input-manifest.json'], 'no missing assets; every font resolved or recorded as a risk'),
    t('T02', 'Plan + validate against Divi capabilities', ['T01'], ['build-plan.json'], 'validatePlan() returns no errors'),
    t('T03', 'Compile HTML preview + Divi layout from IR + repairs', ['T02'], ['builds/<id>/preview', 'builds/<id>/divi/layout.txt', 'builds/<id>/divi/page.css', 'builds/<id>/manifest.json'], 'compile validation passes; every IR section has a Divi section'),
    t('T04', 'Upload assets (deduplicated) + deploy draft page', ['T03'], ['media.json', 'builds/<id>/deploy.json'], 'readback content hash equals built content hash; page is draft'),
    t('T05', 'Functional check (render, assets, links, forms, components, sticky header, drawer, overflow at every width)', ['T04'], ['qa/agent/<id>/check.json'], 'every check recorded; failures become defects for the QA agent'),
    t('T06', 'Agent QA: section by section — capture vs Figma, diagnose, repair, recapture, verify, lock', ['T05'], ['qa/agent/section-qa-state.json', 'repairs.json'], 'every section locked (or capped with its cause) on evidence the agent looked at'),
    t('T07', 'Agent QA: responsive pass per section (3840 → 320 + rotated views) and whole-page pass', ['T06'], ['qa/agent/<id>/sweep/'], 'every section responsive or incomplete with open issues by width'),
    t('T08', "Verdict (functional check on the final build + the agent's judgement) + report", ['T07'], ['qa/agent/verdict.json', 'reports/final-report.md'], 'PASS only with every section locked, responsive, and every functional check holding'),
  ];
}

export function validatePlan(plan) {
  const caps = capabilities(plan.target.divi);
  const errors = [], warnings = [];
  if (!caps) errors.push(`Divi ${plan.target.divi} has no verified capability profile`);
  for (const m of plan.elementMap) if (caps && !caps.modules.includes(m.module)) errors.push(`element ${m.nodeId} mapped to unverified module ${m.module}`);
  const ids = new Set(plan.tasks.map((t) => t.id));
  for (const t of plan.tasks) for (const d of t.deps) if (!ids.has(d)) errors.push(`task ${t.id} depends on unknown ${d}`);
  if (!plan.sections.length) errors.push('no sections found');
  if (plan.risks.some((r) => r.severity === 'critical')) warnings.push('critical input risks present (see risks) — build continues with them recorded');
  return { ok: !errors.length, errors, warnings, checkedAgainst: caps ? caps.id : null };
}

// Amendments from the planner agent or the orchestrator, preserved in plan history.
export function amendPlan(planPath, amendment, by) {
  const plan = readJsonIf(planPath);
  if (!plan) throw new F2DError('E_NO_PLAN', 'No plan to amend');
  const histDir = path.join(path.dirname(planPath), 'plan-history');
  fs.mkdirSync(histDir, { recursive: true });
  writeJson(path.join(histDir, `v${plan.version}.json`), plan);
  const changes = [];
  // Retire superseded assumptions/limitations (by prefix), before this amendment's own additions — e.g. a "static" plan after the user chose
  // working components. Recorded and replayed like every other amendment.
  for (const pre of amendment.retire || []) {
    const keep = (v) => !String(v).startsWith(pre);
    const before = plan.responsive.assumptions.length + (plan.limitations || []).length;
    plan.responsive.assumptions = plan.responsive.assumptions.filter(keep);
    if (plan.limitations) plan.limitations = plan.limitations.filter(keep);
    changes.push(`retired ${before - plan.responsive.assumptions.length - (plan.limitations || []).length} × "${pre.slice(0, 30)}…"`);
  }
  for (const key of ['risks', 'limitations', 'questions', 'assumptions', 'notes']) {
    if (!amendment[key]) continue;
    if (key === 'assumptions') plan.responsive.assumptions.push(...amendment[key]);
    else (plan[key] ??= []).push(...amendment[key]);
    changes.push(`+${amendment[key].length} ${key}`);
  }
  for (const [id, upd] of Object.entries(amendment.riskStatus || {})) {
    const r = plan.risks.find((x) => x.id === id);
    if (r) Object.assign(r, upd), changes.push(`risk ${id} -> ${upd.status}`);
  }
  for (const [id, st] of Object.entries(amendment.taskStatus || {})) {
    const t = plan.tasks.find((x) => x.id === id);
    if (t) (t.status = st), changes.push(`task ${id} -> ${st}`);
  }
  if (amendment.remainingTasks) (plan.remaining = amendment.remainingTasks), changes.push('remaining tasks updated');
  // Judgement from the planner/repairer agents is kept verbatim and replayed on every re-plan
  // (the deterministic planner regenerates assumptions, limitations and risk severities).
  if (!/^orchestrator(?!:review)/.test(by || '')) (plan.agentAmendments ??= []).push({ by, at: new Date().toISOString(), amendment });
  plan.version++;
  plan.history.push({ at: new Date().toISOString(), by, change: changes.join(', ') || 'no-op', rationale: amendment.rationale || null });
  plan.validation = validatePlan(plan);
  writeJson(planPath, plan);
  return { version: plan.version, changes };
}
