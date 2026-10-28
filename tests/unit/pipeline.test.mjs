import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixturePage } from '../fixtures/make.mjs';
import { analysed, tree, findBox, tmpDir, pngFile, bundleFrom } from '../helpers.mjs';
import { normalize } from '../../src/ir/normalize.mjs';
import { collectTokens } from '../../src/ir/tokens.mjs';
import { boxCss, lintCss, rgba } from '../../src/layout/engine.mjs';
import { renderHtml } from '../../src/compile/html.mjs';
import { compileDivi, columnStructure } from '../../src/compile/divi/v4.mjs';
import { parseShortcodes } from '../../src/pipeline/build.mjs';
import { validateEntry, addRepairs, applyCssRepairs, loadRepairs, revertRepair } from '../../src/repair/repairs.mjs';
import { capabilities } from '../../src/compile/divi/capabilities.mjs';
import { validatePlan } from '../../src/planner/plan.mjs';
import { compareImages, scoreFrom } from '../../src/qa/compare.mjs';
import { PNG } from 'pngjs';

const dir = tmpDir();
const assets = { 'hero:fill': pngFile(dir, 'hero.png'), 'photo:image': pngFile(dir, 'photo.png') };
const setup = () => {
  const ir = analysed(fixturePage(), assets);
  return { ir, t: tree(ir) };
};

test('normalize is deterministic', () => {
  const a = normalize(bundleFrom(fixturePage(), assets));
  const b = normalize(bundleFrom(fixturePage(), assets));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.schema, 'f2d-ir/1');
  const classes = new Set(Object.values(a.nodes).map((n) => n.cls));
  assert.equal(classes.size, Object.keys(a.nodes).length, 'class names must not collide');
});

test('analyze: sections, button, heading levels', () => {
  const { ir } = setup();
  const N = Object.values(ir.nodes);
  assert.equal(N.filter((n) => n.a.role === 'section').length, 5);
  assert.equal(N.find((n) => n.name === 'Hero CTA').a.role, 'button');
  assert.equal(N.find((n) => n.name === 'Hero title').a.tag, 'h1');
  assert.equal(N.find((n) => n.name === 'CTA label').a.tag, 'span', 'button labels are not headings');
  assert.equal(N.find((n) => n.name === 'Body').a.tag, 'p');
});

test('tokens: repeated colours are promoted, singletons stay literal', () => {
  const { ir } = setup();
  const t = collectTokens(ir);
  assert.ok(t.colors.find((c) => c.value === '#ffffff').id);
  const once = t.colors.find((c) => c.uses === 1);
  if (once) assert.equal(once.id, null);
});

test('layout: gradient angle from handles, space-between drops the reported gap', () => {
  const { t } = setup();
  const cta = findBox(t.root, (b) => b.name === 'CTA band');
  assert.match(cta.css.base.background, /linear-gradient\(90deg/);
  const nav = findBox(t.root, (b) => b.name === 'Nav');
  assert.equal(nav.css.base['justify-content'], 'space-between');
  assert.equal(nav.css.base.gap, undefined);
});

test('layout: one-line Figma text stays on one line; section gutters are fluid', () => {
  const { t } = setup();
  const label = findBox(t.root, (b) => b.name === 'CTA label');
  assert.equal(label.css.base['white-space'], 'nowrap');
  const hero = findBox(t.root, (b) => b.name === 'Hero');
  assert.match(hero.css.base.padding, /max\(var\(--f2d-gutter, 24px\), calc\(\(100% - 1200px\) \/ 2\)\)/);
});

test('layout: hover state becomes :hover and :focus-visible rules', () => {
  const { t } = setup();
  const css = boxCss(t.root);
  const btn = findBox(t.root, (b) => b.name === 'Hero CTA');
  assert.ok(btn.hover?.length, 'hover rules recorded');
  assert.ok(css.includes(`.${btn.cls}:hover`) && css.includes(`.${btn.cls}:focus-visible`));
  assert.ok(css.includes('background-color: #ffffff'));
});

test('layout: responsive rules — card row wraps on tablet, stacks on phone', () => {
  const { t } = setup();
  const cards = findBox(t.root, (b) => b.name === 'Cards');
  assert.equal(cards.css.tablet['flex-wrap'], 'wrap');
  assert.equal(cards.css.phone['flex-direction'], 'column');
});

test('layout: wide row children shrink proportionally to half size before wrapping', () => {
  const { t } = setup();
  const cards = findBox(t.root, (b) => b.name === 'Cards');
  assert.equal(cards.css.base['flex-wrap'], 'wrap');
  for (const c of cards.children) {
    // basis = half the design width (line breaks use the basis), grow proportional to design width
    assert.match(c.css.base.flex, /^192 1 192px$/); // grow = slack (384 - 192)
    assert.equal(c.css.base['min-width'], '0');
  }
});

test('layout: a row that may wrap never keeps a fixed height', () => {
  const doc = fixturePage();
  const cards = doc.frames[0].root.children.find((c) => c.name === 'Cards');
  cards.sizing = { ...cards.sizing, h: 'fixed' };
  const ir = analysed(doc, assets);
  const t = tree(ir);
  const row = findBox(t.root, (b) => b.name === 'Cards');
  assert.equal(row.css.base['flex-wrap'], 'wrap');
  assert.equal(row.css.base.height, undefined, 'wrapped lines must be able to grow the row');
  assert.ok(row.css.base['min-height']);
});

test('lint: vw widths are major on Windows, minor on macOS', () => {
  assert.equal(lintCss('.a { width: 100vw; }', { os: 'windows' })[0].severity, 'major');
  assert.equal(lintCss('.a { width: 100vw; }', { os: 'macos' })[0].severity, 'minor');
  assert.equal(lintCss('.a { font-size: 4vw; }', { os: 'windows' }).length, 0);
});

test('html preview contains every section and loads images eagerly above the fold', () => {
  const { t } = setup();
  const { html } = renderHtml(t);
  for (const n of ['Nav', 'Hero', 'Two column', 'Cards', 'CTA band']) assert.ok(html.includes(`data-f2d="${n}"`), n);
  assert.match(html, /<img [^>]*loading="eager"/);
});

test('divi: valid balanced shortcodes, one section per IR section, single-line bodies', () => {
  const { ir, t } = setup();
  const out = compileDivi(t, ir, { tokens: collectTokens(ir), buildId: 'b1' });
  const p = parseShortcodes(out.shortcodes);
  assert.ok(p.ok, p.errors.join(';'));
  assert.equal(p.counts.et_pb_section, 5);
  for (const line of out.shortcodes.split('\n')) assert.ok(line.startsWith('[et_pb_section'), 'module bodies must be one line (wpautop)');
  assert.ok(out.css.includes('--f2d-build: "b1"'), 'build marker for stale-CSS detection');
  const editorPosition = /^.*#et-fb-app [^{]*\{ position: [a-z]+ !important;.*$/gm;
  assert.ok(!/!important/.test(out.css.replace(/@media \(max-width: 479px\)[^\n]*/g, '').replace(editorPosition, '')), 'no !important outside the documented Divi column override and the builder-only position');
});

test('divi: Visual Builder parity rules are editor-only and restore the front-end values', () => {
  const { ir, t } = setup();
  const first = compileDivi(t, ir, {});
  const mod = first.manifest.modules.find((m) => m.module === 'et_pb_text' && !m.fragment);
  const box = findBox(t.root, (b) => b.id === mod.id);
  Object.assign(box.css.base, { position: 'absolute', top: '10px' });
  box.css.tablet.position = 'static';
  const css = compileDivi(t, ir, {}).css;
  const editor = css.slice(css.indexOf('/* Visual Builder parity'));
  for (const line of editor.split('\n').filter((l) => l.includes('{') && !l.startsWith('@media') && !l.startsWith('/*'))) {
    assert.match(line, /#et-fb-app|et-fb-preview--/, `editor-only rule: ${line.slice(0, 80)}`);
  }
  const sel = `#et-fb-app .${box.cls}.${box.cls}.${box.cls}`;
  assert.ok(editor.includes(`${sel} { position: absolute !important; top: 10px; left: auto; min-height: auto; }`), 'module position beats the builder\'s own !important; top/left/min-height restored');
  assert.match(editor, new RegExp(`@media \\(max-width: 980px\\) \\{[^}]*${sel.replace(/\./g, '\\.')} \\{ position: static !important; \\}`), 'per-tier position follows the box');
  assert.ok(editor.includes('.et_pb_text_inner > [data-shortcode-id] { display: contents; }'), 'builder wrapper is transparent');
  assert.ok(editor.includes('.et_pb_column.f2d-col::after { display: none; }'), 'collapsed-column marker is not a flex item');
  assert.ok(css.includes(':is(.f2d-frag-host, .et_pb_text.f2d-el) p:not([class]) { display: contents; }'), 'wpautop paragraphs are transparent on both sides');
});

test('divi: promoted colours become global colours with global_colors_info', () => {
  const { ir, t } = setup();
  const out = compileDivi(t, ir, { tokens: collectTokens(ir) });
  assert.ok(Object.keys(out.globalColors).every((k) => k.startsWith('gcid-f2d-')));
  if (/="gcid-f2d-/.test(out.shortcodes)) assert.match(out.shortcodes, /global_colors_info="\{%22gcid-f2d-/);
});

test('divi: attribute values are encoded (quotes, brackets)', () => {
  const { ir, t } = setup();
  const nav = findBox(t.root, (b) => b.name === 'Nav');
  nav.name = 'Nav "main" [x]';
  const out = compileDivi(t, ir, {});
  assert.ok(out.shortcodes.includes('Nav %22main%22 %91x%93'));
});

test('divi: column structures snap to the nearest preset', () => {
  assert.deepEqual(columnStructure([1, 1, 1]), ['1_3', '1_3', '1_3']);
  assert.deepEqual(columnStructure([2, 1]), ['2_3', '1_3']);
  assert.equal(columnStructure([1, 1, 1, 1, 1, 1, 1]), null);
});

test('repairs: validation rejects unsafe or unfounded repairs', () => {
  const { ir } = setup();
  const target = Object.keys(ir.nodes)[2];
  assert.ok(validateEntry({ target, op: 'css', set: { width: '100px !important' }, reason: 'because measured' }, { os: 'windows', ir }).length);
  assert.ok(validateEntry({ target, op: 'css', set: { width: '50vw' }, reason: 'because measured' }, { os: 'windows', ir }).length);
  assert.ok(validateEntry({ target: 'nope', op: 'css', set: { width: '1px' }, reason: 'because measured' }, { os: 'windows', ir }).length);
  assert.ok(validateEntry({ target, op: 'css', set: { width: '1px' }, reason: 'x' }, { os: 'windows', ir }).length, 'reason required');
  assert.equal(validateEntry({ target, op: 'css', set: { 'max-width': '100%' }, reason: 'overflow at 375 measured' }, { os: 'windows', ir }).length, 0);
});

test('repairs: dedup, apply to both compilers via the tree, revert', () => {
  const { ir, t } = setup();
  const f = path.join(tmpDir(), 'repairs.json');
  const body = Object.values(ir.nodes).find((n) => n.name === 'Body');
  const e = { target: body.id, op: 'css', bp: 'phone', set: { 'font-size': '16px' }, reason: 'measured overflow at 375' };
  assert.equal(addRepairs(f, [e], { os: 'windows', ir }).length, 1);
  assert.equal(addRepairs(f, [e], { os: 'windows', ir }).length, 0, 'same repair twice is a no-op');
  const doc = loadRepairs(f);
  applyCssRepairs(t, doc);
  assert.equal(findBox(t.root, (b) => b.id === body.id).css.phone['font-size'], '16px');
  revertRepair(f, doc.entries[0].id, 'test');
  const t2 = tree(ir);
  applyCssRepairs(t2, loadRepairs(f));
  assert.notEqual(findBox(t2.root, (b) => b.id === body.id).css.phone['font-size'], '16px');
});

test('planner: capability profile gates module mappings', () => {
  assert.equal(capabilities('4.27.7').id, 'divi-4.27');
  assert.equal(capabilities('5.0.0'), null);
  const plan = { target: { divi: '4.27.7' }, elementMap: [{ nodeId: 'x', module: 'et_pb_made_up' }], tasks: [{ id: 'T1', deps: ['T0'] }], sections: [{}], risks: [] };
  const v = validatePlan(plan);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /unverified module/.test(e)));
  assert.ok(v.errors.some((e) => /unknown T0/.test(e)));
});

test('visual metric: identical = 1, unrelated images score low, weights re-apply', () => {
  const a = new PNG({ width: 64, height: 64 });
  const b = new PNG({ width: 64, height: 64 });
  for (let i = 0; i < a.data.length; i += 4) {
    const x = (i / 4) % 64;
    a.data.set([x < 32 ? 0 : 255, 0, 0, 255], i);
    b.data.set([255, 255, 255, 255], i);
  }
  assert.equal(compareImages(a, a).score, 1);
  const m = compareImages(a, b);
  assert.ok(m.score < 0.6, `blank vs content scored ${m.score}`);
  assert.equal(scoreFrom({ ssim: 1, pixel: 1, edge: 1, color: 1, heightRatio: 0.5 }, { ssim: 0.3, pixel: 0.25, edge: 0.3, color: 0.15 }), 0.5);
});

test('rgba helper', () => {
  assert.equal(rgba('#C3AC89'), '#c3ac89');
  assert.equal(rgba('#ffffff', 0.1), 'rgba(255, 255, 255, 0.1)');
  assert.equal(rgba('rgba(0, 0, 0, 0.5)', 0.5), 'rgba(0, 0, 0, 0.25)');
});
