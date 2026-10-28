// Test helpers: turn fixture docs into analysed IR + box trees without touching a real project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { normalize } from '../src/ir/normalize.mjs';
import { analyze } from '../src/ir/analyze.mjs';
import { buildBoxTree } from '../src/layout/engine.mjs';

export const tmpDir = (p = 'f2d-test-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

export function pngFile(dir, name, w = 8, h = 8, rgb = [200, 100, 50]) {
  const img = new PNG({ width: w, height: h });
  for (let i = 0; i < img.data.length; i += 4) (img.data[i] = rgb[0]), (img.data[i + 1] = rgb[1]), (img.data[i + 2] = rgb[2]), (img.data[i + 3] = 255);
  const f = path.join(dir, name);
  fs.writeFileSync(f, PNG.sync.write(img));
  return f;
}

export function bundleFrom(doc, assetFiles = {}) {
  const assets = {};
  for (const [key, file] of Object.entries(assetFiles)) assets[key] = { key, canonical: key, kind: 'image', file, exists: fs.existsSync(file), width: 8, height: 8, scale: 1, hash: key, nodeName: key };
  return {
    adapter: 'figma-ir/1',
    inputPath: 'fixture',
    inputHash: 'fixture',
    meta: doc.meta,
    fonts: doc.meta.fonts,
    frames: doc.frames.map((f) => ({ sourceId: f.id, name: f.name, slug: f.slug, width: f.width, height: f.height, screenshot: null, root: f.root })),
    assets,
  };
}

export function analysed(doc, assetFiles) {
  return analyze(normalize(bundleFrom(doc, assetFiles), { slug: 'fixture' }));
}

export function tree(ir, ctx = {}) {
  return buildBoxTree(ir, ir.frames[0].id, { assetMeta: (k) => ir.assets[k], assetUrl: (k) => (ir.assets[k]?.exists ? `assets/${path.basename(ir.assets[k].file)}` : null), ...ctx });
}

export function findBox(root, pred) {
  if (pred(root)) return root;
  for (const c of root.children) {
    const f = findBox(c, pred);
    if (f) return f;
  }
  return null;
}
