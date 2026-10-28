// Metric validation: apply controlled perturbations to real reference crops and check that the
// visual score (a) orders them by severity and (b) separates rendering noise from real defects at
// the configured threshold. Results go to docs/calibration.json and docs/SCORING.md.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { readPng, flatten, crop, compareImages, scoreFrom, DEFAULT_SSIM_K1 } from './compare.mjs';
import { writeJson, writeText, round, readJson, F2DError } from '../util/core.mjs';

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');

const clone = (img) => {
  const o = new PNG({ width: img.width, height: img.height });
  img.data.copy(o.data);
  return o;
};
function shift(img, dx, dy) {
  const o = clone(img);
  o.data.fill(255);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const sx = x - dx, sy = y - dy;
    if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
    img.data.copy(o.data, (y * img.width + x) * 4, (sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4);
  }
  return o;
}
function blur(img, r) {
  const o = clone(img);
  const { width: w, height: h } = img;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0, b = 0, c = 0, n = 0;
    for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
      const i = (yy * w + xx) * 4;
      a += img.data[i]; b += img.data[i + 1]; c += img.data[i + 2]; n++;
    }
    const i = (y * w + x) * 4;
    o.data[i] = a / n; o.data[i + 1] = b / n; o.data[i + 2] = c / n;
  }
  return o;
}
function tint(img, dr, dg, db) {
  const o = clone(img);
  for (let i = 0; i < o.data.length; i += 4) {
    o.data[i] = Math.max(0, Math.min(255, o.data[i] + dr));
    o.data[i + 1] = Math.max(0, Math.min(255, o.data[i + 1] + dg));
    o.data[i + 2] = Math.max(0, Math.min(255, o.data[i + 2] + db));
  }
  return o;
}
// "Element missing": erase the most content-dense block (fw x fh of the crop) with its corner colour,
// so the perturbation removes real content rather than empty background.
function eraseDense(img, fw, fh) {
  const bw = Math.round(img.width * fw), bh = Math.round(img.height * fh);
  let best = { s: -1, x: 0, y: 0 };
  const step = 40;
  const lum = (i) => 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  for (let y0 = 0; y0 + bh <= img.height; y0 += step) for (let x0 = 0; x0 + bw <= img.width; x0 += step) {
    let s = 0;
    for (let y = y0; y < y0 + bh; y += 8) for (let x = x0 + 8; x < x0 + bw; x += 8) s += Math.abs(lum((y * img.width + x) * 4) - lum((y * img.width + x - 8) * 4));
    if (s > best.s) best = { s, x: x0, y: y0 };
  }
  return erase(img, best.x / img.width, best.y / img.height, fw, fh);
}
function erase(img, fx, fy, fw, fh) {
  const o = clone(img);
  const x0 = Math.round(img.width * fx), y0 = Math.round(img.height * fy), x1 = x0 + Math.round(img.width * fw), y1 = y0 + Math.round(img.height * fh);
  const k = (y0 * img.width + x0) * 4;
  const col = [img.data[k], img.data[k + 1], img.data[k + 2]];
  for (let y = y0; y < Math.min(y1, img.height); y++) for (let x = x0; x < Math.min(x1, img.width); x++) {
    const i = (y * img.width + x) * 4;
    o.data[i] = col[0]; o.data[i + 1] = col[1]; o.data[i + 2] = col[2];
  }
  return o;
}
const blank = (img) => {
  const o = clone(img);
  o.data.fill(255);
  return o;
};

// expected: 'noise' = should pass the threshold, 'defect' = should fail it.
const CASES = [
  ['identical', (i) => clone(i), 'noise', 0],
  ['shift 1px', (i) => shift(i, 1, 1), 'noise', 1],
  ['blur r1 (antialiasing / font hinting)', (i) => blur(i, 1), 'noise', 1],
  ['tint +6 (colour profile)', (i) => tint(i, 6, 6, 6), 'noise', 1],
  ['shift 4px', (i) => shift(i, 4, 4), 'borderline', 2],
  ['tint +40 (wrong colour)', (i) => tint(i, 40, 0, -40), 'defect', 3],
  ['shift 16px', (i) => shift(i, 16, 16), 'defect', 3],
  ['missing content block (30% of crop, densest area)', (i) => eraseDense(i, 0.5, 0.6), 'defect', 3],
  // Heavy blur is a weak signal at the metric's 0.5 working scale; low-resolution images are caught
  // directly by the structure check structure.image-upscaled (natural vs displayed size).
  ['blur r4 (wrong image res)', (i) => blur(i, 4), 'borderline', 2],
  ['blank page', (i) => blank(i), 'defect', 4],
];

export async function calibrate(cfg, { image, out } = {}) {
  let ref;
  let crops = [];
  if (image) ref = flatten(readPng(image));
  else {
    const slug = Object.keys(cfg.pages)[0];
    const ir = readJson(path.join(cfg.projectDir, 'pages', slug, 'ir.json'));
    ref = flatten(readPng(ir.frames[0].screenshot.path));
    // Real section crops across the page: dark, light, photographic, typographic.
    crops = Object.values(ir.nodes).filter((n) => n.a.role === 'section').sort((a, b) => a.box.y - b.box.y).map((s) => ({ name: s.name, img: crop(ref, 0, s.box.y, ref.width, Math.min(s.box.h, 700)) }));
  }
  if (!crops.length) crops = [{ name: path.basename(image), img: ref }];
  const T = cfg.qa.thresholds.visual;
  // Component metrics once per (k1, case, crop); weightings are evaluated on top of them.
  const comps = {};
  // A defect perturbation that changes < 5% of a crop's pixels (e.g. blurring a flat background) is
  // not a visible defect there: that (case, crop) is skipped and reported, never silently dropped.
  const perturbed = CASES.map(([, fn]) => crops.map((c) => fn(c.img)));
  const changed = CASES.map((_, ci) => crops.map((c, k) => {
    const a = c.img.data, b = perturbed[ci][k].data;
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
    return n / (a.length / 4);
  }));
  const applies = (ci, k) => CASES[ci][2] !== 'defect' || changed[ci][k] >= 0.05;
  for (const k1 of [0.01, 0.05, 0.1]) {
    comps[k1] = CASES.map((_, ci) => crops.map((c, k) => compareImages(c.img, perturbed[ci][k], { k1 })));
  }
  const evaluate = (k1, w) => {
    const rows = CASES.map(([name, , expect, rank], ci) => {
      const scores = comps[k1][ci].map((m, k) => (applies(ci, k) ? scoreFrom(m, w) : null)).filter((x) => x !== null);
      const skipped = crops.filter((_, k) => !applies(ci, k)).map((c) => c.name);
      return { case: name, expect, rank, n: scores.length, skipped, changedMean: round(changed[ci].reduce((a, b) => a + b, 0) / crops.length, 3), mean: round(scores.reduce((a, b) => a + b, 0) / scores.length, 4), min: round(Math.min(...scores), 4), max: round(Math.max(...scores), 4) };
    });
    const byRank = [...rows].sort((a, b) => a.rank - b.rank);
    const monotonic = byRank.every((r, i) => i === 0 || byRank[i - 1].rank === r.rank || byRank[i - 1].mean >= r.mean - 0.005);
    const noiseMin = Math.min(...rows.filter((r) => r.expect === 'noise').map((r) => r.min));
    const defectMax = Math.max(...rows.filter((r) => r.expect === 'defect').map((r) => r.max));
    return { k1, weights: w, rows, checks: { monotonic, noisePass: noiseMin >= T, defectFail: defectMax < T }, margin: round(Math.min(noiseMin - T, T - defectMax), 4), noiseMin, defectMax };
  };
  const grid = [];
  for (const k1 of Object.keys(comps).map(Number))
    for (const ssimW of [0.2, 0.3, 0.45]) for (const edge of [0.15, 0.3, 0.45, 0.6]) for (const pixel of [0.1, 0.25]) {
      const color = round(1 - ssimW - edge - pixel, 2);
      if (color < 0.05) continue;
      grid.push(evaluate(k1, { ssim: ssimW, pixel, edge, color }));
    }
  const current = evaluate(DEFAULT_SSIM_K1, cfg.qa.weights);
  const valid = grid.filter((g) => g.checks.monotonic && g.checks.noisePass && g.checks.defectFail).sort((a, b) => b.margin - a.margin);
  const best = valid[0] || [...grid].sort((a, b) => b.margin - a.margin)[0];
  const result = {
    at: new Date().toISOString(),
    threshold: T,
    crops: crops.map((c) => c.name),
    current: { k1: DEFAULT_SSIM_K1, weights: cfg.qa.weights, rows: current.rows, checks: current.checks, margin: current.margin },
    candidates: grid.length,
    validCandidates: valid.length,
    selected: { k1: best.k1, weights: best.weights, margin: best.margin },
    weights: best.weights,
    k1: best.k1,
    rows: best.rows,
    checks: best.checks,
    valid: valid.length > 0,
  };
  writeJson(path.join(out || DOCS, 'calibration.json'), result);
  writeText(path.join(out || DOCS, 'SCORING.md'), scoringMd(result));
  return result;
}

function scoringMd(r) {
  return [
    '# Visual scoring: definition and validation',
    '',
    '## Definition',
    '',
    'For a reference image R (Figma PNG, frame width, 1x) and a rendered image O (Chromium, same CSS width, device scale 1, scrollbar compensated):',
    '',
    `score = (${r.weights.ssim}·SSIM(k1=${r.k1}) + ${r.weights.pixel}·(1 − pixelmatch mismatch ratio) + ${r.weights.edge}·edge F1 + ${r.weights.color}·colour-histogram intersection) × height ratio`,
    '',
    '- **SSIM** (ssim.js, "fast", at 0.5 scale): structure/contrast/luminance agreement.',
    '- **Pixel**: share of pixels pixelmatch (threshold 0.1, anti-aliasing ignored) considers equal.',
    '- **Edge F1**: Sobel edges (|∇| > 60) of both images matched within 2px — text, borders and shape outlines in place.',
    '- **Colour**: 8×8×8 RGB histogram intersection — palette agreement independent of position.',
    '- **Height ratio**: min(h)/max(h) — content that is missing or extra cannot score well.',
    '',
    'It is computed for the full page and for every section crop (sections aligned by their rendered DOM position, so a shift in one section does not pollute the others). A section floor prevents a good average hiding one bad section.',
    '',
    `## Validation (${r.at.slice(0, 10)}, ${r.crops.length} real section crops from the design)`,
    '',
    `Threshold under test: **${r.threshold}**. ${r.candidates} weightings × SSIM k1 were evaluated on the same perturbations; ${r.validCandidates} satisfied all three checks. Selected: k1 = ${r.k1}, weights ${JSON.stringify(r.weights)} (margin ${r.selected.margin} around the threshold).`,
    '',
    `Before calibration (k1 ${r.current.k1}, weights ${JSON.stringify(r.current.weights)}): monotonic ${r.current.checks.monotonic}, noise passes ${r.current.checks.noisePass}, defects fail ${r.current.checks.defectFail}.`,
    '',
    '| Perturbation | Expected | Crops | Pixels changed (mean) | Mean | Min | Max |',
    '|---|---|---|---|---|---|---|',
    ...r.rows.map((x) => `| ${x.case} | ${x.expect} | ${x.n}${x.skipped.length ? ` (${x.skipped.length} skipped: <5% changed)` : ''} | ${Math.round(x.changedMean * 100)}% | ${x.mean} | ${x.min} | ${x.max} |`),
    '',
    `- Monotonic with severity: **${r.checks.monotonic ? 'yes' : 'NO'}**`,
    `- Rendering noise (≤1px shift, slight blur, small tint) passes the threshold on every crop: **${r.checks.noisePass ? 'yes' : 'NO'}**`,
    `- Real defects (wrong colour, 16px shift, missing 30% content block, blank) fail it on every crop (heavy blur is borderline here; low-resolution images are caught by structure.image-upscaled): **${r.checks.defectFail ? 'yes' : 'NO'}**`,
    '',
    `Metric considered **${r.valid ? 'valid' : 'NOT validated'}** for gating at ${r.threshold}.`,
    '',
    '## Limitations',
    '',
    '- A substituted font lowers the score in every text-heavy area even when layout is correct; reports name the substitution so the cause is visible.',
    '- The metric compares at the design frame widths only; other widths are covered by the responsive checks (overflow, overlap, clipping), not by pixel similarity, because no design exists for them.',
    '- Dynamic content must be masked (config qa.masks) or it lowers scores.',
    '- Large flat areas (solid backgrounds) inflate the pixel and colour terms; the section floor and edge term counteract that.',
    '- A small missing element (< ~5% of a section) barely moves a whole-section score. That is caught by the structure (element/text/image presence) and geometry categories, not by this metric — which is why the gate requires all categories.',
    '',
  ].join('\n');
}
