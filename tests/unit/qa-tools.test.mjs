// The f2d-qa agent's instruments: pixel comparison with compare_screenshots.py semantics, and the
// state check that keeps every lock backed by evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { pixelCompare, validateState, statePath } from '../../src/qa/tools.mjs';
import { tmpDir } from '../helpers.mjs';

const img = (w, h, fn) => {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; const [r, g, b] = fn(x, y); p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = 255; }
  return p;
};

test('pixel compare: per-channel difference above 24 is a mismatch (noise below it is not)', () => {
  const a = img(100, 50, () => [100, 100, 100]);
  assert.equal(pixelCompare(a, img(100, 50, () => [120, 110, 90])).similarity_pct, 100, 'anti-aliasing-level noise');
  const half = pixelCompare(a, img(100, 50, (x) => (x < 50 ? [100, 100, 100] : [200, 100, 100])));
  assert.equal(half.similarity_pct, 50);
  assert.equal(half.mismatched_pixels, 2500);
});

test('pixel compare: a section a few px lower scores well at its best vertical alignment', () => {
  const stripes = (off) => img(80, 80, (x, y) => ((y + off) % 20 < 10 ? [0, 0, 0] : [255, 255, 255]));
  const ref = stripes(0), built = stripes(-4); // built content sits 4px lower
  assert.ok(pixelCompare(ref, built).similarity_pct < 70);
  assert.equal(pixelCompare(ref, built, { shift: 4 }).similarity_pct, 100);
});

test('section state: a lock without evidence on disk is rejected', () => {
  const dir = tmpDir('f2d-state-');
  const cfg = { projectDir: dir };
  const file = statePath(cfg, 'p');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sec = (o) => ({ index: 0, name: 'Hero', status: 'locked', iterations: [{ similarity_pct: 96 }], similarity_by_width: { 1920: 96 }, diff_images: { 1920: 'qa/agent/b/shots/hero-diff.png' }, responsive: { status: 'responsive', widths_checked: ['1920', '390'] }, notes: 'ok', ...o });
  fs.writeFileSync(file, JSON.stringify({ widths: { scored: [1920], responsive: ['1920', '390'] }, sections: [sec({})] }));
  let v = validateState(cfg, 'p');
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /diff image/.test(e)), 'the diff image must exist');
  assert.ok(v.errors.some((e) => /below 98%/.test(e)), 'below 98% needs a reason');
  fs.mkdirSync(path.join(dir, 'pages', 'p', 'qa', 'agent', 'b', 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pages', 'p', 'qa', 'agent', 'b', 'shots', 'hero-diff.png'), '');
  fs.writeFileSync(file, JSON.stringify({ widths: { scored: [1920], responsive: ['1920', '390'] }, sections: [sec({ below_98_reason: 'substituted font metrics' })] }));
  v = validateState(cfg, 'p');
  assert.equal(v.ok, true, v.errors.join('; '));
  fs.writeFileSync(file, JSON.stringify({ widths: { scored: [1920], responsive: ['1920', '390', '320'] }, sections: [sec({ below_98_reason: 'x' })] }));
  assert.ok(validateState(cfg, 'p').errors.some((e) => /widths not checked/.test(e)), 'responsive done means every width looked at');
});
