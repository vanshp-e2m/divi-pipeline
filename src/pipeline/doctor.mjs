// doctor: verify every external dependency the pipeline relies on, without changing anything.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import * as WP from '../wp/client.mjs';
import { capabilities } from '../compile/divi/capabilities.mjs';
import { figmaAuth } from '../ingest/figma-rest.mjs';

export async function doctor(cfg) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add('node >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node);
  add('target OS asked and set', !!cfg.target.os, cfg.target.os);
  try {
    const b = await chromium.launch({ channel: 'chromium' });
    add('chromium (playwright)', true, b.version());
    await b.close();
  } catch (e) {
    add('chromium (playwright)', false, e.message.split('\n')[0] + ' — run "npx playwright install chromium"');
  }
  try {
    const st = await WP.status(cfg);
    add('site reachable via WP-CLI', true, `${st.home} WP ${st.wp} (${st.environment})`);
    add('f2d-bridge active', true, st.bridge);
    // The site must run the bridge this pipeline ships (editor sessions, runtime, upload types).
    const shipped = (fs.readFileSync(new URL('../../wp-plugin/f2d-bridge/f2d-bridge.php', import.meta.url), 'utf8').match(/Version:\s*([\d.]+)/) || [])[1];
    add('f2d-bridge up to date', st.bridge === shipped, st.bridge === shipped ? st.bridge : `site has ${st.bridge}, pipeline ships ${shipped} — copy wp-plugin/f2d-bridge into wp-content/plugins/`);
    add('Divi active', !!st.divi_active, st.divi);
    const cap = capabilities(st.divi);
    add('Divi version has a verified capability profile', !!cap, cap ? `${cap.id} (verified with ${cap.verifiedWith})` : `no profile for ${st.divi}`);
    add('environment allows draft previews', !!st.preview, st.environment);
    add('publishing locked unless approved', !cfg.site.allowPublish, cfg.site.allowPublish ? 'allowPublish is ON' : 'drafts only');
  } catch (e) {
    add('site reachable via WP-CLI', false, e.message.slice(0, 300));
  }
  try {
    const res = await fetch(cfg.site.url, { method: 'HEAD' });
    add('site HTTP', res.ok, `${cfg.site.url} → ${res.status}`);
  } catch (e) {
    add('site HTTP', false, `${cfg.site.url}: ${e.message}`);
  }
  add('Figma REST token configured', !!figmaAuth(cfg), figmaAuth(cfg) ? 'present (not shown)' : 'absent — REST features disabled');
  for (const [slug, p] of Object.entries(cfg.pages)) add(`page ${slug} input exists`, fs.existsSync(path.resolve(cfg.projectDir, p.input)), p.input); // absolute (as f2d init stores it) or project-relative
  return { ok: checks.every((c) => c.ok || /Figma REST/.test(c.name)), checks };
}
