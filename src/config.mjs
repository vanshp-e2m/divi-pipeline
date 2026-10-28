// Project configuration: f2d.config.json in the project directory, merged over defaults.
import path from 'node:path';
import fs from 'node:fs';
import { readJsonIf, F2DError } from './util/core.mjs';

export const DEFAULTS = {
  schema: 'f2d-config/1',
  site: {
    url: null, // e.g. http://localhost:10119
    environment: 'local', // local | development | staging | production
    allowPublish: false, // drafts only unless explicitly approved
    wp: null, // { php, ini, phar, path } — how to run WP-CLI against the site
  },
  // Asked per site at init, never assumed: Windows classic scrollbars take layout width, macOS overlay ones do not.
  target: { os: null }, // 'windows' | 'macos' | 'both'
  divi: { version: 'auto', breakpoints: { tablet: 980, phone: 767 } },
  pages: {},
  fonts: {
    // family -> { substitute, reason } or { files: [...] } ; missing fonts are reported, never silently swapped
    substitutions: {},
  },
  viewports: {
    // Design frames are added automatically; these are the extra widths QA always tests (the DEV Connect
    // list: 4K containment 3840…1920, the ladder edges on both sides, common devices down to 320).
    // The build's own breakpoints are added on both sides at QA time.
    extra: [3840, 2560, 2401, 2400, 2000, 1920, 1680, 1440, 1367, 1366, 1280, 1201, 1200, 1024, 981, 980, 960, 881, 880, 768, 767, 600, 480, 414, 390, 375, 360, 320],
    // Rotated views (width × height): phones and tablets in landscape.
    landscape: [[844, 390], [932, 430], [1024, 768], [1180, 820], [1366, 1024]],
    // Widths at which every section is screenshotted in every QA pass (plus every design frame).
    sectionShots: [768, 390], // major viewports: tablet + mobile (desktop design frames are always included)
    viewportHeight: 900,
  },
  qa: {
    passes: 3,
    maxPasses: 4, // retry budget: the three mandatory passes + one recovery pass
    deviceScaleFactor: 1,
    settleMs: 600,
    assetTimeoutMs: 15000,
    thresholds: {
      visual: 0.85, // page-level visual score per design frame
      visualSectionFloor: 0.7, // no section below this
      geometry: 0.8,
      structure: 1.0,
      responsive: 1.0, // fraction of viewport cells with zero critical/major responsive defects
      interaction: 0.9,
      runtime: 1.0,
    },
    // Selected by "f2d calibrate" (docs/SCORING.md): 6 of 45 weightings separate noise from defects at 0.85.
    weights: { ssim: 0.3, pixel: 0.25, edge: 0.3, color: 0.15 },
    geometryTolerance: { px: 6, ratio: 0.03 },
    masks: [], // [{ frame, x, y, w, h, reason }]
  },
  publish: { status: 'draft' },
};

function merge(a, b) {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== 'object' || typeof b !== 'object' || !a || !b) return b === undefined ? a : b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = merge(a[k], b[k]);
  return out;
}

export function findProjectDir(start = process.cwd()) {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, 'f2d.config.json'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export function loadConfig(projectDir) {
  const p = path.join(projectDir, 'f2d.config.json');
  const user = readJsonIf(p);
  if (!user) throw new F2DError('E_NO_CONFIG', `No f2d.config.json in ${projectDir}. Run "f2d init" first.`);
  const cfg = merge(DEFAULTS, user);
  cfg.projectDir = projectDir;
  if (!['windows', 'macos', 'both'].includes(cfg.target.os)) {
    throw new F2DError('E_TARGET_OS', 'target.os is not set. Ask the user which OS the site targets (windows | macos | both) and run "f2d config set target.os <value>".');
  }
  return cfg;
}

// Scrollbar modes QA must render under for this target.
export const scrollbarModes = (cfg) => (cfg.target.os === 'both' ? ['classic', 'overlay'] : [cfg.target.os === 'windows' ? 'classic' : 'overlay']);

export function pageConfig(cfg, slug) {
  const pc = cfg.pages[slug];
  if (!pc) throw new F2DError('E_NO_PAGE', `Page "${slug}" is not in f2d.config.json (known: ${Object.keys(cfg.pages).join(', ') || 'none'})`);
  return { slug, title: slug, ...pc };
}

export const pageDir = (cfg, slug) => path.join(cfg.projectDir, 'pages', slug);
