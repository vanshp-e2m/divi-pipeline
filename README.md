# figma2divi

Figma design → normalized IR → HTML preview → **native, editable Divi 4 page**, built by a
deterministic compiler and QA'd the DEV Connect way: objective functional checks, then the `f2d-qa`
agent judges every section against Figma (diff, side-by-side, measurements, contact sheets at every
width), fixes it through repairs, recaptures, verifies and locks it, and writes the verdict.

Desktop-only designs still get deliberate layouts on every tier of the DEV Connect responsive ladder
(widescreen 4K containment, desktop, laptop ≤1366, tablet-extra ≤1200, Divi tablet ≤980, mobile-extra
≤880, Divi phone ≤767), an always-sticky header, 44×44 tap targets and hover/focus on every button; QA
looks at every section from 3840 down to 320 and in landscape. Recognised
components work out of the box: a hamburger menu on small screens, accordions, sliders, tickers and
swipeable card strips (behaviour from `wp-plugin/f2d-bridge/assets/f2d-runtime.js`; keep the bridge
plugin on the site up to date when you update this folder).

Packaged as a Claude Code plugin (`/figma2divi:figma-to-divi` skill, `f2d-planner` and
`f2d-qa` agents) around a deterministic CLI, `f2d`.

## Install (Claude Code)

Unzip the folder anywhere (e.g. `C:\tools\figma2divi`), then in that folder:

```bash
npm install                          # dependencies (ajv, playwright, pngjs, pixelmatch, ssim.js)
npx playwright install chromium      # the browser QA renders with
npm test                             # optional: unit tests should all pass
claude plugin marketplace add "C:\tools\figma2divi"     # the folder you unzipped to
claude plugin install figma2divi@f2d-local
```

Restart Claude Code, open it in your project folder and type **`/figma2divi:start`** — one short form (IR export, Figma link + token, font files, target OS),
one paste message if needed, then the whole pipeline runs by itself.
Or ask it to build a page from your Figma export (the `figma-to-divi` skill
takes over), or run the CLI directly (below).

## Quick start for a new site (what the skill walks you through)

1. **Use a local / staging WordPress, never production**, with the **Divi Builder plugin 4.2x** active
   (verified with 4.27.7 on a Twenty Twenty-Five site).
2. Copy `wp-plugin/f2d-bridge` into the site's `wp-content/plugins/` and activate it.
3. Make an empty project folder next to the site (e.g. `<site>/f2d-project`) and from inside it:
   `node <plugin>/bin/f2d.mjs init --os windows --site http://localhost:PORT --page home --input C:/path/home-ir.zip`
   — `--os` is the OS the site's visitors/testers use (`windows` | `macos` | `both`); it changes how
   QA measures scrollbars, so it is never assumed.
4. Wire WP-CLI in `f2d.config.json → site.wp` (see below), then run `f2d doctor` until every check is OK.
5. `f2d run home` (or ask Claude to "build the home page with figma2divi"). The page is deployed as a
   **draft**; the report lands in `pages/home/reports/final-report.md`, QA evidence in `pages/home/qa/`.

### WP-CLI on a Local (by Flywheel) site

`site.wp` tells f2d how to run WP-CLI: `{ "php": <php.exe>, "ini": <php ini>, "phar": <wp-cli.phar>, "path": <WordPress root> }`
(relative paths resolve from the project folder). With Local on Windows:

| Key | Where |
|---|---|
| `php` | `%APPDATA%/Local/lightning-services/php-<version>/bin/win64/php.exe` (the site's PHP version) |
| `ini` | a copy of the site's rendered `php.ini` from `%APPDATA%/Local/run/<site id>/conf/php/`, kept in the project (e.g. `.env-local/php-cli.ini`); `extension_dir` must point at that PHP's `ext` folder and `mysqli.default_port` / `pdo_mysql.default_port` must be the site's MySQL port (Local → site → Database) |
| `phar` | `%LOCALAPPDATA%/Programs/Local/resources/extraResources/bin/wp-cli/wp-cli.phar` |
| `path` | the site's `app/public` folder |

`f2d doctor` reports exactly which of these fails. Keep the Local site running while f2d works.
Secrets (a Figma token, if used) go in an env file referenced by `figma.envFile`, never in the config.

## Requirements

- Node 20+ (tested on 24), `npm install` in this folder; Chromium for Playwright (`npx playwright install chromium` if `f2d doctor` reports it missing).
- A **local / development / staging** WordPress with the **Divi Builder plugin 4.2x** (verified with 4.27.7) and WP-CLI.
- The companion WordPress plugin in `wp-plugin/f2d-bridge` (copy into `wp-content/plugins/` and activate).
- A Figma IR export (`figma-ir/1` zip or folder with `ir.json`, `assets/`, `screenshots/`). A Figma REST token is optional (used only to fetch video-fill poster frames; responses are cached).

## Setup (per site)

```bash
mkdir my-project && cd my-project
f2d init --os windows --site http://localhost:PORT --page home --input ./home-ir.zip   # ask the user which OS!
# edit f2d.config.json → site.wp { php, ini, phar, path } so f2d can run WP-CLI against the site
f2d doctor
```

`f2d` = `node <plugin>/bin/f2d.mjs`. **Target OS is mandatory and asked per site**: Windows classic
scrollbars take ~15–17px of layout width (QA renders with them visible and compensates when
comparing pixels); macOS overlay scrollbars take none.

## Run

```bash
f2d run home                    # analyze → plan → build → deploy draft → functional checks; then launch the f2d-qa agent
f2d run home --resume           # after the agent's verdict: functional checks on the final build → report
f2d report home                 # pages/home/reports/final-report.md
```

Individual stages: `analyze`, `plan` (`plan validate`, `plan amend`), `build`, `deploy`, `check`; the agent's
instruments `shot`, `measure`, `sweep`, `qa-state`; `qa` (legacy scripted metrics, diagnostic only),
`fix-context`, `repair --auto | --apply FILE | --revert ID`, `ledger`, `rollback --build ID`,
`fonts probe`, `calibrate`. Every command prints JSON.

## Configuration (`f2d.config.json`)

| Key | Meaning |
|---|---|
| `target.os` | `windows` \| `macos` \| `both` (scrollbar mode for QA) |
| `site.url`, `site.wp` | site URL; how to run WP-CLI (`php`, `ini`, `phar`, `path`) |
| `site.allowPublish`, `publish.status` | drafts only unless both say publish (explicit approval) |
| `pages.<slug>` | `input`, `title`, `wpSlug` |
| `fonts.substitutions.<Family>` | `{ substitute, css, reason }` interim stand-in, or `{ files }` for real font files |
| `viewports.extra` | extra QA widths besides the design frames (default: the DEV Connect list 3840 … 320) |
| `viewports.landscape` | rotated views `[width, height]` (default 844×390, 932×430, 1024×768, 1180×820, 1366×1024) |
| `qa.passes`, `qa.maxPasses` | 3 mandatory passes; budget incl. one recovery pass |
| `qa.thresholds` | visual 0.85, section floor 0.70, geometry 0.80, structure/responsive/runtime 1.0, interaction 0.9 |
| `qa.weights` | visual metric weights (calibrated; see `docs/SCORING.md`) |
| `qa.masks` | regions with dynamic content to ignore |

## What gets produced (per page, `pages/<slug>/`)

`input-manifest.json`, `ir.json`, `tokens.json`, `assets.json`, `build-plan.json` (+ `plan-history/`),
`repairs.json`, `ledger.json`, `builds/<id>/` (preview, Divi layout, scoped CSS, manifest, deploy record),
`qa/<build>/pass-<n>/` (report.json, report.md, screenshots, diffs, overlays, side-by-sides),
`reports/final-report.md`.

## Docs

- `docs/ARCHITECTURE.md` — pipeline, contracts, mapping strategy, QA suite, repair loop.
- `docs/DIVI4-NOTES.md` — verified Divi 4.27.7 storage/CSS facts the adapter relies on.
- `docs/SCORING.md` — visual metric definition and its experimental validation.
- `docs/PROGRESS.md` — build log / status.

## Tests

```bash
npm test                                   # unit (IR, layout, Divi mapping, repairs, ledger, scoring)
npm run test:integration                   # browser rendering, overlap/overflow detectors
F2D_PROJECT=<project dir> node --test tests/integration/wordpress.test.mjs   # WP draft/readback/rollback round trip
```
