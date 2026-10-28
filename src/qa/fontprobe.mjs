// Font substitution probe: when a design font is unavailable, render real text nodes from the
// design in each candidate font and score them against the reference crops of those nodes.
// The winner is a measured, recorded assumption — never a silent swap.
import fs from 'node:fs';
import path from 'node:path';
import { buildBoxTree, boxCss } from '../layout/engine.mjs';
import { crop, readPng, flatten, compareImages } from './compare.mjs';
import { capture, release } from './render.mjs';
import { round } from '../util/core.mjs';

export const DEFAULT_CANDIDATES = {
  display: ['Michroma', 'Krona One', 'Syncopate', 'Orbitron', 'Audiowide', 'Russo One', 'Unbounded', 'Lexend Zetta', 'Zen Dots', 'Goldman', 'Days One', 'Saira'],
  sans: ['Arimo', 'Roboto', 'Inter', 'Open Sans', 'Work Sans', 'Archivo'],
};

const gfUrl = (fam) => `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, '+')}:ital,wght@0,400;0,700&display=block`;

export async function probeFont(browser, ir, { family, candidates, referencePng, workDir, samples = 4, scrollbar = 0 }) {
  const N = ir.nodes;
  const texts = Object.values(N)
    .filter((n) => n.text && n.text.runs.every((r) => r.family === family) && !n.a?.counter && n.text.content.trim().length >= 6 && n.box.w > 40)
    .sort((a, b) => b.text.content.length * b.text.runs[0].size - a.text.content.length * a.text.runs[0].size);
  // Spread samples across sizes so one giant heading does not dominate.
  const picked = [];
  for (const t of texts) if (!picked.some((p) => p.text.runs[0].size === t.text.runs[0].size) && picked.length < samples) picked.push(t);
  if (!picked.length) return { family, results: [], reason: 'no text nodes use this family' };
  const ref = flatten(readPng(referencePng));
  const tree = buildBoxTree(ir, ir.frames[0].id, {});
  const boxes = new Map();
  const index = (b) => (boxes.set(b.id, b), b.children.forEach(index));
  index(tree.root);
  fs.mkdirSync(workDir, { recursive: true });

  const results = [];
  for (const cand of [null, ...candidates]) {
    const scores = [];
    for (const t of picked) {
      const b = boxes.get(t.id);
      const css = { ...b.css.base, position: 'absolute', left: '0', top: '0', right: null, bottom: null, margin: '0' };
      css['font-family'] = cand ? `'${cand}', sans-serif` : `'${family}', sans-serif`;
      const one = { ...b, css: { base: css, narrow: {}, tablet: {}, phone: {} }, children: [] };
      const bg = ref.data.slice(((Math.round(t.box.y) + 2) * ref.width + Math.round(t.box.x) + 2) * 4, ((Math.round(t.box.y) + 2) * ref.width + Math.round(t.box.x) + 2) * 4 + 3);
      const html = `<!doctype html><html><head>${cand ? `<link rel="stylesheet" href="${gfUrl(cand)}">` : ''}<style>html,body{margin:0;background:rgb(${bg[0]},${bg[1]},${bg[2]})} ${boxCss(one).split('@media')[0]}</style></head><body><div style="position:relative;width:${Math.ceil(t.box.w)}px;height:${Math.ceil(t.box.h)}px"><${b.tag} class="${b.cls}">${b.html}</${b.tag}></div></body></html>`;
      const file = path.join(workDir, `probe.html`);
      fs.writeFileSync(file, html);
      const shot = path.join(workDir, `shot.png`);
      const r = await capture(browser, 'file:///' + file.replace(/\\/g, '/'), { width: Math.ceil(t.box.w) + 20, height: Math.ceil(t.box.h) + 20, scrollbar, screenshot: shot, fullPage: false, collect: false });
      await release(r);
      const out = readPng(shot);
      const rc = crop(ref, t.box.x, t.box.y, t.box.w, t.box.h);
      const oc = crop(out, 0, 0, t.box.w, t.box.h);
      scores.push(compareImages(rc, oc, { scale: 1 }).score);
    }
    results.push({ candidate: cand || `(fallback for ${family})`, score: round(scores.reduce((a, b) => a + b, 0) / scores.length, 4), perSample: scores });
  }
  results.sort((a, b) => b.score - a.score);
  return { family, samples: picked.map((p) => ({ id: p.id, text: p.text.content.slice(0, 40), size: p.text.runs[0].size })), results };
}
