// Builders for small figma-ir/1 documents: representative regression fixtures without a Figma file.
let seq = 0;
const id = () => `9:${++seq}`;

export function node(type, name, box, o = {}) {
  return {
    id: o.id || id(), name, type, visible: true, opacity: o.opacity ?? 1, blendMode: 'pass-through',
    box, renderBox: o.renderBox || box, size: { w: box.w, h: box.h }, rotation: 0,
    layout: o.layout || null,
    sizing: { w: 'fixed', h: 'fixed', minW: null, maxW: null, minH: null, maxH: null, ...(o.sizing || {}) },
    positioning: o.positioning || 'auto', constraints: o.constraints || { h: 'min', v: 'min' }, grow: o.grow || 0, alignSelf: o.alignSelf || 'auto',
    fills: o.fills || [], stroke: o.stroke || null, radius: o.radius || null, effects: o.effects || [], clips: !!o.clips, isMask: false,
    text: o.text || null, asset: o.asset || null, fillAsset: o.fillAsset || null, component: null, interactions: o.interactions || [], readingOrder: null,
    children: o.children || [], ...(o.states ? { states: o.states } : {}),
  };
}

export const solid = (color, opacity = 1) => ({ type: 'solid', color, opacity });
export const row = (gap, padding = [0, 0, 0, 0], o = {}) => ({ direction: 'row', wrap: false, gap, counterGap: 0, padding, justify: o.justify || 'start', align: o.align || 'start', alignContent: null, reverse: false, strokesIncluded: false });
export const col = (gap, padding = [0, 0, 0, 0], o = {}) => ({ ...row(gap, padding, o), direction: 'column' });

export function text(name, box, characters, o = {}) {
  const seg = { start: 0, end: characters.length, fontFamily: o.family || 'Arial', fontStyle: o.weight >= 700 ? 'Bold' : 'Regular', fontWeight: o.weight || 400, italic: false, fontSize: o.size || 16, lineHeight: o.lineHeight ? { unit: 'px', value: o.lineHeight } : { unit: 'auto' }, letterSpacing: { unit: 'percent', value: 0 }, color: o.color || '#000000', decoration: 'none', textCase: o.textCase || 'original', href: null, list: 'none' };
  return node('text', name, box, {
    ...o,
    fills: [solid(o.color || '#000000')],
    sizing: o.sizing || { w: 'fixed', h: 'hug' },
    text: { characters, segments: [seg], align: o.align || 'left', valign: 'top', autoResize: o.autoResize || 'height', maxLines: null, paragraphSpacing: 0, lines: o.lines ?? 1, leadingTrim: o.leadingTrim || 'none' },
  });
}

export function doc(root, { width = 1440, assets = {} } = {}) {
  return { schema: 'figma-ir/1', meta: { fileName: 'fixture', fileKey: '', exportedAt: '2026-01-01T00:00:00Z', pluginVersion: 'fixture', rasterized: [], fonts: [] }, frames: [{ id: root.id, name: root.name, slug: 'fixture', width, height: root.box.h, screenshot: null, screenshotScale: 1, screenshotBox: null, root }], assets };
}

// Responsive regression fixture: the structures that broke on homepage-v2 at tablet/phone widths.
export function fixtureResponsive() {
  seq = 100;
  const W = 1920;
  const hero = node('frame', 'Hero section', { x: 0, y: 0, w: W, h: 700 }, {
    layout: col(0), sizing: { w: 'fill', h: 'hug' }, fills: [solid('#111111')],
    children: [
      // nested full-width container carrying the 240px desktop padding (was never made fluid)
      node('frame', 'Hero inner', { x: 0, y: 0, w: W, h: 700 }, {
        layout: col(24, [160, 240, 160, 240]), sizing: { w: 'fill', h: 'hug' },
        children: [
          text('Hero heading', { x: 240, y: 160, w: 780, h: 240 }, 'We create visual/signage solutions for businesses', { size: 74, lineHeight: 94, color: '#ffffff', textCase: 'upper', lines: 4 }),
          node('frame', 'Hero buttons', { x: 240, y: 430, w: 613, h: 70 }, {
            layout: row(20), sizing: { w: 'hug', h: 'hug' },
            children: [
              node('frame', 'Btn A', { x: 240, y: 430, w: 276, h: 70 }, { layout: row(10, [10, 10, 10, 40], { align: 'center' }), sizing: { w: 'hug', h: 'hug' }, fills: [solid('#c3ac89')], children: [text('Btn A label', { x: 280, y: 458, w: 150, h: 14 }, 'GET A QUOTE', { size: 18, autoResize: 'width-height', sizing: { w: 'hug', h: 'hug' } })] }),
              node('frame', 'Btn B', { x: 536, y: 430, w: 317, h: 70 }, { layout: row(10, [10, 10, 10, 40], { align: 'center' }), sizing: { w: 'hug', h: 'hug' }, stroke: { color: '#ffffff', weight: 2, align: 'inside' }, children: [text('Btn B label', { x: 576, y: 458, w: 190, h: 14 }, 'VIEW OUR WORK', { size: 18, color: '#ffffff', autoResize: 'width-height', sizing: { w: 'hug', h: 'hug' } })] }),
            ],
          }),
        ],
      }),
    ],
  });
  const steps = [0, 1, 2, 3].map((i) => node('frame', `Step ${i + 1}`, { x: 240 + i * 385, y: 800, w: 285, h: 200 }, {
    layout: col(16, [0, 10, 0, 10], { align: 'center' }), sizing: { w: 'fill', h: 'hug' }, grow: 1,
    children: [
      node('frame', `Step ${i + 1} icon`, { x: 332 + i * 385, y: 800, w: 100, h: 100 }, { fills: [solid('#c3ac89')], radius: [50, 50, 50, 50] }),
      text(`Step ${i + 1} title`, { x: 300 + i * 385, y: 916, w: 165, h: 22 }, ['Consultation', 'Design', 'Manufacture', 'Installation'][i], { size: 22, autoResize: 'width-height', sizing: { w: 'hug', h: 'hug' } }),
    ],
  }));
  const timelineKids = [];
  steps.forEach((s, i) => {
    timelineKids.push(s);
    if (i < 3) timelineKids.push(node('rect', `Connector ${i + 1}`, { x: 525 + i * 385, y: 849, w: 60, h: 2 }, { fills: [solid('#c3ac89')] }));
  });
  const timeline = node('frame', 'Timeline section', { x: 0, y: 760, w: W, h: 320 }, {
    layout: col(0, [40, 240, 40, 240]), sizing: { w: 'fill', h: 'hug' },
    children: [node('frame', 'Timeline row', { x: 240, y: 800, w: 1440, h: 200 }, { layout: row(20, [0, 0, 0, 0], { align: 'start' }), sizing: { w: 'fill', h: 'hug' }, children: timelineKids })],
  });
  const faq = node('frame', 'FAQ section', { x: 0, y: 1080, w: W, h: 110 }, {
    layout: col(0, [40, 240, 40, 240]), sizing: { w: 'fill', h: 'hug' },
    children: [node('frame', 'FAQ row', { x: 240, y: 1120, w: 1440, h: 30 }, { layout: row(20, [0, 0, 0, 0], { align: 'center' }), sizing: { w: 'fill', h: 'hug' }, children: [
      node('frame', 'FAQ icon', { x: 240, y: 1120, w: 30, h: 30 }, { stroke: { color: '#000000', weight: 2, align: 'inside' }, radius: [15, 15, 15, 15] }),
      text('FAQ question', { x: 290, y: 1125, w: 1390, h: 20 }, 'Lorem ipsum has been the industry standard dummy text', { size: 20, sizing: { w: 'fill', h: 'hug' }, grow: 1 }),
    ] })],
  });
  // narrow-desktop structures: a nav whose links + call button stop fitting, a stats row with an
  // uppercase badge, a layout-less service row, and a contact row with a rounded (clipping) form card.
  let y = 1190;
  const nav = node('frame', 'Nav section', { x: 0, y, w: W, h: 120 }, {
    layout: row(10, [25, 50, 25, 50], { justify: 'space-between', align: 'center' }), sizing: { w: 'fill', h: 'hug' }, fills: [solid('#111111')],
    children: [
      text('Nav logo', { x: 50, y: y + 45, w: 124, h: 30 }, 'SIGNPRO', { size: 28, color: '#ffffff', autoResize: 'width-height', sizing: { w: 'hug', h: 'hug' } }),
      node('frame', 'Nav right', { x: 693, y: y + 25, w: 1177, h: 70 }, { layout: row(55, [0, 0, 0, 0], { align: 'center' }), sizing: { w: 'hug', h: 'hug' }, children: [
        node('frame', 'Nav links', { x: 693, y: y + 53, w: 802, h: 14 }, { layout: row(64, [0, 0, 0, 0], { align: 'center' }), sizing: { w: 'hug', h: 'hug' }, children: ['Services', 'Our Work', 'Insights', 'About', 'Career', 'Contact'].map((t, i) => text(`Nav ${t}`, { x: 693 + i * 134, y: y + 53, w: 80, h: 14 }, t, { size: 16, color: '#ffffff', autoResize: 'width-height', sizing: { w: 'hug', h: 'hug' } })) }),
        node('frame', 'Nav call', { x: 1550, y: y + 25, w: 320, h: 70 }, { layout: row(10, [25, 40, 25, 40], { align: 'center', justify: 'center' }), sizing: { w: 'hug', h: 'hug' }, fills: [solid('#c3ac89')], children: [text('Nav call label', { x: 1590, y: y + 48, w: 240, h: 24 }, '03 9873 7319', { size: 24, autoResize: 'width-height', sizing: { w: 'hug', h: 'hug' } })] }),
      ] }),
    ],
  });
  y += 120;
  const stats = node('frame', 'Stats section', { x: 0, y, w: W, h: 230 }, {
    layout: col(0, [40, 240, 40, 240]), sizing: { w: 'fill', h: 'hug' },
    children: [node('frame', 'Stats row', { x: 240, y: y + 40, w: 1440, h: 150 }, { layout: row(0, [0, 0, 0, 0], { align: 'center' }), sizing: { w: 'fill', h: 'fixed' }, children: [0, 1, 2, 3].map((i) => node('frame', `Stat ${i + 1}`, { x: 240 + i * 360, y: y + 40, w: 360, h: 150 }, {
      layout: col(16, [20, 20, 20, 20], { align: 'center', justify: 'center' }), sizing: { w: 'fill', h: 'fill' }, grow: 1, ...(i === 3 ? { fills: [solid('#c3ac89')], clips: true, radius: [8, 8, 8, 8] } : {}),
      children: [text(`Stat ${i + 1} label`, { x: 260 + i * 360, y: y + 103, w: 320, h: 24 }, ['YEARS IN TRADE', 'PROJECTS DONE', 'HAPPY CLIENTS', 'AUSTRALIA'][i], { size: 24, textCase: 'upper', align: 'center', sizing: { w: 'fill', h: 'hug' } })],
    })) })],
  });
  y += 230;
  const service = node('frame', 'Service section', { x: 0, y, w: W, h: 260 }, {
    layout: col(0, [40, 240, 40, 240]), sizing: { w: 'fill', h: 'hug' },
    children: [node('frame', 'Service comp', { x: 240, y: y + 40, w: 1440, h: 180 }, { sizing: { w: 'fill', h: 'fixed' }, children: [
      node('rect', 'Service bg', { x: 240, y: y + 40, w: 1440, h: 180 }, { fills: [solid('#fafafa')] }),
      text('Service number', { x: 250, y: y + 74, w: 123, h: 105 }, '2', { size: 120, color: '#eeeeee' }),
      text('Service title', { x: 393, y: y + 118, w: 346, h: 24 }, 'Fleet Branding', { size: 24, textCase: 'upper' }),
      text('Service text', { x: 877, y: y + 92, w: 358, h: 77 }, 'Pellentesque platea purus tempus eget amet vulputate vulputate sed metus.', { size: 16, lines: 3 }),
      node('frame', 'Service arrow', { x: 1550, y: y + 90, w: 80, h: 80 }, { fills: [solid('#c3ac89')], radius: [8, 8, 8, 8] }),
      node('frame', 'Service reveal', { x: 1403, y: y - 12, w: 277, h: 232 }, { opacity: 0, clips: true, fills: [solid('#888888')] }),
    ] })],
  });
  y += 260;
  const input = (nm, x0, yy, label) => node('frame', nm, { x: x0, y: yy, w: 305, h: 85 }, { layout: row(10, [30, 20, 30, 20], { align: 'center' }), sizing: { w: 'fill', h: 'fixed' }, grow: 1, fills: [solid('#ffffff')], clips: true, radius: [8, 8, 8, 8], children: [text(`${nm} text`, { x: x0 + 20, y: yy + 30, w: 265, h: 25 }, label, { size: 18, sizing: { w: 'fill', h: 'hug' }, grow: 1 })] });
  const contact = node('frame', 'Contact section', { x: 0, y, w: W, h: 500 }, {
    layout: row(110, [80, 240, 80, 240], { align: 'start' }), sizing: { w: 'fill', h: 'hug' }, fills: [solid('#1d1d1d')],
    children: [
      text('Contact heading', { x: 240, y: y + 80, w: 530, h: 160 }, 'We would love to hear from you and see how we can help', { size: 40, lineHeight: 40, color: '#ffffff', textCase: 'upper', lines: 4 }),
      node('frame', 'Contact card', { x: 880, y: y + 80, w: 800, h: 340 }, { layout: col(30, [80, 80, 80, 80]), sizing: { w: 'fixed', h: 'hug' }, fills: [solid('#f1f1f3')], clips: true, radius: [12, 12, 12, 12], children: [
        node('frame', 'Contact inputs', { x: 960, y: y + 160, w: 640, h: 85 }, { layout: row(30, [0, 0, 0, 0]), sizing: { w: 'fill', h: 'hug' }, children: [input('Email input', 960, y + 160, 'Email address'), input('Phone input', 1295, y + 160, 'Phone number')] }),
      ] }),
    ],
  });
  y += 500;
  const root = node('frame', 'Responsive fixture', { x: 0, y: 0, w: W, h: y }, { layout: col(0), fills: [solid('#ffffff')], sizing: { w: 'fixed', h: 'hug' }, clips: true, children: [hero, timeline, faq, nav, stats, service, contact] });
  return doc(root, { width: W });
}

// Representative page: nav, hero (background image + overlaid text), two-column, card grid, CTA.
export function fixturePage() {
  seq = 0;
  const W = 1440;
  const nav = node('frame', 'Nav', { x: 0, y: 0, w: W, h: 80 }, {
    layout: row(1000, [20, 120, 20, 120], { justify: 'space-between', align: 'center' }), sizing: { w: 'fill', h: 'hug' }, fills: [solid('#111111')],
    children: [
      text('Logo', { x: 120, y: 30, w: 80, h: 20 }, 'LOGO', { color: '#ffffff', weight: 700, size: 18, autoResize: 'width-height', sizing: { w: 'hug', h: 'hug' } }),
      node('frame', 'Links', { x: 1000, y: 30, w: 320, h: 20 }, { layout: row(40), sizing: { w: 'hug', h: 'hug' }, children: ['Home', 'Work', 'Contact'].map((t, i) => text(t, { x: 1000 + i * 100, y: 30, w: 60, h: 20 }, t, { color: '#ffffff', autoResize: 'width-height', sizing: { w: 'hug', h: 'hug' } })) }),
    ],
  });
  const hero = node('frame', 'Hero', { x: 0, y: 80, w: W, h: 600 }, {
    layout: col(24, [160, 120, 160, 120]), sizing: { w: 'fill', h: 'hug' }, fills: [{ type: 'image', scaleMode: 'fill', opacity: 1, imageHash: 'x' }], fillAsset: 'hero:fill',
    children: [
      text('Hero title', { x: 120, y: 240, w: 700, h: 120 }, 'Signs that sell your brand', { size: 56, lineHeight: 60, weight: 700, color: '#ffffff', lines: 2 }),
      node('frame', 'Hero CTA', { x: 120, y: 384, w: 200, h: 56 }, { layout: row(10, [16, 32, 16, 32], { align: 'center', justify: 'center' }), sizing: { w: 'hug', h: 'hug' }, fills: [solid('#c3ac89')], radius: [8, 8, 8, 8], states: { hover: { fills: [solid('#ffffff')], stroke: null, children: [] } }, interactions: [{ trigger: 'hover', action: 'style', durationMs: 200 }], children: [text('CTA label', { x: 152, y: 400, w: 136, h: 24 }, 'GET A QUOTE', { size: 18, weight: 700, autoResize: 'width-height', sizing: { w: 'hug', h: 'hug' } })] }),
    ],
  });
  const two = node('frame', 'Two column', { x: 0, y: 680, w: W, h: 400 }, {
    layout: row(80, [80, 120, 80, 120], { align: 'center' }), sizing: { w: 'fill', h: 'hug' },
    children: [
      node('rect', 'Photo', { x: 120, y: 760, w: 560, h: 240 }, { fills: [{ type: 'image', scaleMode: 'fill', opacity: 0.8, imageHash: 'y' }], asset: 'photo:image', radius: [12, 12, 12, 12] }),
      text('Body', { x: 760, y: 820, w: 560, h: 120 }, 'Long paragraph '.repeat(12).trim(), { size: 18, lineHeight: 28, lines: 4 }),
    ],
  });
  const cards = node('frame', 'Cards', { x: 0, y: 1080, w: W, h: 420 }, {
    layout: row(24, [80, 120, 80, 120]), sizing: { w: 'fill', h: 'hug' },
    children: [0, 1, 2].map((i) => node('frame', `Card ${i + 1}`, { x: 120 + i * 408, y: 1160, w: 384, h: 260 }, { layout: col(12, [24, 24, 24, 24]), sizing: { w: 'fill', h: 'hug' }, grow: 1, fills: [solid('#f2f2f5')], radius: [16, 16, 16, 16], children: [text(`Card title ${i + 1}`, { x: 144 + i * 408, y: 1184, w: 336, h: 32 }, `Card ${i + 1}`, { size: 28, lineHeight: 32, weight: 700, sizing: { w: 'fill', h: 'hug' } }), text(`Card body ${i + 1}`, { x: 144 + i * 408, y: 1228, w: 336, h: 96 }, 'Card body text '.repeat(6).trim(), { size: 16, lineHeight: 24, lines: 4, sizing: { w: 'fill', h: 'hug' } })] })),
  });
  const cta = node('frame', 'CTA band', { x: 0, y: 1500, w: W, h: 240 }, {
    layout: col(16, [80, 120, 80, 120], { align: 'center' }), sizing: { w: 'fill', h: 'hug' }, fills: [{ type: 'gradient', kind: 'linear', angle: 90, stops: [{ color: '#000000', position: 0 }, { color: '#333333', position: 1 }], opacity: 1, start: [0, 0.5], end: [1, 0.5] }],
    children: [text('CTA title', { x: 520, y: 1580, w: 400, h: 48 }, 'Ready to start?', { size: 40, lineHeight: 48, color: '#ffffff', align: 'center', autoResize: 'width-height', sizing: { w: 'hug', h: 'hug' } })],
  });
  const root = node('frame', 'Fixture page', { x: 0, y: 0, w: W, h: 1740 }, { layout: col(0), fills: [solid('#ffffff')], sizing: { w: 'fixed', h: 'hug' }, clips: true, children: [nav, hero, two, cards, cta] });
  return doc(root, { width: W });
}
