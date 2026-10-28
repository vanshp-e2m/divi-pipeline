// Regressions for the homepage build (2026-10-23): interactive components (menu, accordion, slider,
// ticker), layered rows with negative spacing, overhanging frames, card strips, full-bleed widths,
// asymmetric padding with side art, and the Divi margin reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureComponents, COMPONENT_ASSETS } from '../fixtures/components.mjs';
import { analysed, tree, findBox, tmpDir, pngFile } from '../helpers.mjs';
import { runtimeCss, boxCss } from '../../src/layout/engine.mjs';
import { compileDivi } from '../../src/compile/divi/v4.mjs';

const dir = tmpDir();
const assets = Object.fromEntries(Object.entries(COMPONENT_ASSETS).map(([k, [w, h]]) => [k, pngFile(dir, k.split(':')[0] + '.png', w, h)]));
const setup = () => {
  const ir = analysed(fixtureComponents(), assets);
  return { ir, t: tree(ir) };
};
const by = (t, name) => findBox(t.root, (b) => b.name === name);
const node = (ir, name) => Object.values(ir.nodes).find((n) => n.name === name);

test('detection by structure, not layer names: menu bar, accordion, slider, ticker, card strip', () => {
  const { ir } = setup();
  assert.equal(node(ir, 'Bar').a.menuPanel, true, 'the bar holding the links and the call-to-action collapses');
  assert.equal(node(ir, 'Links').a.navLinks, true);
  assert.equal(node(ir, 'Info').a.navLinks, undefined, 'the contact strip is not the nav');
  assert.equal(node(ir, 'FAQ list').a.widget, 'accordion');
  assert.equal(node(ir, 'Q1').a.accItem, 'open');
  assert.equal(node(ir, 'Q2').a.accItem, 'closed');
  assert.equal(node(ir, 'Reviews').a.widget, 'slider');
  assert.equal(node(ir, 'Prev').a.sliderControl, 'prev');
  assert.equal(node(ir, 'Next').a.sliderControl, 'next');
  assert.equal(node(ir, 'Ticker').a.widget, 'marquee');
  assert.equal(node(ir, 'Strip').a.strip, true);
  assert.equal(node(ir, 'About text').a.widget, undefined);
});

test('menu: button inserted before the bar, compact header at a breakpoint computed from the header', () => {
  const { t } = setup();
  const overlay = by(t, 'Menu');
  const i = overlay.children.findIndex((c) => c.hooks?.includes('f2d-menu-toggle'));
  assert.ok(i >= 0 && overlay.children[i + 1].name === 'Bar', 'toggle sits right before the panel (tab order)');
  assert.equal(t.root.menuNeed, 1110, 'contact strip (850) + logo reserve (212) + gutters (48)');
  assert.equal(t.root.menuAt, 1200, '…snapped to the ladder tier covering it (tablet-extra)');
  const toggle = overlay.children[i];
  assert.equal(toggle.css.base.display, 'none');
  assert.equal(toggle.css.tabletExtra.display, 'flex');
  assert.equal(toggle.css.tabletExtra['background-color'], '#000000', 'the button wears the bar colours');
  assert.equal(overlay.css.tabletExtra.position, 'relative', 'the overlay header becomes the top row');
  assert.equal(by(t, 'Logo').css.tabletExtra.width, '64px', 'the logo is sized by height: a slim bar');
  assert.equal(by(t, 'Logo').css.phone.width, '56px');
  assert.match(runtimeCss('', t.root.menuAt), /@media \(max-width: 1200px\) \{\n {2}html\.f2d-js \.f2d-menu-panel\.f2d-menu-panel \{ display: none; \}/);
});

test('sticky header: pinned at every width; slim when compact, its other bars join the drawer', () => {
  const { t } = setup();
  const h = by(t, 'Header section');
  assert.equal(h.css.base.position, 'sticky');
  assert.equal(h.css.base.top, 'var(--wp-admin--admin-bar--height, 0px)');
  assert.ok(h.hooks.includes('f2d-header'));
  assert.ok(by(t, 'Info').hooks.includes('f2d-menu-extra'), 'the contact strip moves into the drawer');
  assert.equal(h.css.tabletExtra['min-height'], '0');
  const css = runtimeCss('', t.root.menuAt);
  assert.match(css, /html\.f2d-js:not\(\.f2d-menu-open\) \.f2d-menu-extra\.f2d-menu-extra \{ display: none; \}/);
  assert.match(css, /html\.f2d-menu-open \.f2d-header\.f2d-header \{ max-height: calc\(100vh[^}]*overflow-y: auto/);
  assert.equal(t.root.css.base.overflow, undefined, 'no scroll container above the sticky header');
});

test('a header nested at the top of the hero is promoted to its own sticky section', () => {
  const W = 1920;
  const hdr = mk('frame', 'Top', { x: 0, y: 0, w: W, h: 100 }, { layout: mrow(32, [20, 240, 20, 240]), sizing: { w: 'fill', h: 'hug' }, fills: [msolid('#ffffff')], children: [
    mk('frame', 'Links', { x: 600, y: 30, w: 600, h: 40 }, { layout: mrow(32), sizing: { w: 'hug', h: 'hug' }, children: ['Home', 'About', 'Work', 'Contact'].map((l, k) => mtext(l, { x: 600 + k * 150, y: 30, w: 100, h: 40 }, l, { size: 16 })) }),
    mk('frame', 'CTA', { x: 1500, y: 30, w: 180, h: 40 }, { layout: mrow(0), sizing: { w: 'hug', h: 'hug' }, fills: [msolid('#ff5a00')], children: [mtext('CTA label', { x: 1510, y: 40, w: 160, h: 20 }, 'Get a quote', { size: 16 })] }),
  ] });
  const body = mtext('Hero title', { x: 240, y: 300, w: 800, h: 80 }, 'A big hero title here', { size: 64 });
  const hero = mk('frame', 'Hero', { x: 0, y: 0, w: W, h: 700 }, { layout: mcol(0), sizing: { w: 'fill', h: 'fixed' }, children: [hdr, mk('frame', 'Hero body', { x: 0, y: 100, w: W, h: 600 }, { layout: mcol(0, [200, 240, 0, 240]), sizing: { w: 'fill', h: 'fill' }, children: [body] })] });
  const d = mdoc(mk('frame', 'Page', { x: 0, y: 0, w: W, h: 700 }, { layout: mcol(0), sizing: { w: 'fixed', h: 'hug' }, children: [hero] }), { width: W });
  const { ir, t } = build(d);
  const secs = Object.values(ir.nodes).filter((n) => n.a.role === 'section').sort((a, b) => a.a.sectionIndex - b.a.sectionIndex);
  assert.deepEqual(secs.map((s) => s.name), ['Top', 'Hero']);
  assert.equal(secs[0].a.header, true);
  assert.deepEqual([secs[1].box.y, secs[1].box.h], [100, 600], 'the hero keeps the rest, starting where the header ended');
  assert.equal(t.root.children[0].css.base.position, 'sticky');
  assert.equal(compileDivi(t, ir, {}).shortcodes.match(/\[et_pb_section /g).length, 2);
});

test('accordion: design state in the markup, closed look derived from a closed item, icon swap', () => {
  const { t } = setup();
  const q1 = by(t, 'Q1');
  assert.ok(q1.hooks.includes('is-open') && q1.hooks.includes('f2d-acc-item'));
  assert.ok(by(t, 'Q1 answer').hooks.includes('f2d-acc-panel'));
  const closed = q1.rules.find((r) => r.state === ':not(.is-open)' && !r.ancestor);
  assert.equal(closed.css['background-color'], '#ffffff', 'closed = the closed items\' background');
  const textRule = by(t, 'Q1 text').rules.find((r) => r.ancestor === q1);
  assert.equal(textRule.css.color, '#0b1220');
  const head = by(t, 'Q1 head');
  assert.ok(head.children.some((c) => c.hooks?.includes('f2d-acc-icon-closed') && c.ariaHidden), 'closed-state icon copied in, hidden from AT');
  assert.ok(by(t, 'Q1 icon').hooks.includes('f2d-acc-icon-open'));
  const css = boxCss(t.root);
  assert.match(css, /html\.f2d-js \.[\w-]+:not\(\.is-open\) \{ background-color: #ffffff; \}/);
});

test('slider: first slide active in markup, arrows under the active card below desktop', () => {
  const { t } = setup();
  assert.ok(by(t, 'Review 1').hooks.includes('is-active'));
  assert.ok(!by(t, 'Review 2').hooks.includes('is-active'));
  const prev = by(t, 'Prev');
  assert.ok(prev.hooks.includes('f2d-slider-prev'));
  assert.equal(prev.css.tablet.bottom, '0');
  assert.equal(by(t, 'Reviews').css.tablet['padding-bottom'], '94px');
  assert.match(runtimeCss(''), /@media \(max-width: 980px\) \{ html\.f2d-js \.f2d-slider \.f2d-slide\.f2d-slide:not\(\.is-active\) \{ display: none; \} \}/);
});

test('ticker and card strip: items keep their size; the strip scrolls at every width', () => {
  const { t } = setup();
  const ticker = by(t, 'Ticker');
  assert.ok(ticker.hooks.includes('f2d-marquee'));
  assert.equal(ticker.css.base.display, 'flex', 'every phrase is in the row, including those past the clip');
  assert.equal(ticker.children.length, 6);
  assert.ok(ticker.children.every((c) => c.css.base['flex-shrink'] === '0'));
  const strip = by(t, 'Strip');
  assert.equal(strip.css.base['overflow-x'], 'auto');
  assert.equal(strip.css.base['flex-wrap'], undefined, 'never a wrapped grid');
  assert.equal(by(t, 'Card 4').css.base['flex-shrink'], '0');
  assert.equal(by(t, 'Card 4').css.phone.flex, '0 0 min(415px, 85%)');
});

test('layered row: negative spacing as margins; tablet = content full width + colour band with the badge', () => {
  const { t } = setup();
  assert.equal(by(t, 'Photo').css.base['margin-left'], '-487px');
  assert.equal(by(t, 'Image').css.base.gap, undefined, 'no invalid negative gap');
  assert.equal(by(t, 'Image').css.base.height, '600px', 'its panel overhangs on purpose: a real height, not a minimum');
  assert.equal(by(t, 'Image').css.tablet['flex-direction'], 'column');
  assert.equal(by(t, 'Panel').css.tablet.display, 'none', 'the badge carries the panel colour instead');
  const rating = by(t, 'Rating').css.phone;
  assert.deepEqual([rating.position, rating['background-color'], rating.order, rating.width], ['relative', '#ff5a00', '2', '100%'], 'in flow, so the band grows when its text wraps');
});

test('full-bleed frames are the page width; asymmetric padding and side art scale with the content column', () => {
  const { t } = setup();
  const box = by(t, 'Banner box');
  assert.equal(box.css.base.width, '100%', 'never a fixed 1920px box');
  assert.match(box.css.base.padding, /^0px calc\(max\(var\(--f2d-gutter, 24px\), calc\(\(100% - 1440px\) \/ 2\)\) \+ min\(1440px, 100% - 48px\) \* 0\.3889\) 0px max\(var\(--f2d-gutter, 24px\), calc\(\(100% - 1440px\) \/ 2\)\)$/);
  const art = by(t, 'Side art');
  assert.match(art.css.narrow.right, /^calc\(max\(.*\) \+ 13px\)$/);
  assert.equal(art.css.narrow.left, 'auto');
  assert.equal(art.css.tablet.position, 'relative', 'below desktop the art joins the flow under the content');
  assert.equal(art.css.tablet.order, '99');
});

test('divi: the module margin reset only cancels Divi\'s default bottom margin', () => {
  const { ir, t } = setup();
  const out = compileDivi(t, ir, {});
  assert.match(out.css, /\.et_pb_column \.et_pb_module\.f2d-el, [^{]+\{ margin-bottom: 0; \}/);
  assert.ok(!/\.et_pb_column \.et_pb_module\.f2d-el, [^{]+\{ margin: 0; \}/.test(out.css));
  assert.match(out.shortcodes, /f2d-menu-toggle/, 'the menu button reaches the Divi layout');
  assert.match(out.css, /@media \(max-width: 1200px\)/);
});

// ---- rules added after the repairer's pass-1 findings (they replaced 37 page-level repairs)
import { node as mk, row as mrow, col as mcol, text as mtext, doc as mdoc, solid as msolid } from '../fixtures/make.mjs';
const page = (children, h = 600) => mdoc(mk('frame', 'Page', { x: 0, y: 0, w: 1920, h }, { layout: mcol(0), sizing: { w: 'fixed', h: 'hug' }, children: [mk('frame', 'Sec', { x: 0, y: 0, w: 1920, h }, { layout: mcol(20, [40, 240, 40, 240]), sizing: { w: 'fill', h: 'hug' }, children })] }), { width: 1920 });
const build = (d) => { const ir = analysed(d, {}); return { ir, t: tree(ir) }; };

test('a row whose children sit on several lines becomes a wrapping row with measured gaps', () => {
  const kids = [0, 1, 2, 3, 4, 5].map((i) => mk('frame', `City ${i}`, { x: 240 + (i % 3) * 365, y: 40 + Math.floor(i / 3) * 98, w: 326, h: 78 }, { layout: mrow(10, [20, 20, 20, 20]), sizing: { w: 'fill', h: 'fill' }, grow: 1, fills: [msolid('#ffffff')], children: [mtext(`City ${i} t`, { x: 260 + (i % 3) * 365, y: 70 + Math.floor(i / 3) * 98, w: 100, h: 18 }, 'Cleveland', { autoResize: 'width-height', sizing: { w: 'hug', h: 'hug' } })] }));
  const { ir, t } = build(page([mk('frame', 'Cities', { x: 240, y: 40, w: 1421, h: 176 }, { layout: mrow(10), sizing: { w: 'fixed', h: 'hug' }, children: kids })]));
  const L = node(ir, 'Cities').layout;
  assert.deepEqual([L.wrap, L.gap, L.counterGap], [true, 39, 20]);
  assert.equal(by(t, 'City 0').css.base.flex.startsWith('1'), false, 'wrap items keep their width instead of growing onto one line');
});

test('small overlapping items (an avatar stack) stay a row; only large layered items get the band treatment', () => {
  const av = [0, 1, 2, 3].map((i) => mk('rect', `Avatar ${i}`, { x: 240 + i * 50, y: 40, w: 61, h: 61 }, { fills: [msolid('#cccccc')], radius: [30, 30, 30, 30] }));
  const { t } = build(page([mk('frame', 'Avatars', { x: 240, y: 40, w: 211, h: 61 }, { layout: mrow(-11), sizing: { w: 'hug', h: 'hug' }, children: av })]));
  assert.notEqual(by(t, 'Avatars').css.tablet['flex-direction'], 'column');
  assert.equal(by(t, 'Avatar 1').css.base['margin-left'], '-11px');
});

test('text filling a symmetrically padded card is not "centred" below desktop', () => {
  const card = mk('frame', 'Card', { x: 240, y: 40, w: 708, h: 200 }, { layout: mcol(20, [31, 31, 31, 31]), sizing: { w: 'fixed', h: 'hug' }, children: [mtext('Answer', { x: 271, y: 71, w: 646, h: 54 }, 'A long answer that fills the padded card from edge to edge.', { lines: 2, sizing: { w: 'fill', h: 'hug' } })] });
  const { t } = build(page([card]));
  assert.notEqual(by(t, 'Answer').css.phone['text-align'], 'center');
});

test('outlined text gets a stroke; Divi link styling is undone and link boxes outrank it', () => {
  const outlined = mtext('Outlined', { x: 240, y: 40, w: 400, h: 90 }, 'WATER MITIGATION', { size: 60, color: '#ffffff' });
  outlined.stroke = { color: '#999999', weight: 1, align: 'outside' };
  const btn = mk('frame', 'Btn', { x: 240, y: 200, w: 300, h: 60 }, { layout: mrow(10, [20, 40, 20, 40], { align: 'center' }), sizing: { w: 'hug', h: 'hug' }, fills: [msolid('#ff5a00')], children: [mtext('Btn t', { x: 280, y: 220, w: 200, h: 20 }, 'Learn more about us', { autoResize: 'width-height', sizing: { w: 'hug', h: 'hug' } }), mk('rect', 'Btn arrow', { x: 500, y: 215, w: 30, h: 30 }, { fills: [msolid('#000000')] })] });
  const { ir, t } = build(page([outlined, btn]));
  assert.equal(by(t, 'Outlined').css.base['-webkit-text-stroke'], '2px #999999');
  assert.equal(by(t, 'Outlined').css.base['paint-order'], 'stroke fill');
  assert.equal(by(t, 'Btn t').css.phone.flex, '1 1 0', 'the label takes the room of a wider button, the arrow stays at its edge');
  const out = compileDivi(t, ir, {});
  assert.match(out.css, /\.f2d-frag-host a:not\(\.wc-forward\), [^{]+\{ padding-bottom: 0; line-height: inherit; font-weight: inherit; \}/);
  assert.match(out.css, new RegExp(`a\.${by(t, 'Btn').cls}\.${by(t, 'Btn').cls} \{`));
});

test('layered rows scale as one composition on narrow desktops; filling text never shrinks below its content', () => {
  const { t } = setup();
  const photo = by(t, 'Photo');
  assert.equal(photo.css.narrow.width, '71.014%', '588 / 828');
  assert.equal(photo.css.narrow['margin-left'], '-58.816%', '-487 / 828');
  const col = mk('frame', 'Step', { x: 240, y: 40, w: 535, h: 129 }, { layout: mcol(20), sizing: { w: 'fixed', h: 'fixed' }, children: [mtext('Step title', { x: 240, y: 40, w: 535, h: 25 }, 'Emergency Restoration Call', { size: 20, sizing: { w: 'fill', h: 'hug' } }), mtext('Step text', { x: 240, y: 85, w: 535, h: 45 }, 'Call or send the quote form so the damage can be reviewed.', { lines: 2, sizing: { w: 'fill', h: 'fill' }, grow: 1 })] });
  const r = build(page([col]));
  assert.equal(by(r.t, 'Step text').css.narrow.flex, '1 0 auto');
});
