// Dev tool: full-page renders of the deployed page at given widths + contact sheets for review.
// node tests/tools/sheets.mjs <projectDir> <slug> <outDir> 375,390,430,768
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { launch, scrollbarWidth, capture, release } from '../../src/qa/render.mjs';
import { readPng, downscale, writePng } from '../../src/qa/compare.mjs';

const [projectDir, slug, outDir, widthsArg] = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(path.join(projectDir, 'pages', slug, 'state.json'), 'utf8'));
const widths = widthsArg.split(',').map(Number);
fs.mkdirSync(outDir, { recursive: true });
const b = await launch('classic');
const sb = await scrollbarWidth(b);
for (const w of widths) {
  const file = path.join(outDir, `w${w}.png`);
  const r = await capture(b, st.post.previewUrl, { width: w, match: 'window', scrollbar: sb, screenshot: file, collect: false });
  console.log(w, 'client', r.metrics.clientWidth, 'docH', r.metrics.docHeight, 'overflowX', r.metrics.scrollWidth - r.metrics.clientWidth);
  await release(r);
  // contact sheet: strips of 2600px side by side, scaled to 1100px tall
  const img = readPng(file);
  const SH = 2600, n = Math.ceil(img.height / SH);
  const sheet = new PNG({ width: n * (img.width + 10), height: SH });
  sheet.data.fill(255);
  for (let i = 0; i < n; i++) {
    for (let y = 0; y < SH && i * SH + y < img.height; y++) img.data.copy(sheet.data, (y * sheet.width + i * (img.width + 10)) * 4, ((i * SH + y) * img.width) * 4, ((i * SH + y + 1) * img.width) * 4);
  }
  writePng(path.join(outDir, `sheet-${w}.png`), downscale(sheet, 1100 / SH));
}
await b.close();
