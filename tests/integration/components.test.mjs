// Renders the components fixture (preview + the bridge's runtime) in Chromium with Windows scrollbars,
// operates the menu, accordion and slider like a visitor, and runs the responsive scan QA uses.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureComponents, COMPONENT_ASSETS } from '../fixtures/components.mjs';
import { analysed, tree, tmpDir, pngFile } from '../helpers.mjs';
import { renderHtml, RUNTIME_FILE } from '../../src/compile/html.mjs';
import { launch, scrollbarWidth, capture, release } from '../../src/qa/render.mjs';
import { responsiveScan, componentChecks, stickyScan, uxScan } from '../../src/qa/checks.mjs';
import { buildSpec } from '../../src/qa/suite.mjs';

let browser, sb, url, spec;
const dir = tmpDir('f2d-comp-');

before(async () => {
  fs.mkdirSync(path.join(dir, 'assets'));
  const assets = Object.fromEntries(Object.entries(COMPONENT_ASSETS).map(([k, [w, h]]) => [k, pngFile(path.join(dir, 'assets'), k.split(':')[0] + '.png', w, h, [90, 120, 160])]));
  const ir = analysed(fixtureComponents(), assets);
  const t = tree(ir);
  const { html, css } = renderHtml(t);
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.writeFileSync(path.join(dir, 'style.css'), css);
  fs.copyFileSync(RUNTIME_FILE, path.join(dir, 'f2d-runtime.js'));
  url = pathToFileURL(path.join(dir, 'index.html')).href;
  spec = buildSpec(ir, { root: t.root });
  browser = await launch('classic');
  sb = await scrollbarWidth(browser);
});
after(async () => browser && (await browser.close()));

for (const [width, match] of [[1920, 'page'], [1440, 'window'], [1100, 'window'], [1024, 'window'], [768, 'window'], [390, 'window'], [320, 'window']]) {
  test(`components at ${width}px: every component works, nothing overflows, is cut, covered or overlapping`, async () => {
    const r = await capture(browser, url, { width, match, scrollbar: sb, collect: false });
    const comps = await r.page.evaluate(componentChecks);
    const rs = await r.page.evaluate(responsiveScan, spec);
    await release(r);
    const kinds = comps.map((c) => c.c);
    for (const k of ['menu', 'accordion', 'slider', 'marquee']) assert.ok(kinds.includes(k), `${k} present: ${kinds}`);
    for (const c of comps) assert.ok(c.ok, `${c.c} at ${width}: ${JSON.stringify(c.detail)}`);
    assert.ok(rs.overflowX <= 1, `overflow ${rs.overflowX}px: ${JSON.stringify(rs.offenders)}`);
    for (const k of ['offscreen', 'brokenWords', 'squeezed', 'cut', 'covered', 'overlaps', 'spill']) assert.deepEqual(rs[k], [], `${k}: ${JSON.stringify(rs[k])}`);
  });
}

test('without the runtime every component shows the design\'s resting state', async () => {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace(/<script[^>]*>[^<]*<\/script>/g, '');
  fs.writeFileSync(path.join(dir, 'nojs.html'), html);
  const r = await capture(browser, pathToFileURL(path.join(dir, 'nojs.html')).href, { width: 390, match: 'window', scrollbar: sb, collect: false });
  const s = await r.page.evaluate(() => {
    const vis = (sel) => { const e = document.querySelector(sel); return !!e && e.getBoundingClientRect().height > 0; };
    return { links: vis('.f2d-menu-panel'), toggle: vis('.f2d-menu-toggle'), answer: vis('.f2d-acc-panel'), slides: [...document.querySelectorAll('.f2d-slide')].filter((e) => e.getBoundingClientRect().height > 0).length };
  });
  await release(r);
  assert.deepEqual(s, { links: true, toggle: false, answer: true, slides: 2 }, 'links visible, no dead menu button, answer open, both reviews shown');
});

for (const [width, height] of [[1920, 900], [1024, 768], [390, 844], [844, 390]]) {
  test(`sticky header at ${width}×${height}: pinned at 50% and the bottom, drawer opens from there and fits or scrolls`, async () => {
    const r = await capture(browser, url, { width, height, match: 'window', scrollbar: sb, collect: false });
    const s = await r.page.evaluate(stickyScan);
    const ux = await r.page.evaluate(uxScan, { spec, sections: [] });
    await release(r);
    for (const p of s.positions) assert.ok(Math.abs(p.top) <= 1 && p.visible && p.onTop, `pinned at ${p.at}: ${JSON.stringify(p)}`);
    if (s.compact) {
      assert.ok(s.height <= Math.max(0.22 * height, 72), `slim compact header: ${s.height}px of ${height}`);
      const d = s.drawer;
      assert.ok(d.opened && d.inView && (d.fits || d.scrollable) && d.reclosed, JSON.stringify(d));
    } else assert.ok(width > 1200, 'the menu collapses at the ladder tier (1200)');
    assert.deepEqual(ux.tap, [], `tap targets: ${JSON.stringify(ux.tap)}`);
    for (const k of ['distorted', 'zero', 'spill']) assert.deepEqual(ux[k], [], `${k}: ${JSON.stringify(ux[k])}`);
  });
}
