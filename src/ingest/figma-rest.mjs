// Figma REST helpers: verify access, fetch image-fill sources (incl. the poster frame behind video
// fills, which figma-ir exports omit), and render node PNGs as references. The token comes from the
// environment (FIGMA_TOKEN) or an env file and is never written to artifacts or logs.
import fs from 'node:fs';
import path from 'node:path';
import { F2DError, sha, round } from '../util/core.mjs';

const API = 'https://api.figma.com/v1';

export function loadEnvFile(p) {
  if (!p || !fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

export function figmaAuth(cfg) {
  const env = { ...loadEnvFile(cfg.figma?.envFile && path.resolve(cfg.projectDir, cfg.figma.envFile)), ...process.env };
  const token = env.FIGMA_TOKEN;
  const fileKey = cfg.figma?.fileKey || env.FIGMA_FILE_KEY;
  if (!token || !fileKey) return null;
  return { token, fileKey };
}

// Figma rate-limits aggressively (429). Retry with backoff honouring Retry-After; callers cache
// results on disk so builds never re-fetch.
async function get(auth, url, tries = 4) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: { 'X-Figma-Token': auth.token } });
    if (res.ok) return res.json();
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    if (res.status === 429 && retryAfter > 120) {
      // Starter-plan files get multi-day lockouts; waiting is pointless — fail with the facts.
      throw new F2DError('E_FIGMA_RATE_LIMIT', `Figma API rate limit (${res.headers.get('x-figma-plan-tier') || '?'} plan, ${res.headers.get('x-figma-rate-limit-type') || '?'} tier): retry after ${Math.round(retryAfter / 3600)}h. Use cached data or the figma-ir export.`);
    }
    if (res.status === 429 && i < tries - 1) {
      const wait = retryAfter || 5 * 2 ** i;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    throw new F2DError('E_FIGMA', `Figma API ${res.status} for ${url.split('?')[0]}`);
  }
}

export const parseFigmaUrl = (u) => {
  const m = String(u).match(/figma\.com\/(?:design|file)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?[^?]*(?:\?.*node-id=([0-9]+-[0-9]+))?/);
  return m ? { fileKey: m[2] || m[1], nodeId: m[3] ? m[3].replace('-', ':') : null } : null;
};

export async function nodes(auth, ids, depth = 1) {
  const d = await get(auth, `${API}/files/${auth.fileKey}/nodes?ids=${encodeURIComponent(ids.join(','))}&depth=${depth}`);
  return Object.fromEntries(Object.entries(d.nodes).map(([k, v]) => [k, v?.document]));
}

export async function imageFillUrls(auth) {
  const d = await get(auth, `${API}/files/${auth.fileKey}/images`);
  return d.meta?.images || {};
}

export async function renderNodes(auth, ids, { format = 'png', scale = 1 } = {}) {
  const d = await get(auth, `${API}/images/${auth.fileKey}?ids=${encodeURIComponent(ids.join(','))}&format=${format}&scale=${scale}`);
  return d.images || {};
}

export async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new F2DError('E_FIGMA', `download failed ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

// CSS background placement for a Figma imageTransform (2x3 affine in the image's unit space).
export function transformToBackground(t) {
  if (!t) return { size: 'cover', position: 'center' };
  const sx = t[0][0], sy = t[1][1], tx = t[0][2], ty = t[1][2];
  const pct = (off, s) => (Math.abs(1 - s) < 1e-6 ? 50 : round((off / (1 - s)) * 100, 2));
  return { size: `${round(100 / sx, 3)}% ${round(100 / sy, 3)}%`, position: `${pct(tx, sx)}% ${pct(ty, sy)}%` };
}

// For every IR node with a video fill (or an image fill without an exported asset), fetch the
// source image Figma stores for it. Returns { [nodeId]: { file, background } }.
export async function fetchMissingFills(ir, auth, destDir) {
  const want = Object.values(ir.nodes).filter((n) => n.fills.some((f) => f.type === 'video') || (n.fills.some((f) => f.type === 'image') && !n.asset && !n.fillAsset));
  if (!want.length) return {};
  const cacheFile = path.join(destDir, 'fills.json');
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (want.every((n) => cached[n.id] && fs.existsSync(cached[n.id].file))) return cached;
  }
  if (!auth) return {};
  const docs = await nodes(auth, want.map((n) => n.id));
  const urls = await imageFillUrls(auth);
  const out = {};
  for (const n of want) {
    const doc = docs[n.id];
    const fill = doc?.fills?.find((f) => f.type === 'IMAGE' && f.imageRef);
    if (!fill || !urls[fill.imageRef]) continue;
    const file = path.join(destDir, `fill-${sha(n.id, 8)}-${fill.imageRef.slice(0, 8)}.png`);
    if (!fs.existsSync(file)) await download(urls[fill.imageRef], file);
    out[n.id] = { file, imageRef: fill.imageRef, scaleMode: fill.scaleMode, background: transformToBackground(fill.imageTransform), source: 'figma-rest image fill (video poster)' };
  }
  fs.writeFileSync(cacheFile, JSON.stringify(out, null, 2));
  return out;
}
