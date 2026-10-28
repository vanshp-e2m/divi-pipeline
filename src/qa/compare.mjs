// Visual comparison engine: SSIM + pixel mismatch + edge similarity + colour histogram,
// full page and per region, with diff / overlay / side-by-side evidence images.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { ssim } from 'ssim.js';
import { round } from '../util/core.mjs';

export const readPng = (p) => PNG.sync.read(fs.readFileSync(p));
export function writePng(p, img) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, PNG.sync.write(img));
  return p;
}
export const blank = (w, h, fill = 255) => {
  const img = new PNG({ width: w, height: h });
  img.data.fill(fill);
  return img;
};

export function crop(img, x, y, w, h) {
  x = Math.max(0, Math.round(x));
  y = Math.max(0, Math.round(y));
  w = Math.max(1, Math.min(Math.round(w), img.width - x));
  h = Math.max(1, Math.min(Math.round(h), img.height - y));
  const out = new PNG({ width: w, height: h });
  for (let r = 0; r < h; r++) img.data.copy(out.data, r * w * 4, ((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4);
  return out;
}

// Flatten alpha onto white (Figma exports are RGBA).
export function flatten(img) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (a < 1) {
      d[i] = d[i] * a + 255 * (1 - a);
      d[i + 1] = d[i + 1] * a + 255 * (1 - a);
      d[i + 2] = d[i + 2] * a + 255 * (1 - a);
      d[i + 3] = 255;
    }
  }
  return img;
}

export function downscale(img, f) {
  if (f >= 1) return img;
  const w = Math.max(1, Math.round(img.width * f)), h = Math.max(1, Math.round(img.height * f));
  const out = new PNG({ width: w, height: h });
  const sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * img.width + xx) * 4;
        r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
      }
      const o = (y * w + x) * 4;
      out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = 255;
    }
  }
  return out;
}

function gray(img) {
  const g = new Float32Array(img.width * img.height);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  return g;
}

function edges(img) {
  const { width: w, height: h } = img;
  const g = gray(img);
  const e = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
    const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
    if (gx * gx + gy * gy > 60 * 60) e[i] = 1;
  }
  return e;
}

// Edge F1 with a 2px tolerance: how much structure (text, borders, shapes) lines up.
function edgeScore(a, b) {
  const ea = edges(a), eb = edges(b), w = a.width, h = a.height;
  const near = (e, x, y) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && e[yy * w + xx]) return true;
    }
    return false;
  };
  let na = 0, nb = 0, ma = 0, mb = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (ea[i]) { na++; if (near(eb, x, y)) ma++; }
    if (eb[i]) { nb++; if (near(ea, x, y)) mb++; }
  }
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  const p = ma / na, r = mb / nb;
  return p + r ? (2 * p * r) / (p + r) : 0;
}

function histScore(a, b) {
  const bins = (img) => {
    const hst = new Float64Array(512);
    for (let i = 0; i < img.data.length; i += 4) hst[((img.data[i] >> 5) << 6) | ((img.data[i + 1] >> 5) << 3) | (img.data[i + 2] >> 5)]++;
    const n = img.data.length / 4;
    return hst.map((v) => v / n);
  };
  const ha = bins(a), hb = bins(b);
  let s = 0;
  for (let i = 0; i < 512; i++) s += Math.min(ha[i], hb[i]);
  return s;
}

// Compare two same-sized images. Returns component metrics and the weighted score.
// Weighted score from component metrics (lets calibration re-weight without recomputing).
export const scoreFrom = (c, w) => round((w.ssim * c.ssim + w.pixel * c.pixel + w.edge * c.edge + w.color * c.color) * c.heightRatio, 4);

// k1 = SSIM luminance stabiliser. The textbook 0.01 makes SSIM collapse on near-black flat areas
// for imperceptible brightness shifts (+6 on #000 scores ~0.15); calibration selects the value.
export const DEFAULT_SSIM_K1 = 0.05;

export function compareImages(ref, out, { weights = { ssim: 0.45, pixel: 0.25, edge: 0.15, color: 0.15 }, scale = 0.5, diffPath = null, k1 = DEFAULT_SSIM_K1 } = {}) {
  const w = Math.min(ref.width, out.width), h = Math.min(ref.height, out.height);
  const A = ref.width === w && ref.height === h ? ref : crop(ref, 0, 0, w, h);
  const B = out.width === w && out.height === h ? out : crop(out, 0, 0, w, h);
  const diff = new PNG({ width: w, height: h });
  const mismatched = pixelmatch(A.data, B.data, diff.data, w, h, { threshold: 0.1, includeAA: false, alpha: 0.3 });
  if (diffPath) writePng(diffPath, downscale(diff, Math.min(1, 1200 / Math.max(w, 1))));
  const a = downscale(A, scale), b = downscale(B, scale);
  let s = 0;
  try {
    s = ssim({ data: a.data, width: a.width, height: a.height }, { data: b.data, width: b.width, height: b.height }, { ssim: 'fast', k1 }).mssim;
  } catch {
    s = 0;
  }
  const pixel = 1 - mismatched / (w * h);
  const edge = edgeScore(a, b);
  const color = histScore(a, b);
  // Height mismatch is penalised: content that is missing or extra cannot be compared pixel-wise.
  const heightRatio = Math.min(ref.height, out.height) / Math.max(ref.height, out.height);
  return {
    score: scoreFrom({ ssim: s, pixel, edge, color, heightRatio }, weights),
    ssim: round(s, 4),
    pixel: round(pixel, 4),
    edge: round(edge, 4),
    color: round(color, 4),
    heightRatio: round(heightRatio, 4),
    size: { ref: [ref.width, ref.height], out: [out.width, out.height] },
  };
}

export function overlay(ref, out, alpha = 0.5) {
  const w = Math.min(ref.width, out.width), h = Math.min(ref.height, out.height);
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, ia = (y * ref.width + x) * 4, ib = (y * out.width + x) * 4;
    for (let c = 0; c < 3; c++) img.data[i + c] = ref.data[ia + c] * (1 - alpha) + out.data[ib + c] * alpha;
    img.data[i + 3] = 255;
  }
  return img;
}

export function sideBySide(ref, out, gap = 8) {
  const h = Math.max(ref.height, out.height), w = ref.width + gap + out.width;
  const img = blank(w, h, 200);
  const put = (src, ox) => {
    for (let y = 0; y < src.height; y++) src.data.copy(img.data, (y * w + ox) * 4, y * src.width * 4, (y + 1) * src.width * 4);
  };
  put(ref, 0);
  put(out, ref.width + gap);
  return img;
}
