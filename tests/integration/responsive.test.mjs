// Renders the responsive regression fixture in Chromium with Windows (classic) scrollbars and runs the
// same responsiveScan QA uses: no overflow, broken words, squeezed text, cut content or dead gutters.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureResponsive } from '../fixtures/make.mjs';
import { analysed, tree, tmpDir } from '../helpers.mjs';
import { renderHtml } from '../../src/compile/html.mjs';
import { launch, scrollbarWidth, capture, release } from '../../src/qa/render.mjs';
import { responsiveScan } from '../../src/qa/checks.mjs';
import { buildSpec } from '../../src/qa/suite.mjs';

let browser, sb, url, spec;
const dir = tmpDir('f2d-resp-');

before(async () => {
  const ir = analysed(fixtureResponsive(), {});
  const t = tree(ir);
  const { html, css } = renderHtml(t);
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.writeFileSync(path.join(dir, 'style.css'), css);
  url = pathToFileURL(path.join(dir, 'index.html')).href;
  // The QA suite's own element spec (design overlaps, clipping, sections) — not a hand-made one.
  spec = buildSpec(ir, { root: t.root });
  browser = await launch('classic');
  sb = await scrollbarWidth(browser);
});
after(async () => browser && (await browser.close()));

for (const width of [375, 390, 430, 768, 1024, 1100, 1280, 1440]) {
  test(`fixture at ${width}px: no overflow, broken words, squeeze, cut content, overlaps or dead gutters`, async () => {
    const r = await capture(browser, url, { width, match: 'window', scrollbar: sb, collect: false });
    const rs = await r.page.evaluate(responsiveScan, spec);
    await release(r);
    assert.ok(rs.overflowX <= 1, `overflow ${rs.overflowX}px: ${JSON.stringify(rs.offenders)}`);
    for (const k of ['offscreen', 'brokenWords', 'squeezed', 'cut', 'gutters', 'overlaps', 'covered', 'spill']) assert.deepEqual(rs[k], [], `${k}: ${JSON.stringify(rs[k])}`);
  });
}

test('detectors: mid-word break, squeezed text, content cut by its container, dead gutters', async () => {
  const html = `<!doctype html><html><body style="margin:0;font:16px Arial">
    <section class="f2d-cccccc01" style="padding:0 30%">
      <h2 class="f2d-cccccc02" style="margin:0;width:120px;font-size:40px;overflow-wrap:anywhere">INSTALLATION</h2>
      <p class="f2d-cccccc03" style="margin:0;width:40px">A sentence that is squeezed into a sliver</p>
      <div style="height:20px;overflow:hidden"><p class="f2d-cccccc04" style="margin:0;line-height:30px;height:60px">Cut off by a fixed-height parent</p></div>
    </section></body></html>`;
  const f = path.join(dir, 'detectors.html');
  fs.writeFileSync(f, html);
  const s = { 'f2d-cccccc01': { kind: 'container', leaf: false, section: 'f2d-cccccc01' } };
  for (const c of ['f2d-cccccc02', 'f2d-cccccc03', 'f2d-cccccc04']) s[c] = { kind: 'text', leaf: true, section: 'f2d-cccccc01', designVisible: true, heading: c === 'f2d-cccccc02' };
  const r = await capture(browser, pathToFileURL(f).href, { width: 768, match: 'window', scrollbar: sb, collect: false });
  const rs = await r.page.evaluate(responsiveScan, s);
  await release(r);
  assert.ok(rs.brokenWords.some((x) => x.cls === 'f2d-cccccc02' && x.heading), JSON.stringify(rs.brokenWords));
  assert.ok(rs.squeezed.some((x) => x.cls === 'f2d-cccccc03'), JSON.stringify(rs.squeezed));
  assert.ok(rs.cut.some((x) => x.cls === 'f2d-cccccc04'), JSON.stringify(rs.cut));
  assert.ok(rs.gutters.some((x) => x.section === 'f2d-cccccc01'), JSON.stringify(rs.gutters));
});

test('detector: text hidden under a button is reported; a transparent hover layer is not', async () => {
  const html = `<!doctype html><html><body style="margin:0;font:16px Arial">
    <nav style="position:relative;height:60px;width:600px">
      <a class="f2d-dddddd01" style="position:absolute;left:380px;top:20px">Contact</a>
      <div class="f2d-dddddd02" style="position:absolute;left:360px;top:5px;width:220px;height:50px;background:#c3ac89"><span class="f2d-dddddd03">03 9873 7319</span></div>
    </nav>
    <div style="position:relative;height:100px;width:600px">
      <p class="f2d-dddddd04" style="margin:0;position:absolute;top:30px;left:10px">Vehicles</p>
      <img class="f2d-dddddd05" style="position:absolute;top:0;left:0;width:300px;height:100px;opacity:0;background:#888" alt="">
    </div></body></html>`;
  const f = path.join(dir, 'covered.html');
  fs.writeFileSync(f, html);
  const s = {
    'f2d-dddddd01': { kind: 'text', leaf: true }, 'f2d-dddddd02': { kind: 'button', leaf: false },
    'f2d-dddddd03': { kind: 'text', leaf: true, ancestors: ['f2d-dddddd02'] }, 'f2d-dddddd04': { kind: 'text', leaf: true }, 'f2d-dddddd05': { kind: 'image', leaf: true },
  };
  const r = await capture(browser, pathToFileURL(f).href, { width: 800, match: 'window', scrollbar: sb, collect: false });
  const rs = await r.page.evaluate(responsiveScan, s);
  await release(r);
  assert.ok(rs.covered.some((c) => c.cls === 'f2d-dddddd01' && c.by === 'f2d-dddddd02'), JSON.stringify(rs.covered));
  assert.ok(!rs.covered.some((c) => c.cls === 'f2d-dddddd04'), 'an opacity-0 reveal layer hides nothing');
  assert.ok(!rs.covered.some((c) => c.cls === 'f2d-dddddd03'), 'a button label is not covered by its own button');
});

test('detector: a label losing a few letters inside its clipping button counts as cut', async () => {
  const html = `<!doctype html><html><body style="margin:0;font:20px Arial">
    <a class="f2d-eeeeee01" style="display:flex;justify-content:center;width:150px;overflow:hidden;background:#c3ac89">
      <span class="f2d-eeeeee02" style="flex:0 0 auto;white-space:nowrap">VIEW ALL SERVICES</span></a></body></html>`;
  const f = path.join(dir, 'cutlabel.html');
  fs.writeFileSync(f, html);
  const s = { 'f2d-eeeeee01': { kind: 'button', leaf: false }, 'f2d-eeeeee02': { kind: 'text', leaf: true, designVisible: true } };
  const r = await capture(browser, pathToFileURL(f).href, { width: 800, match: 'window', scrollbar: sb, collect: false });
  const rs = await r.page.evaluate(responsiveScan, s);
  await release(r);
  const c = rs.cut.find((x) => x.cls === 'f2d-eeeeee02');
  assert.ok(c && c.hiddenPx > 4, JSON.stringify(rs.cut));
});
