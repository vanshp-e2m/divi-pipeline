// Stage "analyze": input -> normalized + analysed IR, tokens, assets, fonts, input manifest.
import fs from 'node:fs';
import path from 'node:path';
import * as figmaIr from '../ingest/figma-ir.mjs';
import * as rest from '../ingest/figma-rest.mjs';
import { normalize } from '../ir/normalize.mjs';
import { analyze } from '../ir/analyze.mjs';
import { collectTokens } from '../ir/tokens.mjs';
import { writeJson, readJsonIf, fileSha, sha, log, F2DError } from '../util/core.mjs';
import { ws } from '../workspace.mjs';
import { pageConfig } from '../config.mjs';

export function resolveInput(cfg, slug) {
  const pc = pageConfig(cfg, slug);
  const w = ws(cfg, slug);
  let input = path.resolve(cfg.projectDir, pc.input);
  if (!fs.existsSync(input)) throw new F2DError('E_INPUT', `Input not found: ${input}`);
  if (input.toLowerCase().endsWith('.zip')) {
    const dest = path.join(w.inputs, 'ir-' + fileSha(input, 10));
    if (!fs.existsSync(path.join(dest, 'ir.json'))) figmaIr.extractZip(input, dest);
    input = dest;
  }
  if (!figmaIr.detect(input)) throw new F2DError('E_INPUT', `Unrecognised input at ${input} (supported: figma-ir/1 folder or zip)`);
  return input;
}

// Font resolution: design family -> CSS stack + stylesheet URLs. Missing fonts are reported and
// only substituted when the config (or a recorded font repair) says so.
export function resolveFonts(cfg, ir, fontRepairs = {}) {
  const subs = { ...(cfg.fonts?.substitutions || {}) };
  for (const [fam, r] of Object.entries(fontRepairs)) subs[fam] = { ...(subs[fam] || {}), ...r };
  const urls = [];
  const report = [];
  const faces = []; // the user's own font files, served with @font-face under the design's family name
  for (const f of ir.fonts) {
    const s = subs[f.family];
    const entry = { family: f.family, runs: f.runs, missingInExport: f.missingInExport, status: 'assumed-installed' };
    if (s?.files?.length) {
      entry.status = 'font-files';
      for (const x of s.files) {
        if (!fs.existsSync(x.file)) throw new F2DError('E_FONT', `Font file for "${f.family}" not found: ${x.file}`);
        faces.push({ family: f.family, weight: x.weight || 400, style: x.style || 'normal', file: x.file, sha: fileSha(x.file), ext: path.extname(x.file).toLowerCase() });
      }
    }
    else if (s?.substitute) {
      // The design's own family served from a stylesheet (e.g. Google Fonts) is the real font, not a
      // stand-in: no fidelity risk.
      entry.status = s.substitute === f.family ? 'web-font' : 'substituted';
      if (entry.status === 'substituted') entry.substitute = s.substitute;
      entry.reason = s.reason || null;
      // Text renders only once the web font is ready (Google Fonts block period, ≤ 3s): with `swap` a
      // wider web font re-wraps rows that fitted in the fallback (a nav dropping to a second line
      // pushed the page down, CLS 0.106 at 1191px).
      if (s.css) urls.push(/fonts\.googleapis\.com/.test(s.css) ? s.css.replace(/([?&])display=[a-z]+/, '$1display=block').replace(/^([^?]*\?(?!.*display=).*)$/, '$1&display=block') : s.css);
    } else if (/helvetica|arial/i.test(f.family)) entry.status = 'system-stack (Helvetica -> Arial on Windows)';
    else if (f.missingInExport) entry.status = 'MISSING';
    report.push(entry);
  }
  return { substitutions: subs, urls: [...new Set(urls)], faces, report };
}

export async function runAnalyze(cfg, slug, { refetch = false } = {}) {
  const w = ws(cfg, slug);
  const input = resolveInput(cfg, slug);
  const bundle = figmaIr.load(input);
  const ir = analyze(normalize(bundle, { slug }));

  // Image fills the export could not provide (video posters): cached Figma REST fetch.
  let fills = readJsonIf(path.join(w.fills, 'fills.json'), {});
  const needFills = Object.values(ir.nodes).filter((n) => n.fills.some((f) => f.type === 'video'));
  if (needFills.length && (refetch || needFills.some((n) => !fills[n.id]))) {
    const auth = rest.figmaAuth(cfg);
    try {
      fills = auth ? await rest.fetchMissingFills(ir, auth, w.fills) : fills;
    } catch (e) {
      log.warn(`Figma fill fetch failed: ${e.message}`);
      ir.issues.push({ code: 'FIGMA_FETCH_FAILED', severity: 'warn', nodeId: null, message: e.message });
    }
  }
  for (const n of needFills) {
    if (fills[n.id]) {
      n.videoStill = { file: fills[n.id].file, background: fills[n.id].background, source: fills[n.id].source };
      ir.issues = ir.issues.filter((i) => !(i.code === 'VIDEO_FILL' && i.nodeId === n.id));
      ir.issues.push({ code: 'VIDEO_FILL_STILL', severity: 'info', nodeId: n.id, message: `Video fill rendered with its Figma poster frame (${fills[n.id].source})` });
    }
  }

  const tokens = collectTokens(ir);
  const fonts = resolveFonts(cfg, ir);

  const assets = {};
  for (const [k, a] of Object.entries(ir.assets)) assets[k] = { ...a, sha: a.exists ? fileSha(a.file, 32) : null };
  for (const n of needFills) if (n.videoStill) assets[`${n.id}:still`] = { key: `${n.id}:still`, canonical: `${n.id}:still`, kind: 'image', file: n.videoStill.file, exists: fs.existsSync(n.videoStill.file), sha: fileSha(n.videoStill.file, 32) };

  const frame = ir.frames[0];
  const manifest = {
    schema: 'f2d-input/1',
    slug,
    input,
    adapter: bundle.adapter,
    inputHash: bundle.inputHash,
    exportedAt: bundle.meta.exportedAt,
    frames: ir.frames.map((f) => ({ id: f.id, name: f.name, viewport: f.viewport, width: f.width, height: f.height, screenshot: f.screenshot?.path || null, screenshotSha: f.screenshot ? fileSha(f.screenshot.path, 16) : null })),
    nodes: Object.keys(ir.nodes).length,
    assets: { referenced: Object.keys(ir.assets).length, missing: Object.values(ir.assets).filter((a) => !a.exists).map((a) => a.key) },
    fonts: fonts.report,
    responsiveFrames: ir.frames.map((f) => f.viewport),
    missingViewports: ['desktop', 'tablet', 'phone'].filter((v) => !ir.frames.some((f) => f.viewport === v)),
    interactions: ir.interactions.length,
    issues: ir.issues,
    analysis: summarize(ir),
  };
  writeJson(w.ir, ir);
  writeJson(w.tokens, tokens);
  writeJson(w.assets, assets);
  writeJson(w.inputManifest, manifest);
  return { ir, tokens, assets, fonts, manifest, w, frame };
}

function summarize(ir) {
  const roles = {};
  for (const n of Object.values(ir.nodes)) roles[n.a.role] = (roles[n.a.role] || 0) + 1;
  return {
    roles,
    sections: Object.values(ir.nodes).filter((n) => n.a.role === 'section').sort((a, b) => a.a.sectionIndex - b.a.sectionIndex).map((n) => ({ id: n.id, name: n.name, y: n.box.y, h: n.box.h })),
    widgets: Object.values(ir.nodes).filter((n) => n.a.widget).map((n) => ({ id: n.id, name: n.name, widget: n.a.widget })),
    inferredLayouts: Object.values(ir.nodes).filter((n) => n.a.inferredLayout).map((n) => ({ id: n.id, name: n.name, dir: n.a.inferredLayout.dir, confidence: n.a.inferredLayout.confidence })),
    decor: Object.values(ir.nodes).filter((n) => n.a.decor).length,
  };
}

export const loadAnalysis = (cfg, slug) => {
  const w = ws(cfg, slug);
  const ir = readJsonIf(w.ir);
  if (!ir) throw new F2DError('E_NO_IR', `No analysed IR for ${slug}. Run "f2d analyze ${slug}".`);
  return { ir, tokens: readJsonIf(w.tokens), assets: readJsonIf(w.assets, {}), manifest: readJsonIf(w.inputManifest), w };
};
