#!/usr/bin/env node
// f2d — Figma -> Divi compiler + QA/repair pipeline CLI. Every command prints a JSON result on
// stdout (logs go to stderr) so agents and scripts can consume it.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, findProjectDir, DEFAULTS } from '../src/config.mjs';
import { writeJson, readJsonIf, setLogLevel, F2DError, redact } from '../src/util/core.mjs';

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
    else flags[k] = true;
  } else pos.push(a);
}
if (flags.verbose) setLogLevel('debug');
if (flags.quiet) setLogLevel('warn');

const out = (data) => process.stdout.write(JSON.stringify(data, null, 2) + '\n');
const projectDir = () => {
  const d = flags.project ? path.resolve(flags.project) : findProjectDir();
  if (!d) throw new F2DError('E_NO_PROJECT', 'No f2d.config.json found (use --project or run "f2d init").');
  return d;
};
const cfg = () => loadConfig(projectDir());
const page = (c) => {
  const slug = pos[1] || Object.keys(c.pages)[0];
  if (!slug) throw new F2DError('E_NO_PAGE', 'No page given and none configured');
  return slug;
};
const latestBuild = async (c, slug) => {
  const { ws, listBuilds } = await import('../src/workspace.mjs');
  const b = listBuilds(ws(c, slug));
  if (!b.length) throw new F2DError('E_NO_BUILD', 'No builds yet. Run "f2d build".');
  return b.at(-1);
};

const HELP = `f2d <command> [page] [flags]

  init --os windows|macos|both [--site URL] [--page SLUG --input PATH]   create/update f2d.config.json
  config set <key.path> <value>                                          edit config (JSON values allowed)
  doctor                                                                 check toolchain, site, Divi, bridge
  analyze [page]                                                         ingest + normalise + analyse input
  fonts probe [page] [--family F]                                        measure substitute fonts against the reference
  fonts list [page] | fonts add [page] --dir D [--family F]              the design's fonts; register your font files (served with @font-face)
  fonts web [page] [--family F] [--use G --reason R]                     serve a family from Google Fonts (the real one, or a stand-in G)
  figma link <url>                                                       remember the Figma design link (file key, node)
  plan [page] | plan validate [page] | plan amend [page] --file F --by WHO
  build [page] [--dry-run]                                               compile HTML preview + Divi layout
  deploy [page] [--build ID]                                             upload assets, write draft, verify readback
  qa [page] [--build ID] [--quick] [--section N]                         legacy scripted metrics (diagnostic only — the verdict is the f2d-qa agent's)
  shot [page] --section N|page [--width W] [--height H] [--open-menu]   section capture; at the design width + Figma crop, diff, side-by-side, similarity
  measure [page] --section N [--width W] [--nodes a,b]                   built boxes + computed styles vs the IR's numbers (deltas at the design width)
  sweep [page] --section N [--widths 1440,844x390]                       the section at every width + rotation: contact sheets + measured hints
  check [page]                                                           objective functional checks (render, assets, links, forms, components, sticky, drawer, overflow)
  qa-state [page] init|validate                                          the f2d-qa agent's section-qa-state.json
  fix-context [page]                                                     defects grouped by root cause for repair
  repair [page] --auto | --apply FILE | --revert ID --reason R           apply/revert IR-level repairs
  run [page]                                                             analyze→plan→build→deploy→functional check, then hands over to the f2d-qa agent
  run [page] --resume                                                    after the agent's verdict: functional check on the final build → report
  report [page]                                                          final report (markdown + JSON)
  ledger [page]                                                          issue ledger summary
  rollback [page] [--build ID]                                           restore a previous build
  calibrate [--image PNG]                                                validate the visual metric with controlled perturbations
`;

async function main() {
  const cmd = pos[0];
  if (!cmd || cmd === 'help' || flags.help) return process.stdout.write(HELP);

  if (cmd === 'init') {
    const dir = flags.project ? path.resolve(flags.project) : process.cwd();
    const p = path.join(dir, 'f2d.config.json');
    const c = readJsonIf(p, { schema: DEFAULTS.schema, target: { os: null }, site: {}, pages: {} });
    if (!flags.os && !c.target?.os) throw new F2DError('E_TARGET_OS', 'Ask the user which OS the site targets, then pass --os windows|macos|both (Windows scrollbars take layout width; macOS overlay scrollbars do not).');
    if (flags.os) {
      if (!['windows', 'macos', 'both'].includes(flags.os)) throw new F2DError('E_TARGET_OS', '--os must be windows, macos or both');
      c.target = { ...(c.target || {}), os: flags.os };
    }
    if (flags.site) c.site = { ...(c.site || {}), url: flags.site };
    if (flags.page) c.pages = { ...(c.pages || {}), [flags.page]: { ...(c.pages?.[flags.page] || {}), input: flags.input } };
    writeJson(p, c);
    return out({ ok: true, config: p, target: c.target, pages: Object.keys(c.pages || {}) });
  }

  if (cmd === 'config' && pos[1] === 'set') {
    const p = path.join(projectDir(), 'f2d.config.json');
    const c = readJsonIf(p, {});
    let v = pos[3];
    try { v = JSON.parse(v); } catch {}
    const parts = pos[2].split('.');
    let o = c;
    for (const k of parts.slice(0, -1)) o = o[k] ??= {};
    o[parts.at(-1)] = v;
    writeJson(p, c);
    return out({ ok: true, set: pos[2], value: v });
  }

  const c = cfg();

  if (cmd === 'doctor') return out(await (await import('../src/pipeline/doctor.mjs')).doctor(c));

  if (cmd === 'analyze') {
    const { runAnalyze } = await import('../src/pipeline/analyze.mjs');
    const r = await runAnalyze(c, page(c), { refetch: !!flags.refetch });
    return out({ ok: true, slug: r.manifest.slug, nodes: r.manifest.nodes, frames: r.manifest.frames.map((f) => `${f.name} ${f.width}x${f.height}`), missingViewports: r.manifest.missingViewports, assets: r.manifest.assets, fonts: r.fonts.report, issues: r.manifest.issues.filter((i) => i.severity !== 'info'), analysis: { roles: r.manifest.analysis.roles, sections: r.manifest.analysis.sections.length, widgets: r.manifest.analysis.widgets } });
  }

  // ---- fonts: list the design's fonts, register the user's font files, or a Google Fonts web font
  if (cmd === 'fonts' && ['list', 'add', 'web'].includes(pos[1])) {
    const sub = pos.splice(1, 1)[0];
    const { loadAnalysis, resolveFonts } = await import('../src/pipeline/analyze.mjs');
    const slug = page(c);
    const { ir } = loadAnalysis(c, slug);
    const cfgFile = path.join(c.projectDir, 'f2d.config.json');
    const raw = readJsonIf(cfgFile, {});
    const setSub = (family, value) => { ((raw.fonts ??= {}).substitutions ??= {})[family] = value; writeJson(cfgFile, raw); };
    if (sub === 'list') return out({ ok: true, fonts: resolveFonts(c, ir).report.map((f) => ({ ...f, weights: ir.fonts.find((x) => x.family === f.family)?.weights })) });
    const families = flags.family ? [flags.family] : ir.fonts.map((f) => f.family);
    if (sub === 'add') {
      // Font files from a folder, matched to the design's families by file name; weight and style
      // from the name (Light, SemiBold, Italic …). One file per weight/style, woff2 preferred.
      const dir = flags.dir && path.resolve(String(flags.dir));
      if (!dir || !fs.existsSync(dir)) throw new F2DError('E_ARGS', 'fonts add needs --dir <folder with the font files>');
      const files = [];
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(woff2?|ttf|otf)$/i.test(e.name)) files.push(f); } };
      walk(dir);
      const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const W = [[/thin|hairline/, 100], [/extralight|ultralight/, 200], [/semibold|demibold/, 600], [/extrabold|ultrabold/, 800], [/black|heavy/, 900], [/light/, 300], [/medium/, 500], [/bold/, 700]];
      const weightOf = (n) => W.find(([re]) => re.test(norm(n)))?.[1] ?? 400;
      const rank = { '.woff2': 0, '.woff': 1, '.otf': 2, '.ttf': 3 };
      const added = {};
      for (const fam of families) {
        let mine = files.filter((f) => norm(path.basename(f)).includes(norm(fam)));
        if (!mine.length && families.length === 1) mine = files; // one family named: every file in the folder is it
        if (!mine.length) continue;
        const best = new Map();
        for (const f of mine.sort((a, b) => rank[path.extname(a).toLowerCase()] - rank[path.extname(b).toLowerCase()])) {
          const k = `${weightOf(path.basename(f))}-${/italic|oblique/i.test(path.basename(f)) ? 'italic' : 'normal'}`;
          if (!best.has(k)) best.set(k, f);
        }
        const list = [...best.entries()].map(([k, file]) => ({ file, weight: +k.split('-')[0], style: k.split('-')[1] }));
        setSub(fam, { files: list, reason: 'font files provided by the user' });
        added[fam] = list.map((x) => `${x.weight}${x.style === 'italic' ? 'i' : ''} ${path.basename(x.file)}`);
      }
      return out({ ok: Object.keys(added).length > 0, added, noFilesFor: families.filter((f) => !added[f]), scanned: files.length });
    }
    // web: serve a family from Google Fonts — the design's own family when Google has it (the real
    // font), or the stand-in given with --use (recorded as a substitution with its reason).
    const results = {};
    for (const fam of families) {
      const use = flags.use && flags.use !== true ? String(flags.use) : fam;
      const weights = ir.fonts.find((f) => f.family === fam)?.weights || [400];
      const q = use.replace(/ /g, '+');
      let css = `https://fonts.googleapis.com/css2?family=${q}:wght@${weights.join(';')}&display=block`;
      let res = await fetch(css).catch(() => null);
      if (!res?.ok) {
        css = `https://fonts.googleapis.com/css2?family=${q}&display=block`;
        res = await fetch(css).catch(() => null);
      }
      if (!res?.ok) { results[fam] = { ok: false, reason: `"${use}" is not on Google Fonts` }; continue; }
      const reason = use === fam ? `Design font served from Google Fonts (weights ${weights.join(', ')})` : String(flags.reason && flags.reason !== true ? flags.reason : `"${fam}" is not available; "${use}" is the closest available match`);
      setSub(fam, { substitute: use, css, reason });
      results[fam] = { ok: true, substitute: use, real: use === fam };
    }
    return out({ ok: Object.values(results).some((r) => r.ok), results });
  }

  // ---- figma link: remember the design's URL (file key + node) for the REST fallback and the report
  if (cmd === 'figma' && pos[1] === 'link') {
    const { parseFigmaUrl } = await import('../src/ingest/figma-rest.mjs');
    const url = pos[2];
    const p = url && parseFigmaUrl(url);
    if (!p) throw new F2DError('E_ARGS', 'f2d figma link <figma.com/design/... URL>');
    const cfgFile = path.join(c.projectDir, 'f2d.config.json');
    const raw = readJsonIf(cfgFile, {});
    raw.figma = { ...(raw.figma || {}), url, fileKey: p.fileKey, ...(p.nodeId ? { nodeId: p.nodeId } : {}) };
    writeJson(cfgFile, raw);
    return out({ ok: true, fileKey: p.fileKey, nodeId: p.nodeId });
  }

  if (cmd === 'fonts' && pos[1] === 'probe') {
    pos.splice(1, 1);
    const { loadAnalysis } = await import('../src/pipeline/analyze.mjs');
    const { probeFont, DEFAULT_CANDIDATES } = await import('../src/qa/fontprobe.mjs');
    const { launch } = await import('../src/qa/render.mjs');
    const slug = page(c);
    const { ir, w } = loadAnalysis(c, slug);
    const fams = flags.family ? [flags.family] : ir.fonts.filter((f) => f.missingInExport).map((f) => f.family);
    const b = await launch('classic');
    const results = [];
    for (const fam of fams) {
      const sans = /helvetica|arial|sans/i.test(fam);
      results.push(await probeFont(b, ir, { family: fam, candidates: flags.candidates ? flags.candidates.split(',') : sans ? DEFAULT_CANDIDATES.sans : DEFAULT_CANDIDATES.display, referencePng: ir.frames[0].screenshot.path, workDir: path.join(w.root, 'tmp', 'fontprobe', fam) }));
    }
    await b.close();
    writeJson(w.fontProbe, { at: new Date().toISOString(), results });
    return out({ ok: true, results: results.map((r) => ({ family: r.family, ranking: r.results.slice(0, 5) })) });
  }

  if (cmd === 'plan') {
    const sub = ['validate', 'amend', 'show'].includes(pos[1]) ? pos.splice(1, 1)[0] : null;
    const slug = page(c);
    const { ws } = await import('../src/workspace.mjs');
    const w = ws(c, slug);
    if (sub === 'validate') {
      const { validatePlan } = await import('../src/planner/plan.mjs');
      const plan = readJsonIf(w.plan);
      if (!plan) throw new F2DError('E_NO_PLAN', 'No plan yet');
      return out({ ok: true, validation: validatePlan(plan) });
    }
    if (sub === 'amend') {
      const { amendPlan } = await import('../src/planner/plan.mjs');
      return out({ ok: true, ...amendPlan(w.plan, JSON.parse(fs.readFileSync(flags.file, 'utf8')), flags.by || 'agent:planner') });
    }
    if (sub === 'show') return out(readJsonIf(w.plan));
    const { runPlan } = await import('../src/pipeline/plan.mjs');
    const plan = await runPlan(c, slug, { offline: !!flags.offline });
    return out({ ok: plan.validation.ok, version: plan.version, validation: plan.validation, sections: plan.sections.length, risks: plan.risks.map((r) => `${r.severity}: ${r.kind} — ${r.description.slice(0, 110)}`), questions: plan.questions, elementMap: plan.elementMap.reduce((a, m) => ((a[m.strategy === 'fragment' ? 'fragment' : m.module] = (a[m.strategy === 'fragment' ? 'fragment' : m.module] || 0) + 1), a), {}) });
  }

  if (cmd === 'build') {
    const { compileAll } = await import('../src/pipeline/build.mjs');
    const r = compileAll(c, page(c), { divi: true });
    return out({ ok: r.manifest.validation.ok, buildId: r.id, dir: r.dir, divi: r.manifest.divi && { sections: r.manifest.divi.sections, rows: r.manifest.divi.rows, counts: r.manifest.divi.counts, fallbacks: r.manifest.divi.fallbacks.length, unsupported: r.manifest.divi.unsupported.length }, validation: r.manifest.validation, dryRun: !!flags['dry-run'] });
  }

  if (cmd === 'deploy') {
    if (flags['dry-run']) return out({ ok: true, dryRun: true, note: 'deploy skipped (dry run)' });
    const { runDeploy } = await import('../src/pipeline/deploy.mjs');
    const slug = page(c);
    const id = flags.build || (await latestBuild(c, slug));
    const r = await runDeploy(c, slug, id);
    return out({ ok: r.ok, ...r, previewUrl: r.previewUrl ? '(see state.json)' : null });
  }

  if (cmd === 'qa') {
    const { runQa } = await import('../src/qa/suite.mjs');
    const slug = page(c);
    const id = flags.build || (await latestBuild(c, slug));
    const r = await runQa(c, slug, id, { pass: flags.pass ? Number(flags.pass) : null, quick: !!flags.quick, record: !flags.quick, allSections: !!flags['all-sections'], section: flags.section != null && flags.section !== true ? Number(flags.section) : null });
    return out(r.summary);
  }

  // ---- evidence instruments for the f2d-qa agent (they capture and measure; the agent judges)
  if (['shot', 'measure', 'sweep', 'check', 'qa-state'].includes(cmd)) {
    const T = await import('../src/qa/tools.mjs');
    const c = cfg();
    const slug = page(c);
    const num = (v) => (v === undefined || v === true ? undefined : Number(v));
    if (cmd === 'shot') return out(await T.shot(c, slug, { section: flags.section ?? 'page', width: num(flags.width), height: num(flags.height), openMenu: !!flags['open-menu'] }));
    if (cmd === 'measure') return out(await T.measure(c, slug, { section: flags.section, width: num(flags.width), nodes: flags.nodes === true ? null : flags.nodes }));
    if (cmd === 'sweep') return out(await T.sweep(c, slug, { section: flags.section, widths: flags.widths === true ? null : flags.widths }));
    if (cmd === 'check') return out(await T.functionalCheck(c, slug));
    const sub = pos[2] || 'validate';
    if (sub === 'init') return out(T.initState(c, slug, { force: !!flags.force }));
    return out(T.validateState(c, slug));
  }

  if (cmd === 'fix-context') {
    const { fixContext } = await import('../src/repair/context.mjs');
    return out(fixContext(c, page(c), { limit: Number(flags.limit || 40) }));
  }

  if (cmd === 'repair') {
    const R = await import('../src/repair/apply.mjs');
    const slug = page(c);
    if (flags.revert) return out(R.revert(c, slug, flags.revert, flags.reason || 'reverted'));
    if (flags.apply) return out(R.applyFile(c, slug, flags.apply));
    if (flags.auto) return out(await R.autoRepair(c, slug));
    throw new F2DError('E_ARGS', 'repair needs --auto, --apply FILE or --revert ID');
  }

  if (cmd === 'run') {
    const { runAll } = await import('../src/pipeline/run.mjs');
    return out(await runAll(c, page(c), { skipAnalyze: !!flags['skip-analyze'], resume: !!flags.resume }));
  }

  if (cmd === 'report') {
    // The agent-judged report when the f2d-qa agent has written its verdict; the legacy metrics report otherwise.
    const R = await import('../src/report/report.mjs');
    const { ws } = await import('../src/workspace.mjs');
    const slug = page(c);
    if (fs.existsSync(path.join(ws(c, slug).root, 'qa', 'agent', 'verdict.json'))) {
      const T = await import('../src/qa/tools.mjs');
      const check = await T.functionalCheck(c, slug);
      return out(R.writeAgentReport(c, slug, { check, stateCheck: T.validateState(c, slug) }));
    }
    return out(R.writeReport(c, slug));
  }

  if (cmd === 'ledger') {
    const { ledgerSummary } = await import('../src/qa/ledger.mjs');
    return out(ledgerSummary(c, page(c)));
  }

  if (cmd === 'rollback') {
    const { runRollback } = await import('../src/pipeline/deploy.mjs');
    return out(await runRollback(c, page(c), flags.build || null));
  }

  if (cmd === 'calibrate') {
    const { calibrate } = await import('../src/qa/calibrate.mjs');
    return out(await calibrate(c, { image: flags.image, out: flags.out }));
  }

  throw new F2DError('E_ARGS', `Unknown command "${cmd}". Run "f2d help".`);
}

main().catch((e) => {
  out({ ok: false, error: e.code || 'E_UNKNOWN', message: redact(e.message), details: e.details ? redact(JSON.stringify(e.details)).slice(0, 2000) : undefined });
  if (process.env.F2D_DEBUG) console.error(e.stack);
  process.exit(1);
});
