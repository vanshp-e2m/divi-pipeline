// Dev tool: before/after evidence for a responsive change at identical viewport widths.
// node tests/tools/beforeafter.mjs <beforeDir> <afterDir> <outDir> 375,390,430,768,1024,1440,1920
// <beforeDir>/<afterDir> hold w<width>.png full-page renders (tests/tools/sheets.mjs). Writes
// <outDir>/ba-<width>.png: before (left) and after (right), cut into strips placed side by side.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { readPng, downscale, writePng } from '../../src/qa/compare.mjs';

const [beforeDir, afterDir, outDir, widthsArg] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const STRIP = 2400;
const strips = (img) => {
  const n = Math.ceil(img.height / STRIP);
  const sheet = new PNG({ width: n * (img.width + 8), height: STRIP });
  sheet.data.fill(255);
  for (let i = 0; i < n; i++) for (let y = 0; y < STRIP && i * STRIP + y < img.height; y++) img.data.copy(sheet.data, (y * sheet.width + i * (img.width + 8)) * 4, (i * STRIP + y) * img.width * 4, (i * STRIP + y + 1) * img.width * 4);
  return sheet;
};
for (const w of widthsArg.split(',').map(Number)) {
  const files = [path.join(beforeDir, `w${w}.png`), path.join(afterDir, `w${w}.png`)];
  if (!files.every((f) => fs.existsSync(f))) { console.log(w, 'missing'); continue; }
  const [a, b] = files.map((f) => strips(readPng(f)));
  const gap = 40;
  const out = new PNG({ width: a.width + gap + b.width, height: STRIP });
  out.data.fill(0);
  for (let y = 0; y < STRIP; y++) {
    a.data.copy(out.data, y * out.width * 4, y * a.width * 4, (y + 1) * a.width * 4);
    b.data.copy(out.data, (y * out.width + a.width + gap) * 4, y * b.width * 4, (y + 1) * b.width * 4);
  }
  writePng(path.join(outDir, `ba-${w}.png`), downscale(out, Math.min(1, 3000 / out.width, 1400 / STRIP)));
  console.log(w, 'ok');
}
