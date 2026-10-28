# figma2divi: progress and handoff

> **2026-10-23 (later): 0.3.0 — DEV Connect approach for responsiveness and QA.**
> - Build (deterministic compiler): the DEV Connect responsive ladder with Divi's edges (widescreen 4K
>   containment / desktop / laptop ≤1366 / tablet-extra ≤1200 / tablet ≤980 / mobile-extra ≤880 /
>   phone ≤767), fixes snapped to the tier covering a break, explicit stepped type, rows stacking
>   text-first from 880, two-up grids by 1200 with equal heights, an always-sticky header (promoted to
>   its own section, slim compact bar, contact strip in the drawer), 44×44 tap targets, derived
>   hover/focus, split sections bleeding to their edge above 1920.
> - QA (the DEV Connect model): the **f2d-qa agent judges** section by section — capture vs Figma (diff,
>   side-by-side), measure, diagnose, repair, rebuild/redeploy, recapture, verify, sweep every width
>   3840 → 320 + rotated views, lock — and writes the verdict. `f2d check` keeps the objective
>   functional checks (they block). Scripted similarity is evidence only. `f2d run` stops at
>   `awaiting-agent-qa`; `f2d run --resume` reports. The scored suite (`f2d qa`) is legacy/diagnostic;
>   the f2d-repairer agent is folded into f2d-qa. Bridge 0.3.0 (`html.f2d-menu-open`).
> - Validation in progress on the A-ROC homepage: before/after screenshots at 1920, 2560, 1440, 1200,
>   1024, 768, 390, 844×390 under `pages/homepage/qa/compare/`.

> **2026-10-23: second design (homepage, Inter + Unbounded, desktop frame only) built end to end.**
> New in the pipeline: interactive components recognised by structure (hamburger menu below a
> header breakpoint computed per design, accordion, slider, ticker, swipeable card strips) with a
> dependency-free runtime in the bridge (0.2.0); layered rows (negative spacing), overhanging frames,
> wrap restored from child positions, asymmetric padding + side art, full-bleed `width: 100%`, Divi
> link/margin resets, outlined text; QA operates every component, detects covered/spilling text,
> restores the viewport after full-page screenshots. All 37 page-level repairs from the repairer
> agent were replaced by compiler rules (reverted, recorded). Tests: 52 unit + 24 browser.
> SignPro (homepage-v2) was removed at the user's request (files and WordPress content).

> **0.2.0 (2026-10-22): responsive compilation rework.** The run-3 page below passed QA but was
> badly laid out at tablet and narrow-desktop widths. Since then the layout engine has a narrow-desktop
> tier, per-row grids and many general fixes, and QA checks both sides of every breakpoint, with section
> screenshots at every viewport (see `docs/ARCHITECTURE.md` §4 and §5b). Verified so far: 37 unit +
> 10 responsive integration tests, and quick QA on homepage-v2 (0 critical, responsive 1.0 at
> 1920/1440/1280/1024/768/390/375, desktop visual unchanged). A full three-pass run with before/after
> evidence is in progress. Tested on one design only (homepage-v2); please report pages that break.

Last updated: 2026-10-22, end of session 2. Design: `docs/ARCHITECTURE.md`. Scoring: `docs/SCORING.md`. Divi facts: `docs/DIVI4-NOTES.md`.

## Status: end-to-end run PASSED on homepage-v2
Clean deterministic run (run 3), final build `20261022-122201-57bb2c5e`, post 96 (**draft**), Windows target:

| Metric | Final | Gate |
|---|---|---|
| Visual, full page @1920 | 0.920 | 0.85 |
| Visual, weakest section | 0.818 | 0.70 |
| Geometry | 0.917 | 0.80 |
| Structure / responsive / edge / interaction | 1.0 / 1.0 / 1.0 / 1.0 | 1 / 1 / 1 / 0.9 |
| Critical | 0 | 0 |

Report: `f2d-project/pages/homepage-v2/reports/final-report.md`. Archived runs with full history: `pages/homepage-v2/run1/` (agent-repair run that found the compiler bugs; ended "failed" with 1 critical, correctly) and `run2/` (deterministic; failed on 1 responsive cell).

## Environment (verified)
| | |
|---|---|
| Plugin | `C:\Users\Vansh Patel\figma2divi`, installed as `figma2divi@f2d-local` (reads from the source folder) |
| Project | `C:\Users\Vansh Patel\Local Sites\divi-auto\f2d-project` |
| Secrets | `f2d-project/.env-local/` (Figma token, php-cli.ini, wp.sh) |
| Site | Local "divi-auto" `http://localhost:10119` (must be running), WP 7.1.3, TT5, Divi Builder 4.27.7, f2d-bridge active |
| Figma REST | rate-limited (Starter plan, ~4.4 days from 2026-10-21); fills cached |

## Tests
22 unit + 5 browser integration + 1 WordPress round trip — all passing (`npm test`, `npm run test:integration`, `F2D_PROJECT=… node --test tests/integration/wordpress.test.mjs`). Key tests were mutation-checked (they fail when the fix is removed).

## Open / next
- "Designer" font files + licence (question to user). Audiowide is an interim, measured substitute; the biggest remaining visual gap.
- Native-module share: 38 of 81 modules are HTML fragments (Divi 4 nesting limit). Candidates: FAQ → `et_pb_toggle`, contact form → `et_pb_contact_form`.
- Interactions not in the export: carousel motion, accordion open/close, form submission, counter animation — rendered static, reported as unverified.
- Tablet/phone are inferred (no frames in the design); verified for overflow/overlap/clipping at 1440…320, not against a design.
- Visual metric margin at 0.85 is thin (0.002); the gate never relies on it alone.
- Optional MCP server (the CLI already offers narrow JSON commands).
