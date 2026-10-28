// Dev tool: computed box + CSS of named IR nodes (and their ancestors) on the deployed page at a width.
// node tests/tools/probe.mjs <projectDir> <slug> <width> "Name A" "1:234" ...   (names or node ids)
import fs from 'node:fs';
import path from 'node:path';
import { launch, scrollbarWidth, capture, release } from '../../src/qa/render.mjs';

const [projectDir, slug, width, ...names] = process.argv.slice(2);
const P = path.join(projectDir, 'pages', slug);
const st = JSON.parse(fs.readFileSync(path.join(P, 'state.json'), 'utf8'));
const ir = JSON.parse(fs.readFileSync(path.join(P, 'ir.json'), 'utf8'));
const targets = names.map((nm) => ir.nodes[nm] || Object.values(ir.nodes).find((n) => n.name === nm)).filter(Boolean);
const b = await launch('classic');
const sb = await scrollbarWidth(b);
const r = await capture(b, st.post.previewUrl, { width: Number(width), match: 'window', scrollbar: sb, collect: false });
for (const t of targets) {
  console.log(`== ${t.name} (${t.id}) IR ${JSON.stringify(t.box)} role=${t.a.role}`);
  console.log(await r.page.evaluate((cls) => {
    const el = document.querySelector('.' + cls);
    if (!el) return '  NOT IN DOM';
    const out = [];
    let e = el;
    for (let i = 0; i < 4 && e; i++, e = e.parentElement) {
      const c = getComputedStyle(e), q = e.getBoundingClientRect();
      out.push(`  ${'  '.repeat(i)}${e.tagName}.${[...e.classList].filter((x) => /f2d-|et_pb_(section|row|column|module)/.test(x)).slice(0, 2).join('.')} x${Math.round(q.left)} y${Math.round(q.top + scrollY)} ${Math.round(q.width)}x${Math.round(q.height)} disp=${c.display} dir=${c.flexDirection} pos=${c.position} w=${c.width} maxw=${c.maxWidth} flex=${c.flex} order=${c.order} ov=${c.overflow} tf=${c.transform}`);
    }
    return out.join('\n');
  }, t.cls));
}
await release(r);
await b.close();
