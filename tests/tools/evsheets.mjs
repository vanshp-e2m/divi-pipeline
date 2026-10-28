// Dev tool: contact sheets from a QA pass's own full-page evidence (no re-render).
// node tests/tools/evsheets.mjs <qaPassDir> <outDir> 981,1004,1191
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { readPng, downscale, writePng } from '../../src/qa/compare.mjs';

const [qdir, outDir, widthsArg] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const SH = 2600;
for (const w of widthsArg.split(',')) {
  const f = ['w', 'd'].map((p) => path.join(qdir, 'evidence', `${p}${w}.png`)).find((x) => fs.existsSync(x));
  if (!f) { console.log(w, 'missing'); continue; }
  const img = readPng(f);
  const n = Math.ceil(img.height / SH);
  const sheet = new PNG({ width: n * (img.width + 10), height: SH });
  sheet.data.fill(255);
  for (let i = 0; i < n; i++) for (let y = 0; y < SH && i * SH + y < img.height; y++) img.data.copy(sheet.data, (y * sheet.width + i * (img.width + 10)) * 4, (i * SH + y) * img.width * 4, (i * SH + y + 1) * img.width * 4);
  writePng(path.join(outDir, `sheet-${w}.png`), downscale(sheet, 1100 / SH));
  console.log(w, 'ok');
}
