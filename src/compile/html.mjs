// Compiler A: box tree -> standalone HTML/CSS preview (+ manifest entries).
// The preview is a diagnostic ceiling: same layout decisions as the Divi build, no Divi wrappers.
import { fileURLToPath } from 'node:url';
import { boxCss, lintCss, runtimeCss, BASE_TEXT_CSS, FOCUS_CSS } from '../layout/engine.mjs';

// The component runtime the WordPress bridge enqueues; the preview loads the same file (copied next to
// index.html) so both outputs behave alike.
export const RUNTIME_FILE = fileURLToPath(new URL('../../wp-plugin/f2d-bridge/assets/f2d-runtime.js', import.meta.url));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function renderHtml(tree, { title = 'f2d preview', fontCss = '', tokenCss = '' } = {}) {
  const manifest = [];
  const html = (b, depth) => {
    const pad = '  '.repeat(depth);
    manifest.push({ id: b.id, cls: b.cls, kind: b.kind, tag: b.tag });
    const aria = b.ariaHidden ? ' aria-hidden="true"' : '';
    const hk = b.hooks?.length ? ' ' + b.hooks.join(' ') : ''; // runtime hooks (f2d-menu-panel …)
    if (b.kind === 'control') return `${pad}<button type="button" class="${b.cls}${hk}"${aria}>${b.html}</button>`;
    if (b.tag === 'img') return `${pad}<img class="${b.cls}${hk}" src="${esc(b.src)}" alt="${esc(b.alt || '')}" width="${Math.round(b.w)}" height="${Math.round(b.h)}" loading="${b.eager ? 'eager' : 'lazy'}"${aria}>`;
    if (b.kind === 'text') return `${pad}<${b.tag} class="${b.cls}${hk}"${aria}>${b.html}</${b.tag}>`;
    const tag = b.kind === 'button' ? 'a' : b.section ? 'section' : 'div';
    const href = b.kind === 'button' ? ` href="${esc(b.href || '#')}"` : '';
    const inner = b.children.map((c) => html(c, depth + 1)).join('\n');
    return `${pad}<${tag} class="${b.cls}${hk}"${href}${aria} data-f2d="${esc(b.name)}">\n${inner}\n${pad}</${tag}>`;
  };
  const body = html(tree.root, 1);
  const css = [
    fontCss, // @import / @font-face must come first or browsers drop it
    '*, *::before, *::after { box-sizing: border-box; }',
    'html, body { margin: 0; padding: 0; }',
    'img { display: block; }',
    'a { color: inherit; text-decoration: none; }',
    tokenCss,
    BASE_TEXT_CSS,
    FOCUS_CSS,
    runtimeCss('', tree.root.menuAt),
    boxCss(tree.root),
  ].join('\n');
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="style.css">
<script>document.documentElement.classList.add('f2d-js');</script>
</head>
<body>
${body}
<script src="f2d-runtime.js"></script>
</body>
</html>
`;
  return { html: doc, css, manifest };
}

export const lintPreview = (css, os) => lintCss(css, { os });
