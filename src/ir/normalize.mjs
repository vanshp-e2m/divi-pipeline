// Raw input bundle (from an ingest adapter) -> normalized IR f2d-ir/1.
// Pure and deterministic: same bundle in, byte-identical IR out.
import { round, nodeClass } from '../util/core.mjs';

export const IR_SCHEMA = 'f2d-ir/1';

const r2 = (v) => (typeof v === 'number' ? round(v, 2) : v);
const box = (b) => (b ? { x: r2(b.x), y: r2(b.y), w: r2(b.w), h: r2(b.h) } : null);

function viewportOf(width) {
  if (width >= 1024) return 'desktop';
  if (width >= 600) return 'tablet';
  return 'phone';
}

function normFill(f) {
  const out = { type: f.type, opacity: f.opacity ?? 1 };
  if (f.type === 'solid') out.color = f.color;
  if (f.type === 'gradient') Object.assign(out, { kind: f.kind, angle: f.angle, stops: f.stops, start: f.start, end: f.end });
  if (f.type === 'image') Object.assign(out, { scaleMode: f.scaleMode, imageHash: f.imageHash, transform: f.transform || null });
  if (f.blendMode && f.blendMode !== 'normal') out.blend = f.blendMode;
  return out;
}

function normText(t) {
  if (!t) return null;
  // Figma encodes soft line breaks as U+2028 and paragraph breaks as U+2029; both are line breaks.
  t = { ...t, characters: t.characters.replace(/[\u2028\u2029]/g, '\n') };
  const runs = t.segments.map((s) => ({
    start: s.start,
    end: s.end,
    text: t.characters.slice(s.start, s.end),
    family: s.fontFamily,
    style: s.fontStyle,
    weight: s.fontWeight,
    italic: !!s.italic || /italic|oblique/i.test(s.fontStyle || ''),
    size: s.fontSize,
    lineHeight: s.lineHeight?.unit === 'px' ? s.lineHeight.value : s.lineHeight?.unit === 'percent' ? (s.lineHeight.value / 100) * s.fontSize : null,
    letterSpacing: s.letterSpacing?.unit === 'percent' ? (s.letterSpacing.value / 100) * s.fontSize : s.letterSpacing?.value || 0,
    color: s.color,
    fill: s.fill || null,
    decoration: s.decoration || 'none',
    textCase: s.textCase || 'original',
    href: s.href || null,
    list: s.list || 'none',
  }));
  return {
    content: t.characters,
    runs,
    align: t.align,
    valign: t.valign,
    autoResize: t.autoResize,
    maxLines: t.maxLines,
    paragraphSpacing: t.paragraphSpacing || 0,
    lines: t.lines ?? null,
    leadingTrim: t.leadingTrim && t.leadingTrim !== 'none' ? t.leadingTrim : null,
  };
}

function normLayout(l) {
  if (!l) return null;
  return {
    dir: l.direction,
    wrap: !!l.wrap,
    gap: r2(l.gap || 0),
    counterGap: r2(l.counterGap || 0),
    padding: (l.padding || [0, 0, 0, 0]).map(r2),
    justify: l.justify,
    align: l.align,
    reverse: !!l.reverse,
    strokesIncluded: !!l.strokesIncluded,
  };
}

function normStyleNode(n) {
  // Used for interaction states: keep only the visual style fields.
  return {
    sourceId: n.id,
    name: n.name,
    opacity: n.opacity,
    fills: (n.fills || []).map(normFill),
    stroke: n.stroke || null,
    radius: n.radius || null,
    effects: n.effects || [],
    text: n.text ? normText(n.text) : null,
    children: (n.children || []).map(normStyleNode),
  };
}

export function normalize(bundle, { slug } = {}) {
  const nodes = {};
  const issues = [];
  const frames = [];
  const interactions = [];
  const usedAssets = new Set();

  const issue = (code, severity, nodeId, message) => issues.push({ code, severity, nodeId, message });

  function visit(raw, parentId, frameId, depth, order) {
    const id = raw.id;
    if (raw.visible === false) {
      issue('HIDDEN_NODE', 'info', id, `Hidden node "${raw.name}" skipped`);
      return null;
    }
    const n = {
      id,
      cls: nodeClass(id),
      name: raw.name,
      type: raw.type,
      parent: parentId,
      frameId,
      depth,
      order,
      opacity: raw.opacity ?? 1,
      blend: raw.blendMode && raw.blendMode !== 'pass-through' && raw.blendMode !== 'normal' ? raw.blendMode : null,
      box: box(raw.box),
      renderBox: box(raw.renderBox),
      rotation: raw.rotation || 0,
      layout: normLayout(raw.layout),
      sizing: raw.sizing || { w: 'fixed', h: 'fixed' },
      positioning: raw.positioning || 'auto',
      constraints: raw.constraints || null,
      grow: raw.grow || 0,
      alignSelf: raw.alignSelf || 'auto',
      fills: (raw.fills || []).filter((f) => f.visible !== false).map(normFill),
      stroke: raw.stroke || null,
      radius: raw.radius || null,
      effects: (raw.effects || []).filter((e) => e.visible !== false),
      clips: !!raw.clips,
      isMask: !!raw.isMask,
      text: normText(raw.text),
      asset: raw.asset || null,
      fillAsset: raw.fillAsset || null,
      component: raw.component || null,
      readingOrder: raw.readingOrder || null,
      children: [],
    };
    if (n.asset) usedAssets.add(n.asset);
    if (n.fillAsset) usedAssets.add(n.fillAsset);
    if (n.isMask) issue('MASK', 'warn', id, `Mask node "${n.name}" — masks are approximated with clipping`);
    if (n.fills.some((f) => f.type === 'video')) issue('VIDEO_FILL', 'warn', id, `Video fill on "${n.name}" has no exported asset — needs a still-frame fallback`);
    if (n.rotation && !n.asset && n.type !== 'text') issue('ROTATION', 'info', id, `Rotation ${n.rotation}° on "${n.name}"`);

    for (const it of raw.interactions || []) {
      interactions.push({
        nodeId: id,
        trigger: it.trigger,
        action: it.action,
        url: it.url || null,
        destinationId: it.destinationId || null,
        durationMs: it.durationMs ?? null,
        easing: it.easing || null,
        transition: it.transitionType || null,
      });
    }
    if (raw.states) {
      n.states = {};
      for (const [k, s] of Object.entries(raw.states)) n.states[k] = normStyleNode(s);
    }

    nodes[id] = n;
    (raw.children || []).forEach((c, i) => {
      const cid = visit(c, id, frameId, depth + 1, i);
      if (cid) n.children.push(cid);
    });
    return id;
  }

  for (const f of bundle.frames) {
    const frameId = f.sourceId;
    visit(f.root, null, frameId, 0, 0);
    frames.push({
      id: frameId,
      name: f.name,
      slug: f.slug,
      viewport: viewportOf(f.width),
      width: r2(f.width),
      height: r2(f.height),
      screenshot: f.screenshot,
      rootId: f.root.id,
    });
  }

  // Assets: canonicalise duplicates, check existence, flag what the tree references but the export lacks.
  const assets = {};
  for (const key of [...usedAssets].sort()) {
    const a = bundle.assets[key];
    if (!a) {
      issue('ASSET_MISSING', 'error', key.split(':').slice(0, -1).join(':'), `Asset ${key} referenced but not in export`);
      continue;
    }
    if (!a.exists) issue('ASSET_FILE_MISSING', 'error', null, `Asset file missing for ${key}: ${a.file}`);
    assets[key] = { ...a };
  }

  // Fonts used in text runs vs the export's availability report.
  const fontUse = {};
  for (const n of Object.values(nodes)) for (const r of n.text?.runs || []) {
    const k = r.family;
    fontUse[k] ??= { family: k, styles: new Set(), weights: new Set(), count: 0 };
    fontUse[k].styles.add(r.style);
    fontUse[k].weights.add(r.weight);
    fontUse[k].count++;
  }
  const fonts = Object.values(fontUse).map((f) => {
    const rep = bundle.fonts.find((x) => x.family === f.family);
    const out = { family: f.family, styles: [...f.styles].sort(), weights: [...f.weights].sort(), runs: f.count, missingInExport: rep ? !!rep.missing : null };
    if (out.missingInExport) issue('FONT_MISSING', 'error', null, `Font "${f.family}" was missing on the exporting machine; the reference screenshot may itself use a fallback, and the site needs the font files`);
    return out;
  });

  return {
    schema: IR_SCHEMA,
    source: { adapter: bundle.adapter, inputPath: bundle.inputPath, inputHash: bundle.inputHash, ...bundle.meta },
    page: { slug: slug || bundle.frames[0]?.slug },
    frames,
    nodes,
    assets,
    fonts,
    interactions,
    issues,
  };
}

// Helpers used across stages.
export const childrenOf = (ir, id) => ir.nodes[id].children.map((c) => ir.nodes[c]);
export function* walk(ir, id, depth = 0) {
  const n = ir.nodes[id];
  yield [n, depth];
  for (const c of n.children) yield* walk(ir, c, depth + 1);
}
