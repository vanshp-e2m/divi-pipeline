// Geometry diagnosis ("Agent C" deterministic core): rendered element boxes vs IR boxes.
import { round } from '../util/core.mjs';
import { visualBox } from '../ir/analyze.mjs';

// Compare at a design-frame width. `geometry` is the render's element list keyed by class.
export function compareGeometry(ir, frame, geometry, { tolPx = 6, tolRatio = 0.03 } = {}) {
  const byCls = new Map();
  for (const g of geometry) if (!byCls.has(g.cls)) byCls.set(g.cls, g);
  const root = ir.nodes[frame.rootId];
  const ox = root.box.x, oy = root.box.y;
  const rows = [];
  // Not visible in the design (entirely outside a clipping ancestor, e.g. a hover-animation copy
  // parked off-canvas): there is nothing to compare.
  const clippedAway = (n) => {
    for (let p = n.parent; p; p = ir.nodes[p]?.parent) {
      const a = ir.nodes[p];
      if (!a?.clips) continue;
      const b = n.box, c = a.box;
      if (b.x >= c.x + c.w || b.x + b.w <= c.x || b.y >= c.y + c.h || b.y + b.h <= c.y) return true;
    }
    return false;
  };
  for (const n of Object.values(ir.nodes)) {
    if (n.frameId !== frame.id || n.a?.role === 'asset-part' || n.a?.role === 'page') continue;
    if (clippedAway(n)) continue;
    const g = byCls.get(n.cls);
    const exp = visualBox(n, ir.assets?.[n.asset]);
    if (!g) {
      rows.push({ id: n.id, cls: n.cls, name: n.name, role: n.a?.role, missing: true, decor: !!n.a?.decor });
      continue;
    }
    const dx = g.x - (exp.x - ox), dy = g.y - (exp.y - oy), dw = g.w - exp.w, dh = g.h - Math.max(exp.h, 1);
    const tolW = Math.max(tolPx, exp.w * tolRatio), tolH = Math.max(tolPx, exp.h * tolRatio);
    const ok = Math.abs(dx) <= tolPx && Math.abs(dy) <= tolPx && Math.abs(dw) <= tolW && Math.abs(dh) <= tolH;
    rows.push({ id: n.id, cls: n.cls, name: n.name, role: n.a?.role, depth: n.depth, decor: !!n.a?.decor, area: exp.w * exp.h, exp: { x: exp.x - ox, y: exp.y - oy, w: exp.w, h: exp.h }, got: { x: round(g.x), y: round(g.y), w: round(g.w), h: round(g.h) }, d: { x: round(dx), y: round(dy), w: round(dw), h: round(dh) }, ok, visible: g.visible });
  }
  const measured = rows.filter((r) => !r.missing && !r.decor && r.visible !== false);
  const totalArea = measured.reduce((s, r) => s + Math.sqrt(r.area || 1), 0);
  const okArea = measured.filter((r) => r.ok).reduce((s, r) => s + Math.sqrt(r.area || 1), 0);
  return {
    score: totalArea ? round(okArea / totalArea, 4) : 0,
    elements: measured.length,
    inTolerance: measured.filter((r) => r.ok).length,
    missing: rows.filter((r) => r.missing && !r.decor).map((r) => ({ id: r.id, name: r.name, role: r.role })),
    rows,
  };
}

// Root causes: an element whose own offset differs from its parent's offset introduced the
// error; descendants that merely inherit the shift are not reported separately.
export function rootCauses(ir, geo, limit = 25) {
  const byId = new Map(geo.rows.filter((r) => !r.missing).map((r) => [r.id, r]));
  const causes = [];
  for (const r of byId.values()) {
    if (r.ok || r.decor) continue;
    const p = ir.nodes[r.id].parent && byId.get(ir.nodes[r.id].parent);
    const ix = p ? r.d.x - p.d.x : r.d.x, iy = p ? r.d.y - p.d.y : r.d.y;
    const own = Math.abs(ix) > 3 || Math.abs(iy) > 3 || Math.abs(r.d.w) > Math.max(6, r.exp.w * 0.03) || Math.abs(r.d.h) > Math.max(6, r.exp.h * 0.03);
    if (own) causes.push({ ...r, introduced: { x: round(ix), y: round(iy), w: r.d.w, h: r.d.h }, impact: Math.sqrt(r.area || 1) * (Math.abs(iy) + Math.abs(ix) + Math.abs(r.d.h) + Math.abs(r.d.w)) });
  }
  return causes.sort((a, b) => b.impact - a.impact).slice(0, limit);
}
