// Interactive components + layered/overflowing layouts (homepage regressions, 2026-10-23): overlay
// header with a nav bar, a banner with asymmetric padding and side art, a photo-over-panel row with a
// badge and an overhang, a card strip running past its box, a ticker, a slider with arrows and an
// accordion. Assets: 'logo:image', 'photo:image', 'art:image'.
import { node, row, col, text, doc, solid } from './make.mjs';

const W = 1920;
const T = (nm, x, y, w, h, chars, o = {}) => text(nm, { x, y, w, h }, chars, { autoResize: 'width-height', sizing: { w: 'hug', h: 'hug' }, ...o });
const icon = (nm, x, y, s = 20, color = '#ff5a00') => node('rect', nm, { x, y, w: s, h: s }, { fills: [solid(color)] });
const img = (key) => ({ asset: key, fills: [{ type: 'image', scaleMode: 'fill', opacity: 1, imageHash: key }] });

export const COMPONENT_ASSETS = { 'logo:image': [180, 180], 'photo:image': [588, 500], 'art:image': [487, 380] };

export function fixtureComponents() {
  // ---- header: contact strip (right-aligned) + absolute overlay (logo + black bar: links + CTA)
  const info = node('frame', 'Info', { x: 0, y: 0, w: W, h: 120 }, {
    layout: row(50, [36, 240, 36, 240], { justify: 'end', align: 'center' }), sizing: { w: 'fill', h: 'fixed' },
    children: [['Location', 'Cleveland, OH, USA'], ['Call', '(216) 440-1584'], ['Mail', 'mail@example-company.com']].map(([nm, v], i) =>
      node('frame', nm, { x: 769 + i * 300, y: 36, w: 250, h: 48 }, { layout: row(20, [0, 0, 0, 0], { align: 'center' }), sizing: { w: 'hug', h: 'hug' }, children: [icon(`${nm} icon`, 769 + i * 300, 36, 48), T(`${nm} text`, 837 + i * 300, 50, 180, 20, v, { size: 16 })] })),
  });
  const links = node('frame', 'Links', { x: 463, y: 121, w: 547, h: 60 }, {
    layout: row(40, [0, 0, 0, 0], { align: 'center' }), sizing: { w: 'hug', h: 'hug' },
    children: ['home', 'about', 'services', 'contact us'].map((t, i) => node('frame', `Link ${t}`, { x: 463 + i * 140, y: 121, w: 100, h: 60 }, { layout: row(10, [0, 0, 0, 0], { align: 'center', justify: 'center' }), sizing: { w: 'hug', h: 'fixed' }, children: [T(`Link ${t} text`, 463 + i * 140, 142, 80, 17, t, { size: 16, color: '#ffffff', textCase: 'upper' })] })),
  });
  const cta = node('frame', 'CTA', { x: 1466, y: 121, w: 214, h: 60 }, { layout: col(10, [20, 40, 20, 40]), sizing: { w: 'hug', h: 'hug' }, fills: [solid('#ff5a00')], children: [T('CTA text', 1506, 142, 109, 19, 'GET A QUOTE', { size: 16, color: '#ffffff' })] });
  const bar = node('frame', 'Bar', { x: 240, y: 121, w: 1440, h: 60 }, {
    layout: row(456, [0, 0, 0, 223], { justify: 'space-between', align: 'center' }), sizing: { w: 'fixed', h: 'fixed' },
    children: [node('rect', 'Bar bg', { x: 240, y: 121, w: 1440, h: 60 }, { positioning: 'absolute', fills: [solid('#000000')] }), links, cta],
  });
  const overlay = node('frame', 'Menu', { x: 0, y: 0, w: W, h: 181 }, { positioning: 'absolute', layout: col(-59, [0, 240, 0, 240]), sizing: { w: 'fixed', h: 'fixed' }, children: [node('rect', 'Logo', { x: 240, y: 0, w: 180, h: 180 }, img('logo:image')), bar] });
  const header = node('frame', 'Header section', { x: 0, y: 0, w: W, h: 200 }, { layout: col(0), sizing: { w: 'fill', h: 'hug' }, fills: [solid('#fdf1dc')], children: [info, overlay] });

  // ---- banner: content column + side art in the reserved right padding (800 = 240 gutter + 560)
  let y = 200;
  const banner = node('frame', 'Banner section', { x: 0, y, w: W, h: 500 }, {
    layout: col(0), sizing: { w: 'fill', h: 'hug' }, fills: [solid('#111827')],
    children: [node('frame', 'Banner box', { x: 0, y: y + 50, w: W, h: 400 }, {
      layout: col(20, [0, 800, 0, 240]), sizing: { w: 'fixed', h: 'hug' },
      children: [
        node('frame', 'Banner content', { x: 240, y: y + 50, w: 880, h: 300 }, { layout: col(20), sizing: { w: 'fill', h: 'hug' }, children: [text('Banner heading', { x: 240, y: y + 50, w: 880, h: 260 }, 'A-ROC CONSTRUCTION AND DEVELOPMENT LLC RESTORATION SERVICES IN CLEVELAND, OH', { size: 55, lineHeight: 65, color: '#ffffff', lines: 4, sizing: { w: 'fill', h: 'hug' } })] }),
        node('rect', 'Side art', { x: 1180, y: y + 60, w: 487, h: 380 }, { positioning: 'absolute', ...img('art:image') }),
      ],
    })],
  });

  // ---- layered row: orange panel overhanging its frame, photo pulled over it (negative gap), badge
  y += 500;
  const imageRow = node('frame', 'Image', { x: 0, y, w: 828, h: 600 }, {
    layout: row(-487), sizing: { w: 'hug', h: 'fill' },
    children: [
      node('rect', 'Panel', { x: 0, y, w: 727, h: 640 }, { fills: [solid('#ff5a00')] }),
      node('rect', 'Photo', { x: 240, y, w: 588, h: 500 }, img('photo:image')),
      node('frame', 'Rating', { x: 240, y: y + 530, w: 369, h: 60 }, { positioning: 'absolute', layout: row(24, [0, 0, 0, 0], { align: 'center' }), sizing: { w: 'hug', h: 'hug' }, children: [T('Rating value', 240, y + 530, 120, 60, '5.0', { size: 48, color: '#ffffff' }), T('Rating label', 384, y + 548, 160, 20, 'Customer Review', { size: 18, color: '#ffffff' })] }),
    ],
  });
  const about = node('frame', 'About section', { x: 0, y, w: W, h: 600 }, {
    layout: row(142, [0, 240, 0, 0]), sizing: { w: 'fill', h: 'fixed' },
    children: [imageRow, node('frame', 'About text', { x: 970, y: y + 100, w: 710, h: 300 }, { layout: col(20, [100, 0, 100, 0]), sizing: { w: 'fill', h: 'fill' }, children: [text('About heading', { x: 970, y: y + 100, w: 655, h: 132 }, 'Cleveland restoration company with 25+ years of experience', { size: 40, lineHeight: 44, lines: 3, sizing: { w: 'fill', h: 'hug' } })] })],
  });

  // ---- card strip: 8 cards, 3½ visible, the section clips the rest
  y += 600;
  const strip = node('frame', 'Strip', { x: 294, y: y + 50, w: 1626, h: 400 }, {
    layout: row(20, [0, 0, 0, 0]), sizing: { w: 'fixed', h: 'hug' },
    children: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => node('frame', `Card ${i + 1}`, { x: 294 + i * 435, y: y + 50, w: 415, h: 400 }, { layout: col(10, [20, 20, 20, 20]), sizing: { w: 'fixed', h: 'fixed' }, fills: [solid('#f4f4f4')], children: [text(`Card ${i + 1} title`, { x: 314 + i * 435, y: y + 70, w: 375, h: 24 }, `Water Damage Service ${i + 1}`, { size: 20, sizing: { w: 'fill', h: 'hug' } })] })),
  });
  const services = node('frame', 'Services section', { x: 0, y, w: W, h: 500 }, { layout: col(0, [50, 0, 50, 0]), sizing: { w: 'fill', h: 'hug' }, clips: true, children: [strip] });

  // ---- ticker: a clipped row of phrases running far past the edge
  y += 500;
  let x = 10;
  const items = ['Water Damage Restoration', 'Water Mitigation', 'Emergency Water Removal', 'Flood Damage Cleanup', 'Fire Damage Restoration', 'Mold Remediation'].map((wd, i) => {
    const w = wd.length * 26 + 115;
    const it = node('frame', `Tick ${i + 1}`, { x, y, w, h: 90 }, { layout: row(38, [0, 0, 0, 0], { align: 'center' }), sizing: { w: 'hug', h: 'hug' }, children: [T(`Tick ${i + 1} text`, x, y, w - 115, 90, wd, { size: 40, textCase: 'upper' }), icon(`Tick ${i + 1} star`, x + w - 77, y + 6, 77)] });
    x += w + 38;
    return it;
  });
  const ticker = node('frame', 'Ticker section', { x: 0, y, w: W, h: 140 }, { layout: col(10), sizing: { w: 'fill', h: 'hug' }, children: [node('frame', 'Ticker', { x: 10, y, w: 1900, h: 90 }, { clips: true, sizing: { w: 'fixed', h: 'fixed' }, children: items })] });

  // ---- slider: two review cards, round arrows at both ends
  y += 140;
  const card = (i) => node('frame', `Review ${i + 1}`, { x: 240 + i * 730, y: y + 50, w: 710, h: 300 }, { layout: col(10, [30, 30, 30, 30]), sizing: { w: 'fill', h: 'hug' }, grow: 1, fills: [solid('#0b1220')], children: [text(`Review ${i + 1} text`, { x: 270 + i * 730, y: y + 80, w: 650, h: 60 }, ['Fast help after basement water damage', 'Clear communication during a stressful cleanup'][i], { size: 22, color: '#ffffff', sizing: { w: 'fill', h: 'hug' } })] });
  const slider = node('frame', 'Reviews', { x: 240, y: y + 50, w: 1440, h: 300 }, {
    layout: row(20, [0, 0, 0, 0]), sizing: { w: 'fill', h: 'hug' },
    children: [card(0), card(1), node('rect', 'Prev', { x: 205, y: y + 165, w: 70, h: 70 }, { positioning: 'absolute', fills: [solid('#ffffff')] }), node('rect', 'Next', { x: 1645, y: y + 165, w: 70, h: 70 }, { positioning: 'absolute', fills: [solid('#ff5a00')] })],
  });
  const reviews = node('frame', 'Reviews section', { x: 0, y, w: W, h: 400 }, { layout: col(0, [50, 240, 50, 240]), sizing: { w: 'fill', h: 'hug' }, children: [slider] });

  // ---- accordion: item 1 open (answer under its heading, orange), items 2–3 closed (white)
  y += 400;
  const acc = (i, open) => {
    const hy = y + 50 + i * 140;
    const head = node('frame', `Q${i + 1} head`, { x: 1003, y: hy, w: 646, h: 54 }, { layout: row(56, [0, 0, 0, 0], { align: 'center' }), sizing: { w: 'fill', h: 'hug' }, children: [text(`Q${i + 1} text`, { x: 1003, y: hy, w: 570, h: 54 }, `Question number ${i + 1} about restoration services?`, { size: 22, color: open ? '#ffffff' : '#0b1220', sizing: { w: 'fill', h: 'hug' }, grow: 1 }), icon(`Q${i + 1} icon`, 1630, hy + 17, 19, open ? '#ffffff' : '#ff5a00')] });
    const kids = [head];
    if (open) kids.push(text(`Q${i + 1} answer`, { x: 1003, y: hy + 74, w: 646, h: 54 }, 'A-ROC answers the phone around the clock and arrives ready to stop the damage.', { size: 16, color: '#ffffff', lines: 2, sizing: { w: 'fill', h: 'hug' } }));
    return node('frame', `Q${i + 1}`, { x: 972, y: hy - 31, w: 708, h: open ? 180 : 116 }, { layout: col(20, [31, 31, 31, 31]), sizing: { w: 'fill', h: 'hug' }, fills: [solid(open ? '#ff5a00' : '#ffffff')], children: kids });
  };
  const faq = node('frame', 'FAQ section', { x: 0, y, w: W, h: 500 }, { layout: col(0, [50, 240, 50, 972]), sizing: { w: 'fill', h: 'hug' }, fills: [solid('#f7f7f7')], children: [node('frame', 'FAQ list', { x: 972, y: y + 19, w: 708, h: 440 }, { layout: col(20), sizing: { w: 'fill', h: 'hug' }, children: [acc(0, true), acc(1, false), acc(2, false)] })] });

  y += 500;
  const root = node('frame', 'Components fixture', { x: 0, y: 0, w: W, h: y }, { layout: col(0), fills: [solid('#ffffff')], sizing: { w: 'fixed', h: 'hug' }, clips: true, children: [header, banner, about, services, ticker, reviews, faq] });
  return doc(root, { width: W });
}
