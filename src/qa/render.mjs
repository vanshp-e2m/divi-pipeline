// Browser rendering: real Chromium, target-OS scrollbar mode, measured viewport, stable capture.
import { chromium } from 'playwright';
import { round } from '../util/core.mjs';

export async function launch(mode = 'classic') {
  // Full Chromium in new-headless mode. Playwright adds --hide-scrollbars by default; Windows
  // targets need real (classic) scrollbars because they take layout width.
  return chromium.launch({ channel: 'chromium', ignoreDefaultArgs: mode === 'classic' ? ['--hide-scrollbars'] : [] });
}

// Measure the scrollbar width once per browser (it differs by machine; never assume 17px).
export async function scrollbarWidth(browser) {
  const p = await browser.newPage({ viewport: { width: 800, height: 400 } });
  await p.setContent('<body style="margin:0"><div style="height:3000px"></div></body>');
  const sb = await p.evaluate(() => innerWidth - document.documentElement.clientWidth);
  await p.close();
  return sb;
}

const GEOMETRY_JS = () => {
  const out = [];
  for (const el of document.querySelectorAll('[class*="f2d-"]')) {
    const cls = [...el.classList].find((c) => /^f2d-[0-9a-f]{8}$/.test(c));
    if (!cls) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    out.push({
      cls,
      tag: el.tagName.toLowerCase(),
      x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height,
      visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
      font: { family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, lineHeight: cs.lineHeight, style: cs.fontStyle },
      color: cs.color, bg: cs.backgroundColor, opacity: cs.opacity, position: cs.position, overflow: cs.overflow,
      clipped: el.scrollHeight > el.clientHeight + 2 && /hidden|clip/.test(cs.overflow + cs.overflowY) && el.children.length === 0,
      text: el.children.length === 0 ? (el.textContent || '').trim().slice(0, 120) : null,
      img: el.tagName === 'IMG' ? { complete: el.complete, natural: el.naturalWidth } : null,
    });
  }
  // One entry per class: deliberate copies (an accordion's closed-state icon, a ticker's loop) share
  // the class of what they copy; the element a visitor sees is the one measured.
  const best = new Map();
  for (const g of out) if (!best.has(g.cls) || (!best.get(g.cls).visible && g.visible)) best.set(g.cls, g);
  return [...best.values()];
};

export async function settle(page, { assetTimeoutMs = 15000, settleMs = 600 } = {}) {
  const t0 = Date.now();
  const problems = [];
  await page.waitForLoadState('load', { timeout: assetTimeoutMs }).catch(() => problems.push('load event timeout'));
  // Scroll through like a user (half a viewport at a time) so lazy images get requested.
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight / 2) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  const fontsOk = await page.evaluate((t) => Promise.race([document.fonts.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), t))]), assetTimeoutMs);
  if (!fontsOk) problems.push('fonts not ready before timeout');
  const imgs = await page.evaluate((t) => Promise.race([
    // Lazy images that never intersected are not awaited (they are reported by QA instead).
    // Lazy images a user can scroll to (horizontally inside the viewport) are part of the settled page:
    // load and await them, or the screenshot races their decoding. Lazy images in horizontally
    // clipped strips stay lazy — if they never load, the structure check reports them.
    Promise.all([...document.images].filter((im) => {
      if (im.complete) return false;
      if (im.loading !== 'lazy') return true;
      const r = im.getBoundingClientRect();
      if (r.right > 0 && r.left < innerWidth && r.width > 0) { im.loading = 'eager'; return true; }
      return false;
    }).map((im) => (im.complete ? 1 : new Promise((r) => { im.addEventListener('load', r, { once: true }); im.addEventListener('error', r, { once: true }); })))).then(() => Promise.all([...document.images].filter((im) => im.complete && im.naturalWidth).map((im) => im.decode().catch(() => null)))).then(() => true),
    new Promise((r) => setTimeout(() => r(false), t)),
  ]), assetTimeoutMs);
  if (!imgs) {
    const pending = await page.evaluate(() => [...document.images].filter((im) => !im.complete).map((im) => `${im.loading}:${im.currentSrc.split('/').pop()}`).slice(0, 8));
    problems.push(`images not loaded before timeout: ${pending.join(', ')}`);
  }
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(settleMs);
  return { ms: Date.now() - t0, problems };
}

// Render one URL at a page width. `match: 'page'` widens the window by the scrollbar so the
// document's layout width equals `width` (for pixel comparison against a Figma frame);
// `match: 'window'` uses the real window width (what a user with that screen sees).
export async function capture(browser, url, { width, height = 900, match = 'page', scrollbar = 0, screenshot = null, fullPage = true, routes = null, collect = true, settleOpts = {} } = {}) {
  const winW = match === 'page' ? width + scrollbar : width;
  const ctx = await browser.newContext({ viewport: { width: winW, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const consoleMsgs = [], failed = [], shifts = [];
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 300) }));
  page.on('pageerror', (e) => consoleMsgs.push({ type: 'pageerror', text: String(e.message).slice(0, 300) }));
  // ERR_ABORTED = cancelled by the browser itself (e.g. a srcset candidate replaced after a resize):
  // not a broken asset. Missing files arrive as error responses, not here.
  page.on('requestfailed', (r) => r.failure()?.errorText !== 'net::ERR_ABORTED' && failed.push({ url: r.url().slice(0, 200), error: r.failure()?.errorText }));
  page.on('response', (r) => r.status() >= 400 && failed.push({ url: r.url().slice(0, 200), status: r.status() }));
  if (routes) await routes(page);
  await page.addInitScript(() => {
    window.__f2dShifts = 0;
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__f2dShifts += e.value; }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
  });
  let navError = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    navError = String(e.message).slice(0, 300);
  }
  const st = navError ? { ms: 0, problems: ['navigation failed'] } : await settle(page, settleOpts);
  const metrics = navError ? null : await page.evaluate(() => ({
    innerWidth, innerHeight,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    docHeight: document.documentElement.scrollHeight,
    cls: window.__f2dShifts,
    fonts: [...document.fonts].map((f) => ({ family: f.family, status: f.status, weight: f.weight, style: f.style })),
    bodyClasses: document.body.className,
  }));
  const geometry = navError || !collect ? [] : await page.evaluate(GEOMETRY_JS);
  if (screenshot && !navError) {
    // Chromium repeats content in single full-page captures beyond ~16k px: capture tall pages in
    // segments and stitch them.
    const H = metrics?.docHeight || 0;
    if (!fullPage || H <= 15000) await page.screenshot({ path: screenshot, fullPage, animations: 'disabled', caret: 'hide' });
    else await stitchedScreenshot(page, screenshot, H, metrics.clientWidth);
    // A full-page capture temporarily makes the viewport as tall as the page, so the classic scrollbar
    // disappears and may not come back: every later check would then run 15px wider than the cell.
    // Restore the viewport and verify the page width before anything else is measured.
    const settle2 = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.setViewportSize({ width: winW, height });
    await settle2();
    if (metrics && (await page.evaluate(() => document.documentElement.clientWidth)) !== metrics.clientWidth) {
      await page.setViewportSize({ width: winW + 1, height });
      await page.setViewportSize({ width: winW, height });
      await settle2();
    }
  }
  const result = { url, width, window: winW, match, metrics, geometry, console: consoleMsgs, failed, settle: st, navError, page, ctx };
  return result;
}

async function stitchedScreenshot(page, file, H, W) {
  const { PNG } = await import('pngjs');
  const fs = await import('node:fs');
  const out = new PNG({ width: W, height: H });
  const vp = page.viewportSize();
  const SEG = 4000;
  // Viewport-height segments: scroll, shoot the viewport, drop the scrollbar column (crop to W).
  // A sticky header would be drawn into every segment: it is shot in its place in the flow.
  await page.evaluate(() => { for (const e of document.querySelectorAll('body *')) if (getComputedStyle(e).position === 'sticky') (e.dataset.f2dSticky = e.style.position || '-'), (e.style.position = 'relative'); });
  await page.setViewportSize({ width: vp.width, height: SEG });
  for (let y = 0; y < H; y += SEG) {
    const top = Math.min(y, Math.max(0, H - SEG));
    await page.evaluate((t) => window.scrollTo(0, t), top);
    await page.waitForTimeout(150);
    const seg = PNG.sync.read(await page.screenshot({ animations: 'disabled', caret: 'hide' }));
    const skip = y - top;
    for (let r = skip; r < Math.min(seg.height, H - top); r++) seg.data.copy(out.data, (top + r) * W * 4, r * seg.width * 4, (r * seg.width + Math.min(W, seg.width)) * 4);
  }
  await page.setViewportSize(vp);
  await page.evaluate(() => { for (const e of document.querySelectorAll('[data-f2d-sticky]')) (e.style.position = e.dataset.f2dSticky === '-' ? '' : e.dataset.f2dSticky), delete e.dataset.f2dSticky; window.scrollTo(0, 0); });
  fs.writeFileSync(file, PNG.sync.write(out));
}

export async function release(r) {
  await r.ctx.close().catch(() => {});
  delete r.page;
  delete r.ctx;
  return r;
}

export const overflowX = (m) => (m ? round(m.scrollWidth - m.clientWidth, 1) : null);
