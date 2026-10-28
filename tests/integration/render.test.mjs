import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixturePage } from '../fixtures/make.mjs';
import { analysed, tree, tmpDir, pngFile } from '../helpers.mjs';
import { renderHtml } from '../../src/compile/html.mjs';
import { launch, scrollbarWidth, capture, release } from '../../src/qa/render.mjs';
import { responsiveScan } from '../../src/qa/checks.mjs';

let browser, sb, url, spec;
const dir = tmpDir('f2d-int-');

before(async () => {
  fs.mkdirSync(path.join(dir, 'assets'));
  const assets = { 'hero:fill': pngFile(path.join(dir, 'assets'), 'hero.png', 64, 64, [20, 20, 60]), 'photo:image': pngFile(path.join(dir, 'assets'), 'photo.png', 64, 64) };
  const ir = analysed(fixturePage(), assets);
  const t = tree(ir);
  const { html, css } = renderHtml(t);
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.writeFileSync(path.join(dir, 'style.css'), css);
  url = pathToFileURL(path.join(dir, 'index.html')).href;
  spec = {};
  const walk = (b) => {
    spec[b.cls] = { kind: b.kind, leaf: !b.children.length || b.kind === 'text' || b.tag === 'img', decor: false };
    b.children.forEach(walk);
  };
  walk(t.root);
  browser = await launch('classic');
  sb = await scrollbarWidth(browser);
});
after(async () => browser && (await browser.close()));

test('classic scrollbars are real and measured', () => {
  assert.ok(sb > 0, `Windows-mode scrollbar should take layout width (got ${sb})`);
});

test('fixture renders at design width with page width matched to the frame', async () => {
  const r = await capture(browser, url, { width: 1440, scrollbar: sb });
  assert.equal(r.metrics.clientWidth, 1440);
  assert.equal(r.metrics.scrollWidth, 1440, 'no horizontal overflow');
  assert.ok(r.geometry.length > 10);
  await release(r);
});

test('no horizontal overflow and no overlaps at 375px (inferred responsive rules)', async () => {
  const r = await capture(browser, url, { width: 375, match: 'window', scrollbar: sb });
  const rs = await r.page.evaluate(responsiveScan, spec);
  await release(r);
  assert.ok(rs.overflowX <= 1, `overflow ${rs.overflowX}px: ${JSON.stringify(rs.offenders)}`);
  assert.equal(rs.overlaps.length, 0, JSON.stringify(rs.overlaps));
});

test('overlap detector: catches a real overlap, ignores one hidden behind an opaque layer', async () => {
  const html = `<!doctype html><html><body style="margin:0">
    <div style="position:relative;height:200px">
      <p class="f2d-aaaaaaa1" style="margin:0;position:absolute;top:10px;left:10px;width:200px">Visible text A</p>
      <p class="f2d-aaaaaaa2" style="margin:0;position:absolute;top:12px;left:20px;width:200px">Visible text B</p>
    </div>
    <div style="position:relative;height:300px">
      <img class="f2d-bbbbbbb1" style="position:absolute;top:0;left:0;width:300px;height:250px;background:#888" alt="">
      <section style="position:relative;z-index:1;top:100px;height:200px;background:#000">
        <p class="f2d-bbbbbbb2" style="margin:0;color:#fff;width:200px">Text over an opaque band</p>
      </section>
    </div></body></html>`;
  const f = path.join(dir, 'overlap.html');
  fs.writeFileSync(f, html);
  const s = {
    'f2d-aaaaaaa1': { kind: 'text', leaf: true }, 'f2d-aaaaaaa2': { kind: 'text', leaf: true },
    'f2d-bbbbbbb1': { kind: 'image', leaf: true }, 'f2d-bbbbbbb2': { kind: 'text', leaf: true },
  };
  const r = await capture(browser, pathToFileURL(f).href, { width: 800, match: 'window', scrollbar: sb, collect: false });
  const rs = await r.page.evaluate(responsiveScan, s);
  await release(r);
  const pairs = rs.overlaps.map((o) => [o.a, o.b].sort().join('|'));
  assert.ok(pairs.includes('f2d-aaaaaaa1|f2d-aaaaaaa2'), `real overlap must be reported: ${JSON.stringify(rs.overlaps)}`);
  assert.ok(!pairs.includes('f2d-bbbbbbb1|f2d-bbbbbbb2'), 'an element covered by an opaque layer is not a visible overlap');
});

test('horizontal overflow from a 100vw element is detected under classic scrollbars', async () => {
  const f = path.join(dir, 'vw.html');
  fs.writeFileSync(f, '<!doctype html><html><body style="margin:0"><div style="height:2000px"></div><div class="f2d-ccccccc1" style="width:100vw;height:10px"></div></body></html>');
  const r = await capture(browser, pathToFileURL(f).href, { width: 1280, match: 'window', scrollbar: sb, collect: false });
  const rs = await r.page.evaluate(responsiveScan, { 'f2d-ccccccc1': { kind: 'shape', leaf: true } });
  await release(r);
  assert.equal(rs.overflowX, sb, 'a 100vw element overflows by exactly the scrollbar width');
});
