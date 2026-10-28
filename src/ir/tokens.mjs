// Token registry: collects the design's reusable values with usage counts and node bindings.
// The figma-ir/1 export carries no variables, so tokens are derived by frequency; a value used
// once stays a literal (recorded as an exception, not promoted to a global).
import { round } from '../util/core.mjs';

const norm = (c) => (c || '').toLowerCase();

export function collectTokens(ir, { minUses = 2 } = {}) {
  const colors = new Map();
  const type = new Map();
  const spacing = new Map();
  const radii = new Map();
  const bump = (map, key, nodeId, extra) => {
    if (!map.has(key)) map.set(key, { value: key, uses: 0, nodes: [], ...extra });
    const e = map.get(key);
    e.uses++;
    if (e.nodes.length < 50) e.nodes.push(nodeId);
  };

  for (const n of Object.values(ir.nodes)) {
    if (n.a?.role === 'asset-part') continue;
    for (const f of n.fills) if (f.type === 'solid') bump(colors, norm(f.color), n.id);
    if (n.stroke?.color) bump(colors, norm(n.stroke.color), n.id);
    for (const r of n.text?.runs || []) {
      bump(colors, norm(r.color), n.id);
      const key = `${r.family}|${r.weight}|${r.italic ? 'i' : 'n'}|${r.size}|${round(r.lineHeight ?? 0, 1)}|${round(r.letterSpacing, 2)}|${r.textCase}`;
      bump(type, key, n.id, { family: r.family, weight: r.weight, italic: r.italic, size: r.size, lineHeight: r.lineHeight, letterSpacing: r.letterSpacing, textCase: r.textCase });
    }
    if (n.layout) {
      if (n.layout.gap) bump(spacing, n.layout.gap, n.id);
      for (const p of n.layout.padding) if (p) bump(spacing, p, n.id);
    }
    if (n.radius) for (const r of new Set(n.radius)) if (r) bump(radii, r, n.id);
  }

  const finish = (map, prefix, sortKey) => {
    const arr = [...map.values()].sort(sortKey);
    let i = 0;
    for (const e of arr) e.id = e.uses >= minUses ? `${prefix}-${++i}` : null;
    return arr;
  };
  const color = finish(colors, 'color', (a, b) => b.uses - a.uses || String(a.value).localeCompare(String(b.value)));
  const typeStyles = finish(type, 'type', (a, b) => b.size - a.size || b.uses - a.uses);
  return {
    schema: 'f2d-tokens/1',
    colors: color,
    type: typeStyles,
    spacing: finish(spacing, 'space', (a, b) => a.value - b.value),
    radii: finish(radii, 'radius', (a, b) => a.value - b.value),
  };
}

// CSS custom properties for every promoted token (used by both compilers).
export function tokenCss(tokens, scope = ':root') {
  const lines = [];
  for (const c of tokens.colors) if (c.id && /^#|^rgba?\(/.test(c.value)) lines.push(`  --f2d-${c.id}: ${c.value};`);
  for (const s of tokens.spacing) if (s.id) lines.push(`  --f2d-${s.id}: ${s.value}px;`);
  for (const r of tokens.radii) if (r.id) lines.push(`  --f2d-${r.id}: ${r.value}px;`);
  return lines.length ? `${scope} {\n${lines.join('\n')}\n}\n` : '';
}

export const colorToken = (tokens, value) => tokens.colors.find((c) => c.value === norm(value) && c.id)?.id || null;
