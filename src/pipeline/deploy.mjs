// Stage "deploy": upload used assets (dedup by content hash), resolve placeholders, write the draft
// page through the bridge, read it back and verify it byte-for-byte.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, readJsonIf, writeJson, writeText, F2DError, log } from '../util/core.mjs';
import * as WP from '../wp/client.mjs';
import { ws, loadState } from '../workspace.mjs';
import { pageConfig } from '../config.mjs';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function runDeploy(cfg, slug, buildId) {
  const w = ws(cfg, slug);
  const pc = pageConfig(cfg, slug);
  const dir = w.build(buildId);
  const manifest = readJson(path.join(dir, 'manifest.json'));
  if (!manifest.validation.ok) throw new F2DError('E_BUILD_INVALID', `Build ${buildId} failed validation: ${manifest.validation.errors.join('; ')}`);
  const assets = readJson(w.assets);
  const media = readJsonIf(w.media, {});

  // 1. media (only what this build uses; reuse anything already uploaded with the same hash)
  const need = manifest.divi.assets.filter((k) => !media[k] || media[k].sha !== assets[k].sha);
  if (need.length) {
    const items = need.map((k) => ({ key: k, file: assets[k].file, hash: assets[k].sha, name: `f2d-${assets[k].sha.slice(0, 12)}${path.extname(assets[k].file)}`, title: assets[k].nodeName || k }));
    const res = await WP.importMedia(cfg, items, dir);
    for (const [k, r] of Object.entries(res)) {
      if (r.error) throw new F2DError('E_MEDIA', `Upload failed for ${k}: ${r.error}`);
      media[k] = { id: r.id, url: r.url, sha: assets[k].sha, reused: r.reused };
    }
    writeJson(w.media, media);
  }
  // The user's font files (same dedup by content hash).
  const fontFiles = readJsonIf(path.join(dir, 'divi', 'font-files.json'), []);
  const needFonts = fontFiles.filter((f) => !media[f.key]);
  if (needFonts.length) {
    const res = await WP.importMedia(cfg, needFonts.map((f) => ({ key: f.key, file: f.file, hash: f.sha, name: `f2d-font-${f.sha.slice(0, 12)}${f.ext}`, title: `${f.family} (font)` })), dir);
    for (const [k, r] of Object.entries(res)) {
      if (r.error) throw new F2DError('E_MEDIA', `Font upload failed for ${k}: ${r.error}`);
      media[k] = { id: r.id, url: r.url, sha: k.slice(5), reused: r.reused };
    }
    writeJson(w.media, media);
  }

  // 2. resolve placeholders
  const resolve = (text) =>
    text.replace(/f2d-asset:\/\/([^"')\s\]]+)/g, (_, enc) => {
      const k = decodeURIComponent(enc);
      if (!media[k]) throw new F2DError('E_MEDIA', `No uploaded media for ${k}`);
      return media[k].url;
    }).replace(/f2d-font:\/\/([0-9a-f]+)\.\w+/g, (_, h) => {
      if (!media[`font:${h}`]) throw new F2DError('E_MEDIA', `No uploaded font file ${h}`);
      return media[`font:${h}`].url;
    });
  const content = resolve(fs.readFileSync(path.join(dir, 'divi', 'layout.txt'), 'utf8'));
  const css = resolve(fs.readFileSync(path.join(dir, 'divi', 'page.css'), 'utf8'));
  const contentFile = writeText(path.join(dir, 'divi', 'layout.resolved.txt'), content);
  const cssFile = writeText(path.join(dir, 'divi', 'page.resolved.css'), css);

  // 3. global colours (namespaced; merged, never replacing the site's own)
  const gc = readJsonIf(path.join(dir, 'divi', 'global-colors.json'), {});
  if (Object.keys(gc).length) await WP.setGlobalColors(cfg, gc, dir);

  // 4. deploy as draft unless publishing was explicitly approved in config
  const allowPublish = cfg.site.allowPublish === true && cfg.publish.status === 'publish';
  const res = await WP.deploy(cfg, {
    pageKey: `${slug}`,
    title: pc.title || slug,
    slug: pc.wpSlug || `f2d-${slug}`,
    contentFile,
    cssFile,
    fontsFile: path.join(dir, 'divi', 'fonts.json'),
    buildId,
    status: allowPublish ? 'publish' : 'draft',
    allowPublish,
  });

  // 5. readback verification
  const rb = await WP.readback(cfg, { id: res.post_id });
  const checks = {
    contentSha: rb.content_sha === sha256(content),
    cssSha: rb.css_sha === sha256(css),
    useBuilder: rb.use_builder === 'on',
    buildId: rb.build?.build_id === buildId,
    status: rb.status,
  };
  const ok = checks.contentSha && checks.cssSha && checks.useBuilder && checks.buildId;
  const deployRec = { buildId, at: new Date().toISOString(), postId: res.post_id, created: res.created, status: res.status, snapshots: res.snapshots, cache: res.cache, previewUrl: res.preview_url, permalink: res.permalink, divi: res.divi, uploaded: need.length, checks, ok };
  writeJson(path.join(dir, 'deploy.json'), { ...deployRec, previewUrl: res.preview_url ? '[stored in state.json]' : null });
  const st = loadState(w);
  st.post = { id: res.post_id, previewUrl: res.preview_url, permalink: res.permalink };
  st.deployed = st.deployed || [];
  st.deployed.push({ buildId, at: deployRec.at, ok });
  writeJson(w.state, st);
  if (!ok) throw new F2DError('E_READBACK', `Readback mismatch for build ${buildId}: ${JSON.stringify(checks)}`);
  log.info(`deployed ${buildId} -> post ${res.post_id} (${res.status}); uploaded ${need.length} assets`);
  return deployRec;
}

export async function runRollback(cfg, slug, buildId) {
  const w = ws(cfg, slug);
  const st = loadState(w);
  if (!st.post?.id) throw new F2DError('E_NO_POST', 'Nothing deployed for this page yet');
  // Prefer redeploying the stored build (exact artifacts); fall back to the WP snapshot.
  if (buildId && fs.existsSync(path.join(w.build(buildId), 'divi', 'layout.txt'))) return runDeploy(cfg, slug, buildId);
  return WP.rollback(cfg, { id: st.post.id, buildId });
}
