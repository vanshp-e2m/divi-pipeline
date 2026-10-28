# figma2divi — Architecture

Status: design v1 (written before the compilers; updated as stages land).

## 0. What exists / what this replaces

Inspected 2026-10-21:

| Item | Finding |
|---|---|
| Site | Local by Flywheel `divi-auto`, WordPress 7.1.3, PHP 8.2.29, MySQL 8.4 (:10120), nginx `http://localhost:10119`, theme Twenty Twenty-Five (block theme) |
| Divi | Divi Builder **plugin** 4.27.7 installed from `Desktop/builder/divi-builder.zip` (Divi 4 = shortcode layouts in `post_content`; no Divi theme) |
| Old pipeline | `divi-v2` Claude plugin — uninstalled at the user's request. Not read, not reused. This is a from-scratch build. |
| Input | `figma-ir/1` export (`homepage-v2-ir.zip`): 1 frame 1920×12529, 669 nodes, 139 assets (34 png / 105 svg), 1 reference PNG at 1x, hover/click states on 19 nodes. Figma REST access (file `vhQU4jjLxqSIGPCsCnFeir`) verified. |
| Gaps in input | Fonts `Designer` and `Helvetica` flagged missing in export and not installed locally; hero uses a **video fill** with no exported asset; only a desktop frame (no tablet/phone design). |
| Tooling | Node 24, Python 3.12, Playwright 1.64.1 + Chromium, WP-CLI (bundled with Local). |

## 1. Pipeline

```
figma-ir zip / Figma REST ─► ingest ─► normalize (f2d-ir/1) ─► analyze (roles, sections, tokens, assets, risks)
                                                                     │
                                                         PLANNER ─► build-plan.json (validated vs capabilities)
                                                                     │
                                         layout engine (shared box tree + CSS decisions, one per build)
                                              │                                    │
                                   Compiler A: HTML/CSS preview          Compiler B: Divi 4 adapter
                                   (diagnostic ceiling)                  (shortcodes + native attrs + scoped CSS)
                                              │                                    │
                                              └──── compile validation ────────────┘
                                                                     │
                                    WP bridge (f2d-bridge plugin + WP-CLI): draft page, readback, CSS cache clear, snapshots
                                                                     │
                                    functional checks (f2d check: objective, blocking)
                                                                     │
                                    f2d-qa agent, section by section: shot vs Figma ─► read diff ─► measure ─► diagnose
                                      ─► repairs.json ─► rebuild ─► redeploy ─► recapture ─► verify ─► sweep 3840→320 + rotated
                                      ─► fix on the ladder tier ─► lock   …   whole page ─► verdict.json
                                                                     │
                                    f2d run --resume: functional checks on the final build ─► report
```

Rule: **the IR plus `repairs.json` is the only source of truth.** Repairs never patch generated HTML or Divi output; they patch IR-level overrides, and both compilers regenerate from it. That keeps HTML and Divi in lock-step and every fix replayable.

## 2. Contracts (JSON schemas in `schemas/`)

| Artifact | File | Purpose |
|---|---|---|
| Config | `f2d.config.json` | site, WP-CLI, viewports, thresholds, weights, retry budget, publish mode, font substitutions |
| Normalized IR | `pages/<p>/ir.json` (`f2d-ir/1`) | node map with stable ids, frame-absolute boxes, layout, style, text runs, assets, interactions, roles, issues |
| Tokens | `pages/<p>/tokens.json` | colours / type styles / spacing / radii / shadows with usage counts and node bindings |
| Assets | `pages/<p>/assets.json` | asset key → file, hash, dims, existence, WP attachment id/url after upload |
| Build plan | `pages/<p>/build-plan.json` (`f2d-plan/1`) + `plan-history/` | Planner output (sections, strategy, module map, risks, tasks with ids/deps, viewport matrix, acceptance) |
| Repairs | `pages/<p>/repairs.json` (`f2d-repairs/1`) | ordered, ledger-linked overrides applied on top of the IR |
| Build | `pages/<p>/builds/<buildId>/` | `manifest.json`, `layout.json`, `preview/`, `divi/layout.txt`, `divi/page.css`, `deploy.json` |
| QA pass | `pages/<p>/qa/<buildId>/pass-<n>/` | `report.json` (all 6 categories), shots, diffs, overlays, side-by-sides, geometry, console logs |
| Ledger | `pages/<p>/ledger.json` (`f2d-ledger/1`) | persistent issues with stable ids, history per pass, fixes, regressions |

Build id = `<timestamp>-<sha8(ir + repairs + plan + compiler version)>`. The hash part is reproducible: same inputs give the same hash.

## 3. Mapping Figma to Divi 4 (version adapter `src/compile/divi/v4.mjs`)

* Page frame → sequence of `et_pb_section` (one per top-level band).
* Section → one or more `et_pb_row`. A vertical stack inside the section becomes several rows; a horizontal container becomes a row with columns.
* Horizontal child of a row → `et_pb_column`. Card styling (bg, radius, padding, shadow) collapses onto the column when the column has a single container child.
* Leaves → native modules: text → `et_pb_text` (heading level from type scale); image fill / raster → `et_pb_image`; vector → `et_pb_image` with an SVG upload; auto-layout pill with one label → `et_pb_button`; line → `et_pb_divider`.
* Divi 4 has no nested containers below the column, so a nested non-trivial sub-tree inside a column becomes an **HTML fragment inside `et_pb_text`**. It stays editable as HTML, is styled with scoped classes, and is recorded in the manifest as fallback `fragment` with the reason. A Code module is used only for interactive widgets with no native module.
* The Visual Builder renders the same shortcodes with its own wrappers, CSS and wpautop markup; an editor-only
  CSS block (selectors under `#et-fb-app`) makes it show the page exactly as the front end does — see
  `docs/DIVI4-NOTES.md` → Visual Builder. A builder save keeps the front end identical.
* Native attributes are always emitted for what Divi can express (editability). Scoped CSS (`.f2d-<hash>` classes, specificity just above Divi's generated rules, no `!important`) covers what Divi 4 cannot: flex layout and gaps, exact column ratios, absolute decoration, gradient text, object-fit, resetting Divi's default module margins.

## 4. QA — judged by the f2d-qa agent (the DEV Connect model)

The verdict is not computed. Following DEV Connect's `qa` agent, `section-qa-loop` and the figma→Elementor
v4 builder (Steps 7–9), the **f2d-qa agent judges the page by looking at it**, one section at a time, top to
bottom, in one continuous session, and fixes what it finds:

1. `f2d check` — **objective functional checks** (WordPress readback and build id, render, console errors,
   failed requests, layout shift, sections and text present, images load, links have targets and are
   clickable, forms present, menu / accordion / slider / ticker work, sticky header and drawer, horizontal
   overflow at every width and rotation, and **editor parity**: the page opened in the Divi Visual Builder —
   desktop view at the design width, then its own tablet and phone views — has every rendered element
   where the front end has it, as a visitor sees it). These are facts: a failure blocks PASS.
2. Per section: `f2d shot --section N` at the design width (built crop, Figma crop, red-highlight diff,
   side-by-side, `similarity_pct` with compare_screenshots.py semantics — per-channel difference > 24 —
   and the best vertical alignment within ±16px) → the agent reads the diff and side-by-side → `f2d
   measure` (built boxes and computed styles vs the IR, deltas) → diagnosis (structure → content →
   globals → geometry → widget styling → decorative) → IR repairs → rebuild + redeploy → recapture →
   verify. Similarity is evidence: the agent never locks or fails on a number alone, and records why when
   a section is locked below 98% (font substitute metrics, unexported assets, anti-aliasing).
3. Per section: `f2d sweep --section N` — the section at every width 3840 → 320 and every rotated view on
   labelled contact sheets, with measured hints (overflow, overlap, cut, covered, broken words, spill,
   tap targets, orphan words, uneven cards, lonely last card, distorted images, collapsed content, cramped
   edges, sticky/drawer). The agent judges the sheets ("looks intentional", 4K containment, stacking order),
   fixes each break on the ladder tier covering it, re-sweeps the broken widths and their neighbours, and
   locks the section — at most 3 rounds, then `incomplete` with open issues by width.
4. Whole page, `f2d qa-state validate` (every lock must be backed by evidence on disk), and
   `qa/agent/verdict.json`: PASS / FAIL / BLOCKED (BLOCKED = could not observe; never a soft FAIL).
   `f2d run --resume` re-runs the functional checks on the final build and writes the report.

The compiler stays deterministic: the agent changes the page only through repairs (applied to the box tree,
so both compilers agree) and reports systemic causes as `compiler_findings`.

### Legacy scripted metrics (`f2d qa`, diagnostic only)

The earlier scored suite is kept as a diagnostic; it no longer decides anything.


| Cat | Measured how | Score |
|---|---|---|
| A Structure | readback shortcode tree, parse validity, every IR section/text/asset present in DOM by class, order, duplicates, theme header/footer absent, no raw `[et_pb_` text | fraction of checks passing; any critical → gate fail |
| B Geometry | `.f2d-*` bounding boxes vs IR boxes at design widths (tolerance max(6px, 3%)), section heights, column ratios | fraction of elements in tolerance (area-weighted) |
| C Visual | screenshot vs reference PNG: SSIM (k1 0.05), pixel mismatch (pixelmatch), edge-map similarity, colour histogram; full page + per section (section crops aligned by DOM position) | weighted ssim .30 / pixel .25 / edge .30 / colour .15 — selected by calibration, see SCORING.md |
| D Responsive | the DEV Connect matrix: every design frame + 3840, 2560, 2401/2400, 2000, 1920, 1680, 1440, 1367/1366, 1280, 1201/1200, 1024, 981/980, 960, 881/880, 768/767, 600, 480, 414, 390, 375, 360, 320 + **both sides of every breakpoint the build emits** + rotated views 844×390, 932×430, 1024×768, 1180×820, 1366×1024. Per cell: horizontal overflow, content cut / covered / overlapping / collapsed to 0px / spilling into the next section, mid-word breaks, squeezed text, dead side gutters, distorted images, tap targets < 44×44 (≤767), and the "looks intentional" checks (orphan words in headings, uneven card heights, a lonely last grid item, cramped edges ≤360). ≥1920: **4K containment** per section (full-bleed background, content span ≤1920, centred like the design, same height at 3840 as at 1920). Desktop, 1024, 768, 390 and every rotated view: **sticky header** (pinned at 50% and the bottom, above the content, ≤ ~20% of the screen when compact) and the **drawer** (opens from a scrolled page, in view, fits or scrolls, closes). Full-page screenshot per cell; section screenshots; a **verdict per section** (responsive / incomplete) and `responsive-sweep.json` (section × viewport → issues); `f2d qa --section N` checks one section at every cell and locks it (`qa/section-state.json`) | fraction of viewport cells with no critical/major defect; any critical fails the gate |
| E Edge/runtime | console errors, failed requests, long-text injection, blocked images, blocked fonts, layout shift (CLS), stale Divi CSS, theme style leakage | checks passing |
| F Interaction | links/buttons resolvable and not covered, hover states vs IR `states`, focus visibility, tab order, click targets for FAQ/carousel | checks passing; unknown fidelity is reported as unverified |

Visual metric validation: `f2d calibrate` perturbs a reference (shift, blur, recolour, missing block, font swap, blank) and checks the metric orders them monotonically. The results are saved under `docs/calibration.json` and quoted in the report.

Gates: page visual ≥ 0.85 per frame, no section below 0.70, geometry ≥ 0.80, and **zero open critical issues** across the viewport matrix. A high aggregate never overrides a critical issue.

## 5. Repair loop

Per section (agent): capture → read the diff → measure → diagnose → repair → rebuild → redeploy → recapture → verify → lock.
Repairs come from the `f2d-qa` agent (patches validated against the schema; legacy deterministic rules remain available as `f2d repair --auto`). A repair that does not help is reverted (`f2d repair --revert`), never repeated; the agent's state records every iteration (build, similarity, what was wrong, repair ids, result).

Responsive repairs follow the DEV Connect loop: **one section at a time**, top to bottom (header + drawer first). For each section: fix, rebuild + deploy, `f2d sweep --section N` (that section at every width and rotation), re-check the broken widths and their neighbours; at most 3 rounds per section, then it is locked (`responsive`, or `incomplete` with every open issue by width). A fix goes on the ladder tier covering the width where the section breaks (`bp`: `wide | base | narrow | tabletExtra | tablet | mobileExtra | phone`; DEV Connect names `widescreen`, `laptop`, `tablet_extra`, `mobile_extra` are accepted), never on a narrower one.

## 5b. Responsive compilation without tablet/phone frames

Responsiveness is decided by the layout engine (`applyResponsive`, `applyInteractive`, `applyFinish`) for every box, from the IR's structure, and read back into `build-plan.json → responsive` by the planner (`src/planner/responsive.mjs`: the ladder, and per section the tiers it uses, row behaviour per tier, stepped type, the 4K approach, the sticky header), so the plan states exactly what the compiler emits.

The tiers are the **DEV Connect responsive ladder** (from the figma→Elementor v4 builder), with Divi's own tablet (980) and phone (767) edges in place of Elementor's 1024/767. Every rule sits on one tier; a break found at any other width is **snapped up to the tier covering it** — never squeezed into a narrower tier, never a per-row breakpoint. Widest first (later tiers override):

| Tier (`box.css` key) | DEV Connect name | Media | What changes |
|---|---|---|---|
| `wide` | widescreen | `min-width: max(design, 1920) + 1` | **4K containment**: backgrounds stay full-bleed, content keeps the column it has at 1920, centred (`padding: … calc(50% − 960px + gutter)` on the box carrying the background; placed items offset from the column; split sections keep the picture half bleeding to its edge and grow it by the extra margin, `100cqw` = page width); full-bleed images keep their desktop height (`object-fit: cover`) |
| `base` | desktop | — | Figma geometry; content centred with fluid gutters `max(24px, (100% − content) / 2)` |
| `narrow` | laptop | `max-width: max(1366, content + 48 − 1)` (1487 for a 1440 column) | gutters tighten; fixed heights → minimums; one-line text may wrap; link/button rows wrap with gaps tightened to 32px; blocks may shrink; free compositions keep proportions; rows that cannot fit (needed below 1366…1201) become two-up grids or wrap here; design line breaks in headings are dropped so headings rewrap balanced |
| `tabletExtra` | tablet_extra | `max-width: 1200px` | 3–4 column grids two-up (equal heights, an odd last card spans the line); the compact header when the header needs it (menu breakpoint snapped to 1366/1200/980) |
| `tablet` | tablet (Divi) | `max-width: 980px` | tablet gutters and paddings, flow conversion of absolute compositions, sliders one card |
| `mobileExtra` | mobile_extra | `max-width: 880px` | rows of ≥2 content blocks **stack in reading order, text before the picture** |
| `phone` | mobile (Divi) | `max-width: 767px` | single column, phone gutters, rotated connectors, buttons may take the full line, **44×44 tap targets** |

Type uses **explicit stepped sizes** per tier (no `clamp()`, `vw` or `cqw`): ×1 laptop / tablet-extra, ×0.72 tablet, ×0.62 mobile-extra, ×0.52 phone (never below 24px for display sizes), each capped so the longest word fits the tier's narrowest width at the text's share of the line there (half in a two-up cell, the full line once its row stacks), and never larger than on the wider tier. Headings balance their lines (`text-wrap: balance`), body text avoids a lone last word (`pretty`).

Page-wide UX rules (DEV Connect "pixel-perfect, then good UX"): the header is **always sticky** (promoted out of the hero into its own section when it is nested there; `position: sticky; top: var(--wp-admin--admin-bar--height, 0px)`; the page root clips only sideways so no ancestor is a scroll container); when compact it is a slim bar (logo sized by height) and its other bars (a contact strip) move into the drawer, which drops into the header's flow and scrolls inside the screen when taller; every button has hover/focus (derived from its own colour when the design has none: `brightness()`); phones get 44×44 tap targets.

Content minimums come from the IR (one-line text by character count, 0.85em per capital; buttons/vectors keep their width; only carousel strips, rolling digits and clipping containers whose children really overflow may shrink below their content). Widgets that keep their own structure are only carousel strips and counter digits; forms and accordions take every rule.

## 5c. Interactive components (runtime)

The analyzer recognises components **by structure** (layer names are unreliable) and the engine marks
them with hook classes; `wp-plugin/f2d-bridge/assets/f2d-runtime.js` (enqueued by the bridge, copied
into the HTML preview) adds behaviour. Without JavaScript every component shows the design's resting
state; the design state is written into the markup (`is-open`, `is-active`) so nothing moves when the
runtime starts, and `html.f2d-js` is set in `<head>` before first paint.

| Component | Recognised as | Behaviour |
|---|---|---|
| Nav menu | top-of-page row of ≥3 short labels (the one beside a call-to-action wins); its bar collapses | menu button (keyboard, `aria-expanded`, Escape) below a **header breakpoint computed from the header's rows** (items + gaps + the room a hanging logo takes + gutters), snapped up to the ladder (1366 / 1200 / 980); an overlay header becomes the top row; `html.f2d-menu-open` while open (the header's other bars join the drawer) |
| Accordion | column of ≥3 items headed by text + small icon; some items carry content after the heading | head toggles its panel; the closed look is **derived from a closed item** of the design (background, text colour, icon) |
| Slider | row of ≥2 equal cards + two small absolute controls at its ends | ≤980px one card at a time, controls centred below it |
| Ticker | clipped single row of text items running past the clip, no controls | continuous scroll, pauses on hover/focus, static for `prefers-reduced-motion` |
| Card strip | row of ≥3 equal cards running past its own box | one row at every width that scrolls sideways (snap); swipe row with a peek on phones |

Layout rules added for this kind of design: negative auto-layout spacing → negative margins; layered
rows (negative spacing) → content full width + colour band with its badge below desktop; frames whose
children overhang on purpose keep a real height; full-bleed frames are `width: 100%`; asymmetric padding
→ content column + proportional reserve, side art anchored to it and joining the flow below desktop;
an icon + label never wrap apart; a mark in the right part of a button stays at its right edge;
`reverse` (Figma's itemReverseZIndex) only changes paint order. QA operates every component at the design
width, 768 and 390 (`interaction.component`, critical for the menu).

## 5a. Target OS and scrollbars (asked per site)

`f2d init` refuses to continue without `--os windows|macos|both`, and the skill asks the user. Nothing defaults this.

| | Windows (`classic`) | macOS (`overlay`) |
|---|---|---|
| Chromium launch | default `--hide-scrollbars` removed, so scrollbars take layout width | scrollbars hidden (no layout width) |
| Visual comparison | the scrollbar width is **measured** (`innerWidth - documentElement.clientWidth`) and the window is widened by it, so the page area equals the Figma frame width | window = frame width |
| Responsive cells | run at real window widths with the scrollbar present: what a 1920px Windows user actually sees (1903px) | real window widths |
| Compiler lint | `100vw` / `vw`-based widths are rejected (they overflow by the scrollbar width); full-bleed uses `100%` | lint is a warning only |

`both` runs the responsive and overflow checks under both modes and scores visuals in classic mode.

## 6. Known hard problems in homepage-v2 (planner risk register seeds)

* Missing display font `Designer` → substitution with measured metric impact; ask the user for the font files.
* Hero video fill → still-frame fallback from a Figma render (tracked).
* Decorative overflow (giant gradient "SIGNPRO" / "Strong Brands" text, ellipse rings, vectors wider than the frame) → absolute decoration inside clipped sections.
* Projects carousel strip 6080px wide, testimonial carousel, FAQ accordion, contact form with file upload → interactive widgets: no exact Divi 4 equivalent for the curved strip.
* Desktop-only design → tablet/phone behaviour inferred and documented, not "matched".
