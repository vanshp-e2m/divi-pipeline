// Regressions for the tablet/phone failures found on homepage-v2 (see docs/PROGRESS.md, session 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureResponsive } from '../fixtures/make.mjs';
import { analysed, tree, findBox } from '../helpers.mjs';
import { responsivePlan } from '../../src/planner/responsive.mjs';
import { boxCss } from '../../src/layout/engine.mjs';
import { viewportMatrix } from '../../src/planner/plan.mjs';
import { compileDivi } from '../../src/compile/divi/v4.mjs';
import { node, row, col, text, doc, solid } from '../fixtures/make.mjs';
import { tmpDir, pngFile } from '../helpers.mjs';

const setup = (mut) => {
  const doc = fixtureResponsive();
  if (mut) mut(doc);
  const ir = analysed(doc, {});
  return { ir, t: tree(ir) };
};
const byName = (t, name) => findBox(t.root, (b) => b.name === name);
const pxOf = (v) => parseFloat(String(v).match(/(-?[\d.]+)px/)?.[1]);

test('nested full-width container: desktop padding becomes fluid gutters below desktop', () => {
  const { t } = setup();
  const inner = byName(t, 'Hero inner');
  assert.match(inner.css.base.padding, /max\(var\(--f2d-gutter/, 'content is centred with a fluid gutter on wide screens');
  for (const bp of ['tablet', 'phone']) {
    const sides = inner.css[bp].padding.split(' ').map(pxOf);
    assert.ok(sides[1] <= 32 && sides[3] <= 32, `${bp} side padding ${inner.css[bp].padding} must not keep the 240px desktop inset`);
  }
});

test('headings: explicit stepped sizes per ladder tier, stepping down, balanced lines', () => {
  const { t } = setup();
  const h = byName(t, 'Hero heading');
  // No clamp()/cqw/vw: a px size on each tier where it changes, never growing as the screen narrows.
  const steps = ['base', 'narrow', 'tabletExtra', 'tablet', 'mobileExtra', 'phone'].map((k) => h.css[k]?.['font-size']).filter(Boolean);
  for (const v of steps) assert.match(v, /^[\d.]+px$/);
  for (let i = 1; i < steps.length; i++) assert.ok(pxOf(steps[i]) < pxOf(steps[i - 1]), `steps down: ${steps.join(' → ')}`);
  assert.ok(steps.length >= 4 && pxOf(h.css.phone['font-size']) >= 20, `still a heading on phones: ${steps.join(' → ')}`);
  assert.match(h.css.phone['line-height'], /em$/, 'line height follows the stepped font size');
  assert.ok(Object.values(h.css).some((c) => c?.['text-wrap'] === 'balance'), 'headings balance their lines (no orphan words)');
});

test('timeline: two-up grid on tablet with connectors hidden; stack on phone with vertical connectors', () => {
  const { t } = setup();
  const rowB = byName(t, 'Timeline row');
  assert.equal(rowB.css.phone['flex-direction'], 'column');
  assert.ok(pxOf(rowB.css.tablet['row-gap']) >= 16, 'wrapped lines get a row gap');
  const step = byName(t, 'Step 1');
  assert.match(step.css.tablet.flex, /calc\(50%/);
  assert.equal(step.css.phone.flex, '0 0 auto', 'a grow basis meant for a row is reset when the row becomes a column');
  const con = byName(t, 'Connector 1');
  assert.equal(con.css.tablet.display, 'none');
  assert.match(con.css.phone.transform, /rotate\(90deg\)/);
});

test('rigid small items in a row keep their own square size (no height = width from the row)', () => {
  const { t } = setup();
  const icon = byName(t, 'Step 1 icon');
  assert.equal(icon.css.base.width, '100px');
  assert.equal(icon.css.base.height, '100px');
  const faqIcon = byName(t, 'FAQ icon');
  assert.equal(faqIcon.css.base.flex, '0 0 30px', 'a small control does not shrink next to a growing text');
  const q = byName(t, 'FAQ question');
  assert.equal(q.css.base['min-width'], '0');
  assert.equal(q.css.phone['white-space'], 'normal', 'a one-line desktop question may wrap on phone');
});

test('wrapped rows get breathing room even when the design gap is 0', () => {
  const { t } = setup((doc) => {
    const find = (n) => (n.name === 'Timeline row' ? n : n.children.map(find).find(Boolean));
    find(doc.frames[0].root).layout.gap = 0;
  });
  assert.equal(byName(t, 'Timeline row').css.tablet['row-gap'], '16px');
});

test('button rows wrap below desktop and buttons may take the full line on phone', () => {
  const { t } = setup();
  const btns = byName(t, 'Hero buttons');
  assert.equal(btns.css.phone['flex-wrap'], 'wrap');
  assert.match(byName(t, 'Btn A').css.phone.flex, /min\(276px, 100%\)/);
});

test('responsive plan: per-section strategy is read back from the compiled layout', () => {
  const { ir, t } = setup();
  const plan = responsivePlan(t, ir);
  assert.equal(plan.inferred, true, 'no tablet/phone frames: behaviour is inferred and says so');
  assert.equal(plan.sections.length, 7);
  assert.equal(plan.narrowAt, 1487);
  const stats = plan.sections.find((s) => s.name === 'Stats section').rows.find((x) => x.name === 'Stats row');
  assert.equal(stats.narrow, 'two-up grid');
  assert.equal(stats.mobileExtra, 'stack', 'rows stack from mobile-extra (≤880)');
  assert.deepEqual(plan.ladder.map((l) => l.tier), ['wide', 'base', 'narrow', 'tabletExtra', 'tablet', 'mobileExtra', 'phone']);
  const tl = plan.sections.find((s) => s.name === 'Timeline section');
  const r = tl.rows.find((x) => x.name === 'Timeline row');
  assert.equal(r.tablet, 'two-up grid');
  assert.equal(r.phone, 'stack');
  assert.equal(tl.connectors.length, 3);
  assert.deepEqual(tl.hidden.tablet.sort(), ['Connector 1', 'Connector 2', 'Connector 3']);
  const hero = plan.sections.find((s) => s.name === 'Hero section');
  assert.ok(hero.typography.some((x) => x.tag === 'h1' && x.balanced && Object.keys(x.steps).length >= 4));
  assert.ok(hero.buttons.length === 2);
});

// ---- narrow desktop (between the tablet breakpoint and the design's content width) ----

test('narrow tier: emitted between the content width and the tablet breakpoint, before the tablet rules', () => {
  const { t } = setup();
  assert.equal(t.root.narrowAt, 1440 + 48 - 1, 'the widest centred content (1440) plus minimum gutters');
  const css = boxCss(t.root);
  const order = [...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => +m[1]);
  assert.deepEqual(order, [...order].sort((a, b) => b - a), 'media blocks run widest first so narrower tiers win');
  assert.ok(order.includes(1487) && order.indexOf(1487) < order.indexOf(980));
});

test('narrow tier: links + call button wrap with tightened gaps instead of overlapping', () => {
  const { t } = setup();
  for (const name of ['Nav right', 'Nav links']) {
    const b = byName(t, name);
    assert.equal(b.css.narrow['flex-wrap'], 'wrap', name);
    assert.equal(b.css.narrow['min-width'], '0', `${name}: its desktop content minimum must not pin it wider than the header`);
  }
  assert.equal(byName(t, 'Nav links').css.narrow['column-gap'], '32px');
  // The bar's wrap is decided by width (from the design), not by content — so a late web font cannot
  // re-wrap it after first paint (layout shift). 124 logo + (1177 − 23 − 5×32) group + 32 + 100 padding.
  // Needed below 1250px: snapped up to the ladder tier covering that width (laptop), never a per-row breakpoint.
  assert.equal(byName(t, 'Nav section').css.at, undefined);
  assert.equal(byName(t, 'Nav section').css.narrow['flex-wrap'], 'wrap');
  assert.equal(byName(t, 'Nav section').css.narrow['row-gap'], '16px');
  assert.equal(byName(t, 'Nav right').css.narrow.flex, '1 1 100%');
});

test('narrow tier: a row of equal blocks becomes a two-up grid on the ladder tier covering its break', () => {
  const { t } = setup();
  const r = byName(t, 'Stats row');
  assert.equal(r.css.at, undefined, 'no per-row breakpoints');
  assert.equal(r.css.narrow['flex-wrap'], 'wrap');
  assert.equal(r.css.narrow['align-items'], 'stretch', 'equal card heights');
  assert.match(byName(t, 'Stat 4').css.narrow.flex, /calc\(50% - 32px\)/);
  assert.equal(r.css.narrow.height, 'auto', 'a fixed design height becomes a minimum on narrow desktops');
  assert.equal(r.css.narrow['min-height'], '150px');
});

test('narrow tier: free compositions keep proportions; start-anchored text ends before the next item', () => {
  const { t } = setup();
  const text = byName(t, 'Service text');
  assert.match(text.css.narrow.left, /%$/);
  assert.match(text.css.narrow.width, /%$/);
  const title = byName(t, 'Service title');
  assert.equal(title.css.narrow.left, undefined, 'stays beside the start-anchored number art');
  assert.match(title.css.narrow.width, /^min\(346px, max\([\d.]+px, calc\([\d.]+% - [\d.]+px\)\)\)$/, `capped before the next item, floored at the longest word: ${title.css.narrow.width}`);
  const floor = parseFloat(title.css.narrow.width.match(/max\(([\d.]+)px/)[1]);
  assert.ok(floor >= 'BRANDING'.length * 24 * 0.72, `word floor ${floor}px holds "BRANDING" at 24px`);
  assert.equal(title.css.narrow['white-space'], 'normal');
});

test('content minimum: a card that only clips its rounded corners is not shrinkable like a carousel', () => {
  const { t } = setup();
  const card = byName(t, 'Contact card');
  const basis = parseFloat(card.css.base.flex.split(' ')[2]);
  assert.ok(basis >= 640, `form card basis ${card.css.base.flex} must hold its two inputs`);
});

test('a frame rendered as one image gets no responsive padding (arrow buttons stay whole)', () => {
  const dir = tmpDir();
  const arrow = node('frame', 'Arrow', { x: 100, y: 50, w: 78, h: 78 }, { layout: row(0, [29, 29, 29, 29]), asset: 'arrow:image' });
  const sec = node('frame', 'Arrow section', { x: 0, y: 0, w: 1920, h: 200 }, { layout: row(20, [50, 100, 50, 100]), sizing: { w: 'fill', h: 'hug' }, children: [arrow, text('Arrow label', { x: 200, y: 80, w: 400, h: 20 }, 'Next slide', { sizing: { w: 'fill', h: 'hug' }, grow: 1 })] });
  const root = node('frame', 'Arrow page', { x: 0, y: 0, w: 1920, h: 200 }, { layout: col(0), sizing: { w: 'fixed', h: 'hug' }, children: [sec] });
  const ir = analysed(doc(root, { width: 1920 }), { 'arrow:image': pngFile(dir, 'arrow.png', 78, 78) });
  const b = findBox(tree(ir).root, (x) => x.name === 'Arrow');
  assert.equal(b.kind, 'image');
  assert.equal(b.css.tablet.padding, undefined);
  assert.equal(b.css.phone.padding, undefined);
});

test('divi: column CSS outranks Divi\'s structure-specific column widths (e.g. 1_4 → 50% on tablets)', () => {
  const { ir, t } = setup();
  const out = compileDivi(t, ir, {});
  const spec = (sel) => [(sel.match(/#/g) || []).length, (sel.match(/\./g) || []).length];
  const reset = out.css.match(/([^\n{}]*\.et_pb_row\.f2d-row[^{]*> \.et_pb_column[^{]*)\{ float: none/)[1];
  const [ids, classes] = spec(reset);
  assert.ok(ids === 1 && classes >= 7, `reset ${reset} must beat Divi's 1 id + 6 classes`);
  const col = out.css.match(/\n([^\n{}]*\.et_pb_column(\.f2d-[0-9a-f]{8}){5}) \{/);
  assert.ok(col, 'a box rendered as a Divi column gets a column-specific selector');
  assert.ok(spec(col[1])[1] > classes, 'and it outranks the reset');
  assert.match(out.css, /@media \(max-width: 1487px\)/, 'the narrow tier reaches the Divi stylesheet');
});

test('QA matrix: both sides of every breakpoint the build emits are tested', () => {
  const cfg = { viewports: { extra: [1440, 1024, 768, 390, 375], viewportHeight: 900 }, target: { os: 'windows' } };
  const ir = { frames: [{ id: 'f', width: 1920, viewport: 'desktop' }] };
  const m = viewportMatrix(cfg, ir, { breakpoints: [1487, 1208, 980, 767] });
  const widths = m.cells.map((c) => c.width);
  for (const w of [1487, 1488, 1208, 1209, 980, 981, 767, 768, 1920, 1440, 1024, 390, 375]) assert.ok(widths.includes(w), `missing ${w}`);
  assert.equal(new Set(widths).size, widths.length, 'no duplicate cells');
  assert.deepEqual(m.scrollbarModes, ['classic']);
});

test('QA matrix: the DEV Connect widths 3840 → 320 plus rotated views, each with its own height', async () => {
  const { DEFAULTS } = await import('../../src/config.mjs');
  const cfg = { viewports: DEFAULTS.viewports, target: { os: 'windows' } };
  const m = viewportMatrix(cfg, { frames: [{ id: 'f', width: 1920, viewport: 'desktop' }] });
  const widths = m.cells.filter((c) => !c.height).map((c) => c.width);
  for (const w of [3840, 2560, 2401, 2400, 2000, 1920, 1680, 1440, 1367, 1366, 1280, 1201, 1200, 1024, 981, 980, 960, 881, 880, 768, 767, 600, 480, 414, 390, 375, 360, 320]) assert.ok(widths.includes(w), `missing ${w}`);
  assert.deepEqual(m.cells.filter((c) => c.kind === 'landscape').map((c) => `${c.width}x${c.height}`).sort(), ['1024x768', '1180x820', '1366x1024', '844x390', '932x430']);
  assert.equal(m.cells.find((c) => c.width === 3840).kind, 'wide');
});

test('4K containment: above 1920 placed content keeps its offset from the centred column; sections never stretch', () => {
  const { t } = setup();
  assert.equal(t.root.wideAt, 1920);
  const css = boxCss(t.root);
  assert.match(css, /@media \(min-width: 1921px\)/);
  const wide = css.slice(css.indexOf('@media (min-width: 1921px)')).split('\n}')[0];
  for (const m of wide.matchAll(/calc\(50% - 960px \+ (-?[\d.]+)px\)/g)) assert.ok(Number.isFinite(+m[1]));
  // Fluid-gutter sections already centre their content column: no extra rule for them.
  const hero = byName(t, 'Hero section');
  assert.ok(!hero.css.wide.padding || !hero.css.base.padding?.includes('%'));
});

test('UX rules: every button gets hover/focus (derived when the design has none) and a 44×44 tap target on phones', () => {
  const { t } = setup();
  const buttons = [];
  const walk = (b) => (b.kind === 'button' && buttons.push(b), b.children.forEach(walk));
  walk(t.root);
  assert.ok(buttons.length >= 2);
  for (const b of buttons) {
    assert.ok(b.hover?.length, `${b.name} has a hover state`);
    assert.equal(b.css.phone['min-height'], '44px');
    assert.match(b.css.phone['min-width'], /^(44px|max-content)$/);
  }
  const derived = buttons.find((b) => b.derivedHover);
  if (derived) assert.match(derived.hover[0].css.filter, /^brightness\([\d.]+\)$/);
});

test('repairs: ladder tiers (and DEV Connect names) are valid breakpoints', async () => {
  const { validateEntry, normBp } = await import('../../src/repair/repairs.mjs');
  for (const bp of ['wide', 'base', 'narrow', 'tabletExtra', 'tablet', 'mobileExtra', 'phone', 'laptop', 'tablet_extra', 'mobile_extra', 'widescreen']) assert.deepEqual(validateEntry({ target: '*', op: 'css', bp, set: { gap: '8px' }, reason: 'evidence -> cause -> fix' }), [], bp);
  assert.equal(normBp('laptop'), 'narrow');
  assert.equal(normBp('mobile_extra'), 'mobileExtra');
  assert.ok(validateEntry({ target: '*', op: 'css', bp: 'tv', set: {}, reason: 'evidence -> cause -> fix' }).length);
});

test('web fonts load with display=block (a wider web font must not re-wrap rows after first paint)', async () => {
  const { resolveFonts } = await import('../../src/pipeline/analyze.mjs');
  const cfg = { fonts: { substitutions: { Designer: { substitute: 'Audiowide', css: 'https://fonts.googleapis.com/css2?family=Audiowide&display=swap' }, Other: { substitute: 'Inter', css: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700' } } } };
  const ir = { fonts: [{ family: 'Designer', runs: 3, missingInExport: true }, { family: 'Other', runs: 1, missingInExport: true }] };
  const f = resolveFonts(cfg, ir, {});
  assert.deepEqual(f.urls, ['https://fonts.googleapis.com/css2?family=Audiowide&display=block', 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=block']);
});

test('button labels may wrap inside their button below desktop (never clipped at both ends)', () => {
  const dir = tmpDir();
  const btn = node('frame', 'Wide button', { x: 240, y: 40, w: 351, h: 70 }, { layout: row(15, [10, 10, 10, 40], { align: 'center' }), sizing: { w: 'hug', h: 'hug' }, fills: [solid('#c3ac89')], children: [
    text('Wide button label', { x: 280, y: 68, w: 236, h: 14 }, 'View all services', { size: 20, textCase: 'upper', autoResize: 'width-height', sizing: { w: 'hug', h: 'hug' } }),
    node('frame', 'Wide button icon', { x: 531, y: 50, w: 50, h: 50 }, { fills: [solid('#ffffff')], radius: [8, 8, 8, 8] }),
  ] });
  const sec = node('frame', 'Button section', { x: 0, y: 0, w: 1920, h: 150 }, { layout: col(0, [40, 240, 40, 240]), sizing: { w: 'fill', h: 'hug' }, children: [btn] });
  const root = node('frame', 'Button page', { x: 0, y: 0, w: 1920, h: 150 }, { layout: col(0), sizing: { w: 'fixed', h: 'hug' }, children: [sec] });
  const t = tree(analysed(doc(root, { width: 1920 }), {}));
  const label = findBox(t.root, (x) => x.name === 'Wide button label');
  assert.equal(findBox(t.root, (x) => x.name === 'Wide button').kind, 'button');
  assert.equal(label.css.narrow.flex, '0 1 auto');
  for (const bp of ['tablet', 'phone']) assert.equal(label.css[bp].flex, '1 1 0', `${bp}: the label takes the room of a wider button (and can still shrink, so it wraps)`);
  for (const bp of ['narrow', 'tablet', 'phone']) assert.equal(label.css[bp]['min-width'], '0', bp);
  assert.equal(label.css.phone['white-space'], 'normal');
});
