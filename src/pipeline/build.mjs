// Stage "build": IR + repairs + plan -> HTML preview + Divi layout + scoped CSS + manifest,
// all under one build id. Asset URLs in the Divi output are placeholders resolved at deploy, so a
// build is reproducible and can be compiled without a site (dry run).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson, writeText, readJsonIf, sha, timestampId, F2DError, ensureDir, log } from '../util/core.mjs';
import { buildBoxTree, lintCss } from '../layout/engine.mjs';
import { renderHtml, RUNTIME_FILE } from '../compile/html.mjs';
import { compileDivi } from '../compile/divi/v4.mjs';
import { tokenCss } from '../ir/tokens.mjs';
import { loadRepairs, applyIrRepairs, applyCssRepairs, fontRepairs } from '../repair/repairs.mjs';
import { resolveFonts, loadAnalysis } from './analyze.mjs';
import { ws, loadState } from '../workspace.mjs';
import { pageConfig } from '../config.mjs';

export const COMPILER_VERSION = '0.1.0';

// Build ids must change when the compiler changes: hash every source file that shapes the output.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPILER_HASH = (() => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.endsWith('.mjs') && !/[\\/](qa|report)[\\/]/.test(f)) files.push(f);
    }
  };
  walk(SRC);
  return sha(files.sort().map((f) => fs.readFileSync(f, 'utf8')).join(String.fromCharCode(0)), 12);
})();
export const assetPlaceholder = (key) => `f2d-asset://${encodeURIComponent(key)}`;

export const fontPlaceholder = (face) => `f2d-font://${face.sha}${face.ext}`;
const FONT_FORMAT = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' };
// The user's font files under the design's own family name (font-display: block, like the web fonts:
// a late font must not re-wrap rows after first paint).
export const fontFaceCss = (fonts, urlFor) => (fonts.faces || []).map((f) => `@font-face { font-family: '${f.family}'; src: url('${urlFor(f)}') format('${FONT_FORMAT[f.ext] || 'truetype'}'); font-weight: ${f.weight}; font-style: ${f.style}; font-display: block; }`).join('\n');
export function fontCssFor(fonts, urlFor = null) {
  return [...fonts.urls.map((u) => `@import url('${u}');`), urlFor ? fontFaceCss(fonts, urlFor) : ''].filter(Boolean).join('\n');
}

export function compileAll(cfg, slug, { buildId = null, divi = true } = {}) {
  const { ir: baseIr, tokens, assets, w } = loadAnalysis(cfg, slug);
  const repairs = loadRepairs(w.repairs);
  const ir = applyIrRepairs(structuredClone(baseIr), repairs);
  const fonts = resolveFonts(cfg, ir, fontRepairs(repairs));
  const plan = readJsonIf(w.plan);
  const hash = sha([baseIr.source.inputHash, repairs.entries.filter((e) => !e.reverted).map((e) => e.id), plan?.version || 0, COMPILER_VERSION, COMPILER_HASH, fonts.substitutions, (fonts.faces || []).map((f) => f.sha)], 8);
  const id = buildId || `${timestampId()}-${hash}`;

  const stillKey = (n) => `${n.id}:still`;
  const ctxFor = (assetUrl) => ({
    fonts: { substitutions: fonts.substitutions },
    assetMeta: (k) => assets[k],
    assetUrl: (k) => (k && assets[k]?.exists ? assetUrl(k) : null),
    videoStill: (n) => (n.videoStill && assets[stillKey(n)]?.exists ? { url: assetUrl(stillKey(n)), ...n.videoStill.background } : null),
  });

  // Preview: assets copied next to the HTML.
  const dir = w.build(id);
  const prevDir = ensureDir(path.join(dir, 'preview'));
  const prevAssets = ensureDir(path.join(prevDir, 'assets'));
  const previewUrl = (k) => {
    const a = assets[k];
    const name = `${a.sha.slice(0, 12)}${path.extname(a.file)}`;
    const dest = path.join(prevAssets, name);
    if (!fs.existsSync(dest)) fs.copyFileSync(a.file, dest);
    return `assets/${name}`;
  };
  const treeA = buildBoxTree(ir, ir.frames[0].id, ctxFor(previewUrl));
  const appliedA = applyCssRepairs(treeA, repairs);
  const tCss = tokenCss(tokens);
  const previewFont = (f) => {
    const name = `font-${f.sha}${f.ext}`;
    if (!fs.existsSync(path.join(prevAssets, name))) fs.copyFileSync(f.file, path.join(prevAssets, name));
    return `assets/${name}`;
  };
  const html = renderHtml(treeA, { title: `${slug} — f2d preview ${id}`, fontCss: fontCssFor(fonts, previewFont), tokenCss: tCss });
  writeText(path.join(prevDir, 'index.html'), html.html);
  writeText(path.join(prevDir, 'style.css'), html.css);
  fs.copyFileSync(RUNTIME_FILE, path.join(prevDir, 'f2d-runtime.js'));

  let diviOut = null;
  const used = new Set();
  if (divi) {
    const treeB = buildBoxTree(ir, ir.frames[0].id, ctxFor((k) => (used.add(k), assetPlaceholder(k))));
    applyCssRepairs(treeB, repairs);
    diviOut = compileDivi(treeB, ir, { buildId: id, fontCss: '', tokens, tokenCss: tCss, fonts });
    writeText(path.join(dir, 'divi', 'layout.txt'), diviOut.shortcodes);
    // Font files go up with the deploy (f2d-font:// placeholders resolve to their media URLs).
    const faceCss = fontFaceCss(fonts, fontPlaceholder);
    writeText(path.join(dir, 'divi', 'page.css'), faceCss ? `${faceCss}\n${diviOut.css}` : diviOut.css);
    writeJson(path.join(dir, 'divi', 'font-files.json'), (fonts.faces || []).map((f) => ({ key: `font:${f.sha}`, sha: f.sha, file: f.file, ext: f.ext, family: f.family })));
    writeJson(path.join(dir, 'divi', 'fonts.json'), fonts.urls);
    writeJson(path.join(dir, 'divi', 'global-colors.json'), diviOut.globalColors || {});
  }
  writeJson(path.join(dir, 'layout.json'), { frame: treeA.frame, issues: treeA.issues, root: slimTree(treeA.root) });

  const validation = validateBuild({ ir, treeA, diviOut, assets, used, cfg, tokens });
  const manifest = {
    schema: 'f2d-build/1',
    buildId: id,
    slug,
    createdAt: new Date().toISOString(),
    compiler: COMPILER_VERSION,
    compilerHash: COMPILER_HASH,
    inputHash: baseIr.source.inputHash,
    planVersion: plan?.version || null,
    repairs: repairs.entries.filter((e) => !e.reverted).map((e) => e.id),
    repairsApplied: appliedA,
    fonts: fonts.report,
    target: { os: cfg.target.os, adapter: 'divi-v4' },
    html: { file: 'preview/index.html', elements: html.manifest.length },
    divi: diviOut ? { file: 'divi/layout.txt', css: 'divi/page.css', sections: diviOut.manifest.sections, rows: diviOut.manifest.rows, counts: diviOut.manifest.counts, fallbacks: diviOut.manifest.fallbacks, unsupported: diviOut.manifest.unsupported, assets: [...used] } : null,
    layoutIssues: treeA.issues,
    validation,
  };
  writeJson(path.join(dir, 'manifest.json'), manifest);
  const st = loadState(w);
  st.builds.push({ id, at: manifest.createdAt, valid: validation.ok });
  writeJson(w.state, st);
  if (!validation.ok) log.warn(`build ${id} validation failed: ${validation.errors.join('; ')}`);
  return { id, dir, manifest, ir, tree: treeA, diviOut, fonts };
}

function slimTree(b) {
  return { id: b.id, cls: b.cls, kind: b.kind, tag: b.tag, name: b.name, css: b.css, children: b.children.map(slimTree) };
}

export function parseShortcodes(text) {
  // Balanced-tag check over et_pb_* shortcodes; returns { ok, errors, counts, classes }.
  const re = /\[(\/?)(et_pb_[a-z_]+)((?:\s+[a-z_0-9]+="[^"]*")*)\s*\]/g;
  const stack = [], errors = [], counts = {}, classes = new Set();
  let m;
  while ((m = re.exec(text))) {
    const [, close, tag, attrs] = m;
    if (close) {
      const top = stack.pop();
      if (top !== tag) errors.push(`unbalanced: closing ${tag} but open ${top}`);
    } else {
      stack.push(tag);
      counts[tag] = (counts[tag] || 0) + 1;
      const mc = attrs.match(/module_class="([^"]*)"/);
      if (mc) for (const c of mc[1].split(/\s+/)) classes.add(c);
    }
  }
  if (stack.length) errors.push(`unclosed: ${stack.join(',')}`);
  const nesting = [];
  return { ok: !errors.length, errors, counts, classes, nesting };
}

function validateBuild({ ir, treeA, diviOut, assets, used, cfg, tokens }) {
  const errors = [], warnings = [];
  const sections = Object.values(ir.nodes).filter((n) => n.a.role === 'section');
  if (diviOut) {
    const p = parseShortcodes(diviOut.shortcodes);
    errors.push(...p.errors);
    for (const s of sections) if (!p.classes.has(s.cls)) errors.push(`section ${s.name} (${s.cls}) missing from Divi layout`);
    if ((p.counts.et_pb_section || 0) !== sections.length) errors.push(`Divi sections ${p.counts.et_pb_section} != IR sections ${sections.length}`);
    for (const k of used) if (!assets[k]?.exists) errors.push(`asset ${k} missing`);
    if (/\n/.test(diviOut.shortcodes.replace(/\]\n\[et_pb_section/g, ''))) warnings.push('newlines inside layout (wpautop may inject <p>)');
    for (const f of lintCss(diviOut.css, { os: cfg.target.os })) (f.severity === 'major' ? errors : warnings).push(`css ${f.code}: ${f.snippet}`);
    // Token use: native colour attributes must be a global colour id or a recorded literal.
    const literal = [...diviOut.shortcodes.matchAll(/_color(?:__hover)?="([^"]+)"/g)].map((m) => m[1]).filter((v) => !v.startsWith('gcid-'));
    const promoted = new Set(tokens.colors.filter((c) => c.id).map((c) => c.value));
    const leaked = [...new Set(literal)].filter((v) => promoted.has(v.toLowerCase()));
    if (leaked.length) warnings.push(`promoted token colours emitted as literals: ${leaked.slice(0, 5).join(', ')}`);
    if (diviOut.manifest.unsupported.length) warnings.push(`${diviOut.manifest.unsupported.length} unsupported constructs (see manifest)`);
  }
  if (treeA.issues.some((i) => i.severity === 'major')) warnings.push(`${treeA.issues.filter((i) => i.severity === 'major').length} layout issues (see manifest.layoutIssues)`);
  return { ok: !errors.length, errors, warnings };
}
