// Adapter: figma-ir/1 export (zip or folder from the Figma IR Extractor plugin) -> raw input bundle.
// The raw bundle is the adapter-neutral shape normalize() consumes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJson, F2DError, fileSha, sha } from '../util/core.mjs';

export function detect(inputPath) {
  const p = resolveIrJson(inputPath, false);
  if (!p) return false;
  try {
    return readJson(p).schema === 'figma-ir/1';
  } catch {
    return false;
  }
}

function resolveIrJson(inputPath, strict = true) {
  const cand = [inputPath, path.join(inputPath, 'ir.json')];
  for (const c of cand) if (fs.existsSync(c) && fs.statSync(c).isFile() && c.endsWith('.json')) return c;
  if (strict) throw new F2DError('E_INPUT', `No ir.json found at ${inputPath}`);
  return null;
}

// Unzip into a fresh directory (never into the project root) and return the folder.
export function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (fs.readdirSync(destDir).length) throw new F2DError('E_INPUT', `Refusing to extract into non-empty ${destDir}`);
  const ps = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
  if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'pipe' });
  else execFileSync('unzip', ['-q', zipPath, '-d', destDir], { stdio: 'pipe' });
  return destDir;
}

export function load(inputPath) {
  const irPath = resolveIrJson(inputPath);
  const root = path.dirname(irPath);
  const doc = readJson(irPath);
  if (doc.schema !== 'figma-ir/1') throw new F2DError('E_INPUT', `Unsupported schema ${doc.schema} (expected figma-ir/1)`);

  const assets = {};
  for (const [key, a] of Object.entries(doc.assets || {})) {
    const file = a.file ? path.join(root, 'assets', a.file) : null;
    assets[key] = {
      key,
      canonical: a.id || key,
      kind: a.kind,
      file,
      exists: !!(file && fs.existsSync(file)),
      width: a.width,
      height: a.height,
      scale: a.scale || 1,
      hash: a.hash || null,
      nodeName: a.nodeName,
    };
  }

  const frames = doc.frames.map((f) => {
    const shot = f.screenshot ? path.join(root, f.screenshot) : null;
    return {
      sourceId: f.id,
      name: f.name,
      slug: f.slug,
      width: f.width,
      height: f.height,
      screenshot: shot && fs.existsSync(shot) ? { path: shot, scale: f.screenshotScale || 1, box: f.screenshotBox || null } : null,
      root: f.root,
    };
  });

  return {
    adapter: 'figma-ir/1',
    inputPath: root,
    inputHash: sha(fileSha(irPath, 32) + Object.values(assets).map((a) => a.hash).join(','), 16),
    meta: {
      fileName: doc.meta?.fileName,
      fileKey: doc.meta?.fileKey || null,
      exportedAt: doc.meta?.exportedAt,
      pluginVersion: doc.meta?.pluginVersion,
      rasterized: doc.meta?.rasterized || [],
    },
    fonts: doc.meta?.fonts || [],
    frames,
    assets,
  };
}
