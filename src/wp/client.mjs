// WordPress access through WP-CLI + the f2d-bridge plugin. Payloads go through files, never the
// command line; every bridge command returns one JSON envelope { ok, data | error, message }.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { F2DError, log, redact } from '../util/core.mjs';

export function wpCommand(cfg) {
  const w = cfg.site.wp;
  if (!w?.php || !w?.phar || !w?.path) throw new F2DError('E_WP_CONFIG', 'site.wp { php, phar, path [, ini] } is not configured in f2d.config.json');
  const resolve = (p) => (p && !path.isAbsolute(p) ? path.resolve(cfg.projectDir, p) : p);
  const pre = [];
  if (w.ini) pre.push('-c', resolve(w.ini));
  return { bin: resolve(w.php), pre: [...pre, resolve(w.phar), `--path=${resolve(w.path)}`] };
}

export function wp(cfg, args, { timeoutMs = 180000, raw = false } = {}) {
  const { bin, pre } = wpCommand(cfg);
  return new Promise((resolve, reject) => {
    execFile(bin, [...pre, ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const lines = String(stdout).trim().split(/\r?\n/);
      if (raw) {
        if (err) return reject(new F2DError('E_WP', redact(`wp ${args[0]} failed: ${stderr || err.message}`.slice(0, 2000))));
        return resolve(stdout);
      }
      const last = [...lines].reverse().find((l) => l.startsWith('{'));
      let env = null;
      try {
        env = last && JSON.parse(last);
      } catch {}
      if (!env) return reject(new F2DError('E_WP', redact(`wp ${args.slice(0, 2).join(' ')}: no JSON result. ${String(stderr).slice(0, 800)} ${String(stdout).slice(-400)}`)));
      if (!env.ok) return reject(new F2DError('E_WP_' + String(env.error).toUpperCase(), env.message || env.error));
      if (stderr && /fatal|error/i.test(stderr)) log.warn('wp stderr:', String(stderr).slice(0, 400));
      resolve(env.data);
    });
  });
}

export const status = (cfg) => wp(cfg, ['f2d', 'status']);

export async function importMedia(cfg, items, workDir) {
  if (!items.length) return {};
  const manifest = path.join(workDir, 'media-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify(items, null, 2));
  return wp(cfg, ['f2d', 'media', `--manifest=${manifest}`], { timeoutMs: 600000 });
}

export async function deploy(cfg, { pageKey, title, slug, contentFile, cssFile, fontsFile, buildId, status: st = 'draft', allowPublish = false }) {
  const args = ['f2d', 'deploy', `--key=${pageKey}`, `--title=${title}`, `--content-file=${contentFile}`, `--css-file=${cssFile}`, `--build-id=${buildId}`, `--status=${st}`];
  if (slug) args.push(`--slug=${slug}`);
  if (fontsFile) args.push(`--fonts-file=${fontsFile}`);
  if (allowPublish) args.push('--allow-publish');
  return wp(cfg, args);
}

export const readback = (cfg, { pageKey, id, contentOut }) => wp(cfg, ['f2d', 'readback', id ? `--id=${id}` : `--key=${pageKey}`, ...(contentOut ? [`--content-out=${contentOut}`] : [])]);
export const rollback = (cfg, { id, buildId }) => wp(cfg, ['f2d', 'rollback', `--id=${id}`, ...(buildId ? [`--build-id=${buildId}`] : [])]);
export const clearCache = (cfg, id) => wp(cfg, ['f2d', 'clear-cache', `--id=${id}`]);
export const previewUrl = (cfg, id) => wp(cfg, ['f2d', 'preview-url', `--id=${id}`]);
// Short-lived login cookies for the Visual Builder (bridge ≥ 0.3.1). Kept in memory only, never logged.
export const editorSession = (cfg, id, ttl = 900) => wp(cfg, ['f2d', 'editor-session', `--id=${id}`, `--ttl=${ttl}`]);
export async function setGlobalColors(cfg, colors, workDir) {
  const f = path.join(workDir, 'global-colors.json');
  fs.writeFileSync(f, JSON.stringify(colors));
  return wp(cfg, ['f2d', 'global-colors', `--colors=${f}`]);
}
