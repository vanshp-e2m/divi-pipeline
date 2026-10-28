// Per-section responsive plan, derived from the layout decisions the compiler will actually emit (the
// dry-run box tree), so the plan cannot promise a behaviour the page does not implement. Recorded in
// build-plan.json → responsive.sections, and validated by QA at every viewport of the matrix.
// The tiers are the responsive ladder (DEV Connect rules with Divi's tablet 980 / phone 767 edges).
import { LADDER } from '../layout/engine.mjs';

const TIERS = ['wide', 'narrow', 'tabletExtra', 'tablet', 'mobileExtra', 'phone'];
const SMALL = ['tablet', 'phone'];

function walk(b, fn, depth = 0) {
  fn(b, depth);
  for (const c of b.children) walk(c, fn, depth + 1);
}

// What a row does on a tier (the nearest wider tier's rule applies when it has none of its own).
function rowBehaviour(b, tier) {
  const at = TIERS.indexOf(tier);
  const pick = (k) => { for (let i = at; i >= 1; i--) if (b.css[TIERS[i]]?.[k] !== undefined) return b.css[TIERS[i]][k]; return b.css.base[k]; };
  const childFlex = (c) => { for (let i = at; i >= 1; i--) if (c.css[TIERS[i]]?.flex !== undefined) return c.css[TIERS[i]].flex; return c.css.base.flex || ''; };
  if (pick('flex-direction') === 'column' && (b.css.base['flex-direction'] || '').startsWith('row')) return b.children.some((c) => c.css[tier]?.order === '-1') ? 'stack, text first' : 'stack';
  if (pick('flex-wrap') === 'nowrap' && b.css.base['flex-wrap'] === 'wrap') return 'one row (block + controls)';
  if (b.children.some((c) => childFlex(c).includes('calc(50%'))) return b.children.some((c) => childFlex(c) === '1 1 100%') ? 'two-up grid, odd last card spans' : 'two-up grid';
  if (pick('flex-wrap') === 'wrap') return 'row, wraps when full';
  return 'row';
}

export function responsivePlan(tree, ir, { frameW = tree.frame?.width, breakpoints = { tablet: 980, phone: 767 } } = {}) {
  const N = ir.nodes;
  const frames = ir.frames.map((f) => f.viewport);
  const narrowAt = tree.root.narrowAt || null;
  const wideAt = tree.root.wideAt || Math.max(frameW || 0, 1920);
  const ladder = [
    { tier: 'wide', bp: 'widescreen', query: `min-width: ${wideAt + 1}px`, does: '4K containment: backgrounds full-bleed, content in the column it has at 1920, centred; section heights unchanged' },
    { tier: 'base', bp: 'desktop', query: null, does: `the design (${frameW}px) down to ${narrowAt ? narrowAt + 1 : LADDER.laptop + 1}px` },
    { tier: 'narrow', bp: 'laptop', query: `max-width: ${narrowAt || LADDER.laptop}px`, does: 'gutters tighten, columns hold where they fit, rows that cannot fit wrap' },
    { tier: 'tabletExtra', bp: 'tablet_extra', query: `max-width: ${LADDER.tabletExtra}px`, does: '3–4 column grids go two-up' },
    { tier: 'tablet', bp: 'tablet (Divi)', query: `max-width: ${breakpoints.tablet}px`, does: 'tablet gutters, stepped type' },
    { tier: 'mobileExtra', bp: 'mobile_extra', query: `max-width: ${LADDER.mobileExtra}px`, does: 'multi-column rows stack in reading order, text first' },
    { tier: 'phone', bp: 'mobile (Divi)', query: `max-width: ${breakpoints.phone}px`, does: 'single column, 44×44 tap targets, phone gutters' },
  ];
  const sections = [];
  for (const s of tree.root.children.filter((c) => c.section || N[c.id]?.a.role === 'section')) {
    const used = new Set();
    walk(s, (b) => { for (const t of TIERS) if (b.css[t] && Object.keys(b.css[t]).length) used.add(t); });
    const sec = {
      id: s.id,
      name: s.name,
      reference: { desktop: frames.includes('desktop') ? 'figma frame' : 'inferred', tablet: frames.includes('tablet') ? 'figma frame' : 'inferred from desktop', phone: frames.includes('phone') ? 'figma frame' : 'inferred from desktop' },
      breakpointsUsed: ['base', ...TIERS.filter((t) => used.has(t))],
      header: s.header ? { sticky: true, compactBelow: tree.root.menuAt || null, drawer: 'links + call-to-action + the header\'s other bars; scrolls inside the screen when taller' } : null,
      container: {
        desktop: s.css.base.padding?.includes('max(') ? `content ${s.contentWidth || '?'}px centred, fluid gutters ≥24px` : `padding ${s.css.base.padding || '0'}`,
        wide: s.css.base.padding?.includes('max(') ? 'content column already centred (fluid gutters)' : 'contained to the 1920 column where content would stretch',
        tablet: `padding ${s.css.tablet.padding || 'as desktop'}`,
        phone: `padding ${s.css.phone.padding || 'as desktop'}`,
      },
      rows: [],
      flowConversions: [],
      typography: [],
      images: [],
      buttons: [],
      hidden: { tablet: [], phone: [] },
      reordered: { tablet: [], phone: [] },
      connectors: [],
      carousels: [],
    };
    walk(s, (b) => {
      const n = N[b.id];
      const base = b.css.base;
      if (!n) return;
      if (base.display === 'flex' && (base['flex-direction'] || '').startsWith('row') && b.children.length > 1 && b.kind !== 'button' && !n.a.widget) {
        const row = { id: b.id, name: b.name, items: b.children.length, desktop: base['flex-wrap'] === 'wrap' ? 'row, wraps when full' : 'row' };
        for (const t of TIERS.slice(1)) row[t] = rowBehaviour(b, t);
        sec.rows.push(row);
      }
      if (!base.display && b.children.some((c) => c.css.base.position === 'absolute') && SMALL.some((bp) => b.css[bp]?.display === 'flex')) {
        sec.flowConversions.push({ id: b.id, name: b.name, at: SMALL.filter((bp) => b.css[bp]?.display === 'flex'), order: b.children.filter((c) => c.css.phone.order !== undefined).sort((x, y) => +x.css.phone.order - +y.css.phone.order).map((c) => c.name) });
      }
      if (b.kind === 'text' && /^h[1-4]$/.test(b.tag || '')) {
        // Stepped sizes, one per tier where the size changes (never clamp()/vw).
        const steps = { desktop: base['font-size'] };
        for (const t of TIERS.slice(1)) if (b.css[t]?.['font-size']) steps[t] = b.css[t]['font-size'];
        sec.typography.push({ name: b.name.slice(0, 40), tag: b.tag, steps, balanced: b.css.base['text-wrap'] === 'balance' || Object.values(b.css).some((c) => c?.['text-wrap'] === 'balance') });
      }
      if (b.kind === 'image' || (base.background || '').includes('url(')) sec.images.push({ name: b.name.slice(0, 40), fit: base['object-fit'] || (base.background || '').match(/\/ ([^,]+?) (no-)?repeat/)?.[1] || 'cover', keepsAspect: !!(b.css.phone['aspect-ratio'] || b.css.tablet['aspect-ratio']) });
      if (b.kind === 'button') sec.buttons.push({ name: b.name, label: (b.children.find((c) => c.kind === 'text')?.text || '').slice(0, 30), hover: b.derivedHover ? 'derived from its colour' : b.hover ? 'from the design' : 'none', tap: '≥ 44×44 on phones', note: 'label and icon never wrap apart; button rows wrap/stack when they cannot share a line' });
      for (const bp of SMALL) {
        if (b.css[bp]?.display === 'none') sec.hidden[bp].push(b.name);
        if (b.css[bp]?.order !== undefined && b.css[bp].order !== '0') sec.reordered[bp].push(`${b.name} → ${b.css[bp].order}`);
      }
      if (b.css.phone?.transform?.includes('rotate(90deg)')) sec.connectors.push({ name: b.name, phone: 'vertical, centred on the sequence', tablet: b.css.tablet.display === 'none' ? 'hidden (steps wrap two-up)' : 'horizontal' });
      if (n.a.widget === 'carousel-strip') sec.carousels.push({ name: b.name, belowDesktop: (b.css.phone.flex || b.children[0]?.css.phone.flex || '').includes('100%') || b.children.some((c) => c.css.phone.flex === '0 0 100%') ? 'one slide fills the slider' : 'slides keep their aspect ratio, about 85% wide' });
    });
    sec.validation = {
      viewports: '3840, 2560, 2401/2400, 2000, 1920, 1680, 1440, 1367/1366, 1280, 1201/1200, 1024, 981/980, 960, 881/880, 768/767, 600, 480, 414, 390, 375, 360, 320 + both sides of every breakpoint the build emits + landscape 844×390, 932×430, 1024×768, 1180×820, 1366×1024 (target OS scrollbars)',
      checks: ['no horizontal overflow', 'no content cut off, collapsed or spilling into the next section', 'no mid-word breaks / squeezed text', 'no overlap of visible content', 'tap targets ≥ 44×44 on phones', 'looks intentional: no orphan words, equal card heights, no lonely last card, no distorted images, no cramped edges at 320', '4K containment at 1920–3840', 'sticky header + drawer (desktop, tablet, phone, landscape)', 'visual + geometry against Figma at the design width'],
    };
    sections.push(sec);
  }
  return { breakpoints, ladder, narrowAt, menuAt: tree.root.menuAt || null, wideAt, inferred: !frames.includes('tablet') || !frames.includes('phone'), sections };
}
