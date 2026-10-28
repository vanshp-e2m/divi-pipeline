// Page workspace layout under <project>/pages/<slug>/ — one place for every artifact.
import path from 'node:path';
import fs from 'node:fs';
import { readJsonIf } from './util/core.mjs';

export function ws(cfg, slug) {
  const root = path.join(cfg.projectDir, 'pages', slug);
  const p = (...a) => path.join(root, ...a);
  return {
    slug,
    root,
    inputs: p('inputs'),
    fills: p('inputs', 'fills'),
    inputManifest: p('input-manifest.json'),
    ir: p('ir.json'),
    tokens: p('tokens.json'),
    assets: p('assets.json'),
    media: p('media.json'),
    plan: p('build-plan.json'),
    planHistory: p('plan-history'),
    repairs: p('repairs.json'),
    ledger: p('ledger.json'),
    state: p('state.json'),
    fontProbe: p('font-probe.json'),
    builds: p('builds'),
    build: (id) => p('builds', id),
    qa: (id, pass) => p('qa', id, `pass-${pass}`),
    reports: p('reports'),
  };
}

export const loadState = (w) => readJsonIf(w.state, { schema: 'f2d-state/1', builds: [], passes: [], post: null });

export function listBuilds(w) {
  if (!fs.existsSync(w.builds)) return [];
  return fs.readdirSync(w.builds).filter((d) => fs.existsSync(path.join(w.builds, d, 'manifest.json'))).sort();
}
